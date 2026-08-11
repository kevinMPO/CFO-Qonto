// ---------------------------------------------------------------------------
// POST/GET /api/analyze — orchestration (PRD §15, étape 3) :
//   Source Qonto (lecture seule) → catégorisation (Claude) → engine.ts → JSON.
//
// DEUX sources, et une frontière nette entre les deux :
//   1. VISITEUR CONNECTÉ (cookie de session) → son compte, via la session OAuth
//      et `lib/mcp/qonto-read-client` (jeton Bearer, rafraîchi tout seul, toute
//      requête filtrée par l'allowlist read-only). Si son jeton est
//      indisponible, la réponse est un 401 « reconnecte ton compte » — JAMAIS
//      les données d'un autre, JAMAIS un chiffre de démonstration badgé « live ».
//   2. VISITEUR ANONYME (aucun cookie) → démo (`lib/mock.ts`). C'est ce qui fait
//      vivre /demo sans la moindre clé.
//
// Ce qui a DISPARU, et ne doit pas revenir : le repli n°2 historique sur la clé
// API statique « login:secret_key » du fondateur (`lib/qonto.ts`, supprimé).
// Une seule clé pour tous les visiteurs, dotée de droits d'écriture, et une
// sortie réseau vers Qonto qui ne traversait jamais `assertReadOnly` : un
// visiteur dont le jeton s'évaporait se voyait servir le compte bancaire réel du
// fondateur, badgé « live ». L'invariant « aucun `fetch` Qonto hors garde » est
// désormais vérifié à l'échelle du dépôt (lib/mcp/__tests__/invariant-fetch-qonto.test.ts).
//
// Aucune action bancaire n'est déclenchée. Tout euro vient d'engine.ts, et la
// forme de la réponse JSON est identique quelle que soit la source.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";
import { MOCK } from "@/lib/mock";
import { build, toMerchantInputs } from "@/lib/engine";
import {
  categorizeByRules,
  categorizeWithClaude,
  hasAnthropicKey,
  type MerchantInput,
} from "@/lib/categorize";
import { jetonValide, renouveler } from "@/lib/auth/access";
import { lireSession } from "@/lib/auth/session";
import { getTokenStore, type TokenStore } from "@/lib/auth/token-store";
import type { TokenSet } from "@/lib/auth/oauth-client";
import { appendAudit, type D1Database } from "@/lib/db/tenant";
import { ReadOnlyViolationError } from "@/lib/mcp/readonly-guard";
import {
  TokenExpiredError,
  getOrganization as getOrganizationOAuth,
  listTransactions as listTransactionsOAuth,
  type QontoAuth,
} from "@/lib/mcp/qonto-read-client";
import { BindingManquantError, baseD1, bindingsArgentier } from "@/lib/runtime/bindings";
import type { Localized, MerchantVerdict, Tx } from "@/lib/types";

export const dynamic = "force-dynamic";

function windowLabel(days: number): Localized {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86_400_000);
  const fmt = (d: Date, locale: string) =>
    d.toLocaleDateString(locale, { day: "numeric", month: "long" });
  return {
    fr: `${fmt(start, "fr-FR")} – ${fmt(end, "fr-FR")} ${end.getFullYear()}`,
    en: `${fmt(start, "en-US")} – ${fmt(end, "en-US")}, ${end.getFullYear()}`,
  };
}

/** OBSERVE terminé → CATÉGORISE (Claude) → CALCULE (engine.ts). */
async function runPipeline(
  account: { name: string; bank: string; balance: number },
  txs: Tx[],
  windowDays: number,
) {
  const months = Math.max(1, windowDays / 30);
  const inputs: MerchantInput[] = toMerchantInputs(
    txs.filter((t) => t.side === "debit"),
    months,
  );

  let verdicts: MerchantVerdict[];
  let categorized: "claude" | "rules" = "rules";
  if (hasAnthropicKey() && inputs.length > 0) {
    try {
      verdicts = await categorizeWithClaude(inputs);
      categorized = "claude";
    } catch (err) {
      console.error("Catégorisation Claude échouée, fallback règles :", err);
      verdicts = categorizeByRules(inputs);
    }
  } else {
    verdicts = categorizeByRules(inputs);
  }

  return build({
    account,
    windowLabel: windowLabel(windowDays),
    txs,
    verdicts,
    windowDays,
    source: "qonto",
    categorized,
  });
}

// --- Réponses --------------------------------------------------------------

