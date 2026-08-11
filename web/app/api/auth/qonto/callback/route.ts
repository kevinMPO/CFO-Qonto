// ---------------------------------------------------------------------------
// GET /api/auth/qonto/callback — retour du serveur d'autorisation.
//
// Enchaînement, dans un ordre qui n'est pas négociable :
//   1. refus de l'utilisateur (`error`) → retour au produit, sans rien stocker ;
//   2. VÉRIFICATION DU `state` contre le cookie — protection CSRF. Un `state`
//      absent, vide ou différent = requête refusée, point final. Sans ce
//      contrôle, un tiers peut faire brancher SON compte Qonto dans la session
//      de la victime (ou l'inverse) : c'est la faille classique du flux OAuth,
//      elle se règle ici et nulle part ailleurs ;
//   3. échange du code contre des jetons (PKCE, `code_verifier` du cookie) ;
//   4. lecture de l'organisation Qonto (LECTURE SEULE) pour connaître son
//      identifiant, puis dérivation d'un identifiant de locataire opaque ;
//   5. persistance : organisation dans D1, jetons CHIFFRÉS dans le token store,
//      entrée d'audit ;
//   6. cookie de session, nettoyage des cookies temporaires, retour vers /demo.
//
// UNE SEULE CLÉ DE LOCATAIRE, ET C'EST CELLE DE LA BASE.
// Deux identifiants coexistaient : l'`orgId` DÉRIVÉ (HMAC de l'identifiant
// Qonto) sous lequel partaient les jetons et le cookie, et `organizations.id`
// sous lequel partait le journal d'audit — parce que l'upsert résout son
// conflit sur `qonto_org_id` et CONSERVE l'id interne préexistant, qui peut
// différer. Il suffisait d'une rotation d'`ARGENTIER_SESSION_SECRET`
// (opération de sécurité documentée) pour que tout locataire connu obtienne un
// dérivé neuf face à un id de base inchangé. Alors : le journal de conformité se
// scindait en deux `org_id` sans erreur, `getOrganizationById(session.orgId)`
// rendait `null` (plus de raison sociale affichée), et
// `revokeOrganization(session.orgId)` ne touchait aucune ligne — la base
// témoignant pour toujours qu'un accès n'avait jamais été révoqué.
//
// Désormais le dérivé ne sert QU'À la première insertion : la clé retenue pour
// le token store, pour le cookie et pour l'audit est celle que rend l'upsert.
// Toutes les autres surfaces (analyze, status, revoke) n'utilisent que
// `session.orgId` — donc cette même clé, partout.
//
// LA TRAÇABILITÉ NE PREND PAS LA CONNEXION EN OTAGE, MAIS L'ABSENCE DE BINDING
// SI. Deux situations que rien ne distinguait :
//   · binding D1 absent en production → `baseD1()` lève, la connexion est
//     REFUSÉE. C'est la politique fail-closed du dépôt (lib/runtime/bindings.ts) :
//     une lecture bancaire qui ne laisserait aucune trace n'est pas servie ;
//   · base présente mais en panne, ou schéma jamais appliqué → la connexion
//     ABOUTIT quand même, sous l'identifiant dérivé, et l'incident est journalisé.
//     Auparavant la moindre erreur D1 sautait au `catch` général AVANT le
//     stockage du jeton : oublier `wrangler d1 execute --file=./db/0001_init.sql`
//     rendait toute connexion impossible, avec `?qonto=erreur` pour seul
//     diagnostic. Le schéma absent est maintenant réparé et rejoué une fois par
//     `avecSchema` (cf. lib/db/tenant.ts) ; le reste est best-effort, comme il
//     l'est déjà dans revoke et analyze.
//
// Aucune donnée personnelle ne sort d'ici : les paramètres de retour ajoutés à
// l'URL sont des codes fixes (`connecte`, `refus`, `erreur`).
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";
import { exchangeCodeForTokens } from "@/lib/auth/oauth-client";
import { activeProvider } from "@/lib/auth/providers";
import {
  CHEMIN_COOKIES_OAUTH,
  NOM_COOKIE_SESSION,
  NOM_COOKIE_STATE,
  NOM_COOKIE_VERIFIER,
  deriverOrgId,
  egalTempsConstant,
  lireCookie,
  optionsCookieSession,
  optionsEffacement,
  signerSession,
} from "@/lib/auth/session";
import { getTokenStore } from "@/lib/auth/token-store";
import { appendAudit, avecSchema, upsertOrganization } from "@/lib/db/tenant";
import { getOrganizationIdentity } from "@/lib/mcp/qonto-read-client";
import { baseD1, bindingsArgentier } from "@/lib/runtime/bindings";

export const dynamic = "force-dynamic";

/** URL de retour dans le produit, sur l'origine réellement servie. */
function urlRetour(requete: Request, statut: string): string {
  const configuree = process.env.ARGENTIER_BASE_URL?.trim();
  const base = configuree || new URL(requete.url).origin;
  const url = new URL("/demo", base.replace(/\/+$/, ""));
  url.searchParams.set("qonto", statut);
  return url.toString();
}

/** Efface les deux cookies temporaires du flux, quoi qu'il arrive ensuite. */
function nettoyerCookiesTemporaires(reponse: NextResponse): NextResponse {
  const effacement = optionsEffacement(CHEMIN_COOKIES_OAUTH);
  reponse.cookies.set(NOM_COOKIE_VERIFIER, "", effacement);
  reponse.cookies.set(NOM_COOKIE_STATE, "", effacement);
  reponse.headers.set("Cache-Control", "no-store");
  return reponse;
}