/** Charge de DÉMONSTRATION, toujours badgée `source: "mock"`. */
function donneesDemo() {
  return { ...MOCK, meta: { ...MOCK.meta!, source: "mock" as const } };
}

/**
 * Une réponse d'analyse ne se met JAMAIS en cache et varie selon le cookie :
 * elle transporte le nom de l'organisation, le solde et 60 jours de
 * transactions du locataire, sur une méthode GET par défaut cacheable. Sans ces
 * en-têtes, un cache partagé en aval (CDN, proxy d'entreprise) peut servir la
 * réponse du locataire A au locataire B — `force-dynamic` ne protège que le
 * cache de route de Next, pas celui d'un intermédiaire HTTP.
 */
function sansCache(reponse: NextResponse): NextResponse {
  reponse.headers.set("Cache-Control", "private, no-store, max-age=0");
  reponse.headers.set("Vary", "Cookie");
  return reponse;
}

/**
 * Refus explicite, en français, adressé à un visiteur CONNECTÉ dont on ne peut
 * pas honnêtement lire le compte.
 *
 * Le corps reprend la charge de démonstration — badgée `source: "mock"`, donc
 * affichée « démo » par le front — uniquement pour que les clients existants
 * gardent une réponse de forme valide. La vérité machine, ce sont le STATUT
 * (jamais 2xx) et le champ `error`. Ce qui compte : ce corps ne contient les
 * données bancaires de personne.
 */
function refus(statut: number, code: string, message: Localized): NextResponse {
  return sansCache(
    NextResponse.json({ ...donneesDemo(), error: code, message }, { status: statut }),
  );
}

const RECONNEXION_REQUISE = refus.bind(null, 401, "qonto_reconnexion_requise", {
  fr:
    "Ta connexion Qonto n'est plus valide (jeton expiré, révoqué ou introuvable). " +
    "Reconnecte ton compte pour relancer l'analyse.",
  en:
    "Your Qonto connection is no longer valid (token expired, revoked or missing). " +
    "Reconnect your account to run the analysis again.",
});

// --- Source 1 : session OAuth ----------------------------------------------

/** Tout ce qu'une lecture Qonto authentifiée par jeton a besoin de connaître. */
interface ContexteLecture {
  store: TokenStore;
  orgId: string;
  /**
   * Base D1. `null` UNIQUEMENT en développement ou en test : en production,
   * `baseD1()` lève plutôt que de rendre `null` (une lecture bancaire non
   * traçable est refusée, pas dégradée en silence).
   */
  db: D1Database | null;
  /** Jeu de jetons courant — remplacé sur place après un rafraîchissement. */
  jetons: TokenSet;
}

/**
 * Journalise un accès Qonto dans `audit_log`. L'ÉCHEC d'écriture est
 * best-effort et silencieux : un journal indisponible ne transforme pas une
 * analyse réussie en 500. L'ABSENCE de base, elle, ne l'est plus — elle est
 * refusée en amont par `baseD1()`.
 * Le chemin est enregistré SANS query string (règle 3).
 */
async function journaliser(
  ctx: ContexteLecture,
  action: string,
  chemin: string,
  outcome: "ok" | "denied" | "error",
): Promise<void> {
  if (!ctx.db) return;
  try {
    await appendAudit(ctx.db, ctx.orgId, {
      actor: "agent",
      action,
      httpMethod: "GET",
      path: chemin,
      outcome,
      at: Date.now(),
    });
  } catch (erreur) {
    console.error("[argentier][audit] Écriture du journal impossible :", erreur);
  }
}

/**
 * Exécute une lecture Qonto, la journalise, et rejoue UNE fois après
 * rafraîchissement si la banque répond 401 (jeton révoqué ou horloge décalée
 * malgré une date d'expiration encore valide).
 */
async function lireQonto<T>(
  ctx: ContexteLecture,
  action: string,
  chemin: string,
  operation: (auth: QontoAuth) => Promise<T>,
): Promise<T> {
  try {
    let resultat: T;
    try {
      resultat = await operation({ accessToken: ctx.jetons.accessToken });
    } catch (erreur) {
      if (!(erreur instanceof TokenExpiredError)) throw erreur;
      const renouveles = await renouveler(ctx.store, ctx.orgId, ctx.jetons);
      if (!renouveles) throw erreur;
      ctx.jetons = renouveles;
      resultat = await operation({ accessToken: renouveles.accessToken });
    }
    await journaliser(ctx, action, chemin, "ok");
    return resultat;
  } catch (erreur) {
    // Un refus de l'allowlist read-only est un incident à part : il se voit
    // dans le journal sous son propre verdict.
    const issue = erreur instanceof ReadOnlyViolationError ? "denied" : "error";
    await journaliser(ctx, action, chemin, issue);
    throw erreur;
  }
}

/** Analyse le compte du visiteur connecté. L'appelant a déjà validé la session. */
async function analyzeAvecSession(
  orgId: string,
  windowDays: number,
): Promise<Awaited<ReturnType<typeof runPipeline>> | null> {
  const bindings = bindingsArgentier();
  const store = getTokenStore(bindings);
  const jetons = await jetonValide(store, orgId);
  // `null` = jeton absent, expiré sans refresh, ou rafraîchissement refusé.
  // Une seule conclusion possible : ce visiteur doit reconnecter son compte.
  if (!jetons) return null;

  const ctx: ContexteLecture = {
    store,
    orgId,
    db: baseD1(bindings),
    jetons,
  };

  // Pas d'IBAN : en multi-locataire, un IBAN de configuration n'a aucun sens.
  // Sans IBAN, le client retient le premier compte de l'organisation.
  //
  // Séquentiel et non `Promise.all` : si le jeton doit être rafraîchi, deux
  // appels concurrents consommeraient deux fois le même refresh token — et les
  // serveurs qui le font tourner à usage unique en invalideraient un.
  const org = await lireQonto(ctx, "qonto.get_organization", "/organization", (auth) =>
    getOrganizationOAuth(auth),
  );
  const txs = await lireQonto(ctx, "qonto.list_transactions", "/transactions", (auth) =>
    listTransactionsOAuth(auth, windowDays),
  );

  return runPipeline(
    { name: org.name, bank: "Qonto", balance: org.balance },
    txs,
    windowDays,
  );
}

async function analyze(requete: Request): Promise<NextResponse> {
  const windowDays = Number(process.env.ARGENTIER_WINDOW_DAYS || 60);

  const session = await lireSession(requete).catch((erreur) => {
    console.error("[argentier][session] Cookie de session illisible :", erreur);
    return null;
  });

  // Visiteur ANONYME (ou cookie illisible, donc non authentifié) : démo.
  // C'est le seul cas où l'on sert des chiffres qui ne sont pas ceux d'un
  // compte réel — et ils sont badgés comme tels.
  if (!session) return sansCache(NextResponse.json(donneesDemo()));

  // Visiteur CONNECTÉ : à partir d'ici, aucun repli n'est acceptable.
  try {
    const rapport = await analyzeAvecSession(session.orgId, windowDays);
    if (!rapport) return RECONNEXION_REQUISE();
    return sansCache(NextResponse.json(rapport));
  } catch (erreur) {
    if (erreur instanceof BindingManquantError) {
      console.error("[argentier][config] Binding indispensable absent :", erreur.message);
      return refus(503, "configuration_incomplete", {
        fr:
          "Argentier est mal configuré côté serveur : une ressource indispensable " +
          "manque. L'analyse est refusée plutôt que servie sans garantie.",
        en:
          "Argentier is misconfigured server-side: a required resource is missing. " +
          "The analysis is refused rather than served without guarantees.",
      });
    }
    // Le jeton a pu être purgé entre-temps (rafraîchissement refusé pendant la
    // lecture) : on invite à reconnecter plutôt que d'inventer une réponse.
    if (erreur instanceof TokenExpiredError) return RECONNEXION_REQUISE();

    console.error("[argentier][analyze] Lecture Qonto impossible :", erreur);
    return refus(502, "lecture_qonto_impossible", {
      fr:
        "La lecture de ton compte Qonto a échoué. Réessaie dans un instant ; " +
        "aucune donnée d'un autre compte ne t'est montrée à la place.",
      en:
        "Reading your Qonto account failed. Try again shortly; no other account's " +
        "data is shown in its place.",
    });
  }
}

export async function GET(requete: Request): Promise<NextResponse> {
  try {
    return await analyze(requete);
  } catch (err) {
    // Filet de sécurité : `analyze` traite déjà ses propres pannes. Y arriver
    // signale un bug, pas un mode de fonctionnement — on le dit, on ne badge
    // surtout pas de la démo en « live ».
    console.error("[argentier][analyze] Échec inattendu :", err);
    return refus(500, "erreur_interne", {
      fr: "Erreur interne d'Argentier. Rien n'a été lu, rien n'a été écrit.",
      en: "Internal Argentier error. Nothing was read, nothing was written.",
    });
  }
}

export const POST = GET;