export async function GET(requete: Request): Promise<Response> {
  const parametres = new URL(requete.url).searchParams;
  const entete = requete.headers.get("cookie");

  // --- 1. L'utilisateur a refusé (ou le serveur a renvoyé une erreur) -------
  const erreurOAuth = parametres.get("error");
  if (erreurOAuth) {
    // `access_denied` = refus explicite ; tout le reste est une erreur serveur.
    const statut = erreurOAuth === "access_denied" ? "refus" : "erreur";
    console.warn(`[argentier][oauth] Consentement non accordé : ${erreurOAuth}.`);
    return nettoyerCookiesTemporaires(
      NextResponse.redirect(urlRetour(requete, statut), 302),
    );
  }

  // --- 2. Protection CSRF : le `state` doit correspondre au cookie ----------
  const stateRecu = parametres.get("state") ?? "";
  const stateAttendu = lireCookie(entete, NOM_COOKIE_STATE) ?? "";
  if (!stateRecu || !stateAttendu || !egalTempsConstant(stateRecu, stateAttendu)) {
    console.error(
      "[argentier][oauth] REFUS du callback : state absent ou non concordant " +
        "(protection CSRF).",
    );
    return nettoyerCookiesTemporaires(
      NextResponse.json(
        {
          error: "state_invalide",
          message:
            "Retour de connexion refusé : le jeton anti-CSRF est absent ou ne " +
            "correspond pas. Relance la connexion depuis Argentier.",
        },
        { status: 400 },
      ),
    );
  }

  const code = parametres.get("code") ?? "";
  const codeVerifier = lireCookie(entete, NOM_COOKIE_VERIFIER) ?? "";
  if (!code || !codeVerifier) {
    return nettoyerCookiesTemporaires(
      NextResponse.json(
        {
          error: "callback_incomplet",
          message:
            "Retour de connexion incomplet (code d'autorisation ou preuve PKCE " +
            "manquants). Relance la connexion depuis Argentier.",
        },
        { status: 400 },
      ),
    );
  }

  try {
    // --- 3. Échange code → jetons (client public + PKCE) --------------------
    const provider = activeProvider();
    const jetons = await exchangeCodeForTokens(provider, { code, codeVerifier });

    // --- 4. Qui vient de se connecter ? (lecture seule) ---------------------
    const identite = await getOrganizationIdentity({
      accessToken: jetons.accessToken,
    });
    const orgId = await deriverOrgId(identite.qontoOrgId);

    // --- 5. Persistance -----------------------------------------------------
    const maintenant = Date.now();
    const bindings = bindingsArgentier();
    const db = baseD1(bindings);

    // Clé de locataire retenue pour TOUTE la suite. L'identifiant dérivé n'est
    // qu'une valeur d'amorçage : la base a le dernier mot dès qu'elle répond.
    let cleLocataire = orgId;

    if (db) {
      try {
        const organisation = await avecSchema(db, () =>
          upsertOrganization(db, orgId, {
            qontoOrgId: identite.qontoOrgId,
            legalName: identite.name,
            createdAt: maintenant,
            // `connected_at` EST la génération de session : c'est la même valeur
            // que celle signée dans le cookie plus bas, et c'est ce qui périme
            // d'un coup tous les cookies émis avant cette reconnexion.
            connectedAt: maintenant,
            // Une reconnexion lève une révocation antérieure.
            revokedAt: null,
          }),
        );
        cleLocataire = organisation.id;
      } catch (erreur) {
        // Repli sur le dérivé : la connexion aboutit, la traçabilité manque, et
        // ça se voit dans le journal du Worker.
        console.error(
          "[argentier][oauth] Organisation non persistée (base indisponible) : la " +
            "connexion se poursuit sous l'identifiant dérivé. Cause :",
          erreur instanceof Error ? `${erreur.name} — ${erreur.message}` : "erreur inconnue",
        );
      }

      try {
        await avecSchema(db, () =>
          appendAudit(db, cleLocataire, {
            actor: "user",
            action: "oauth.connect",
            outcome: "ok",
            at: maintenant,
          }),
        );
      } catch (erreur) {
        console.error(
          "[argentier][oauth] Journalisation de la connexion échouée :",
          erreur instanceof Error ? `${erreur.name} — ${erreur.message}` : "erreur inconnue",
        );
      }
    }

    // Jetons, cookie et audit sont indexés sur la MÊME clé — celle de la base
    // quand la base a répondu, le dérivé sinon.
    await getTokenStore(bindings).put(cleLocataire, jetons);

    // --- 6. Session + nettoyage --------------------------------------------
    const reponse = nettoyerCookiesTemporaires(
      NextResponse.redirect(urlRetour(requete, "connecte"), 302),
    );
    reponse.cookies.set(
      NOM_COOKIE_SESSION,
      // Même `maintenant` que `connected_at` : le cookie est de la génération
      // courante, `lireSession` l'accepte, et lui seul.
      await signerSession(cleLocataire, maintenant),
      optionsCookieSession(),
    );
    return reponse;
  } catch (erreur) {
    // Ni le code, ni le jeton, ni le verifier ne doivent apparaître ici.
    console.error(
      "[argentier][oauth] Échec du callback :",
      erreur instanceof Error ? `${erreur.name} — ${erreur.message}` : "erreur inconnue",
    );
    return nettoyerCookiesTemporaires(
      NextResponse.redirect(urlRetour(requete, "erreur"), 302),
    );
  }
}
