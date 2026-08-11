// ---------------------------------------------------------------------------
// POST /api/auth/qonto/revoke — l'utilisateur débranche son compte Qonto.
//
// Trois effets, dans cet ordre de priorité (du plus sensible au moins) :
//   1. SUPPRESSION des jetons OAuth du stockage — c'est le seul geste qui
//      retire réellement un pouvoir. Il passe en premier : si la suite échoue,
//      le secret a déjà disparu ;
//   2. horodatage de `revoked_at` sur l'organisation. Ce n'est pas que de la
//      traçabilité : c'est ce que `lireSession` relit pour refuser les cookies
//      de session émis AVANT la révocation (cf. lib/auth/session.ts). Sans lui,
//      une reconnexion ultérieure réarmerait un cookie capturé ;
//   3. effacement du cookie de session.
//
// LA RÉPONSE DIT LA VÉRITÉ, ET RIEN QUE LA VÉRITÉ. `revoked: true` n'est rendu
// que si plus aucun jeton n'est joignable pour ce navigateur. Auparavant, la
// lecture de session était avalée par un `.catch(() => null)` qui confondait
// « pas de session » (état normal) avec « impossible de vérifier la session »
// (erreur de CONFIGURATION que session.ts lève exprès quand
// ARGENTIER_SESSION_SECRET est absente ou trop courte). Sur un secret mal
// renseigné, la route sautait la suppression et répondait quand même 200
// `{revoked:true}` : le DAF croyait son accès coupé, et son jeton — porteur de
// `request_transfers.write` — vivait encore jusqu'à l'expiration du TTL, 30
// jours plus tard. Un « débranchement » qui mentait.
//
// `lireSessionSignee` et non `lireSession` : la révocation doit fonctionner
// précisément quand le cookie n'est plus de la bonne génération, et sans
// dépendre de la disponibilité de la base. Supprimer un jeton est idempotent et
// ne peut nuire à personne.
//
// IDEMPOTENT : rappeler cette route sans session, ou deux fois de suite, rend le
// même 200. Mais l'idempotence ne va pas jusqu'à prétendre au succès : si la
// suppression échoue, le cookie N'EST PAS effacé — sinon l'utilisateur perdrait
// la seule chose qui lui permet de réessayer.
//
// Note : le serveur d'autorisation de Qonto n'expose pas d'endpoint de
// révocation (RFC 7009) dans ses métadonnées — on ne peut donc que jeter le
// jeton de notre côté. Il expirera de lui-même.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";
import {
  NOM_COOKIE_SESSION,
  lireSessionSignee,
  optionsEffacement,
  type SessionArgentier,
} from "@/lib/auth/session";
import { getTokenStore } from "@/lib/auth/token-store";
import { appendAudit, avecSchema, revokeOrganization } from "@/lib/db/tenant";
import { baseD1SiPresente, bindingsArgentier } from "@/lib/runtime/bindings";
import type { Localized } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Un état de connexion ne se met jamais en cache. */
function sansCache(reponse: NextResponse): NextResponse {
  reponse.headers.set("Cache-Control", "no-store");
  return reponse;
}

/**
 * Échec de révocation. Le cookie reste en place À DESSEIN : c'est lui qui
 * permettra de réessayer. Répondre `revoked: false` est le seul message honnête.
 */
function echec(statut: number, code: string, message: Localized): NextResponse {
  return sansCache(
    NextResponse.json({ revoked: false, error: code, message }, { status: statut }),
  );
}

export async function POST(requete: Request): Promise<Response> {
  let session: SessionArgentier | null;
  try {
    session = await lireSessionSignee(requete);
  } catch (erreur) {
    // On ne sait pas QUI débranche : rien n'a pu être supprimé.
    console.error(
      "[argentier][oauth] Révocation impossible : session illisible (erreur de " +
        "configuration ?) :",
      erreur instanceof Error ? `${erreur.name} — ${erreur.message}` : "erreur inconnue",
    );
    return echec(500, "revocation_impossible", {
      fr:
        "Impossible de vérifier ta session : ton compte Qonto n'a PAS été " +
        "débranché. Réessaie ; si le problème persiste, la configuration du " +
        "serveur est en cause.",
      en:
        "Your session could not be verified: your Qonto account was NOT " +
        "disconnected. Try again; if it persists, the server configuration is " +
        "at fault.",
    });
  }

  if (session) {
    const bindings = bindingsArgentier();
    const maintenant = Date.now();

    // 1. Les secrets d'abord. Un échec ici est un échec de la révocation :
    // le jeton est peut-être encore vivant, on ne le cache pas.
    try {
      await getTokenStore(bindings).delete(session.orgId);
    } catch (erreur) {
      console.error(
        "[argentier][oauth] Suppression du jeton Qonto échouée :",
        erreur instanceof Error ? `${erreur.name} — ${erreur.message}` : "erreur inconnue",
      );
      return echec(503, "revocation_incomplete", {
        fr:
          "Le stockage des jetons est momentanément indisponible : ton compte " +
          "Qonto n'a PAS été débranché. Réessaie dans un instant.",
        en:
          "Token storage is momentarily unavailable: your Qonto account was NOT " +
          "disconnected. Try again shortly.",
      });
    }

    // 2. Horodatage + journal. Le jeton a déjà disparu : une base indisponible
    // ne peut plus remettre l'accès, elle ne fait que priver la révocation de
    // sa preuve écrite — et de son effet sur les cookies déjà émis.
    //
    // `baseD1SiPresente` et non `baseD1` : cette route ne lit PAS la banque, et
    // un binding absent ne doit jamais empêcher quelqu'un de débrancher son
    // compte. `baseD1()` lèverait ici APRÈS la suppression du jeton, laissant
    // l'appelant avec un 500 et un cookie intact — l'inverse de l'intention.
    const db = baseD1SiPresente(bindings);
    if (db) {
      try {
        const horodatee = await avecSchema(db, () =>
          revokeOrganization(db, session.orgId, maintenant),
        );
        if (!horodatee) {
          // Aucune ligne touchée : le locataire du cookie n'existe pas sous cet
          // id en base. Le jeton est bien supprimé, mais `revoked_at` n'est pas
          // écrit, donc les cookies antérieurs ne seront pas refusés par
          // `lireSession`. Ça ne se tait pas.
          console.error(
            "[argentier][oauth] ALERTE : révocation non horodatée — aucune " +
              "organisation ne porte l'identifiant de cette session. Clés de " +
              "locataire divergentes ? (cf. callback/route.ts)",
          );
        }
        await avecSchema(db, () =>
          appendAudit(db, session.orgId, {
            actor: "user",
            action: "oauth.revoke",
            outcome: horodatee ? "ok" : "error",
            at: maintenant,
          }),
        );
      } catch (erreur) {
        console.error("[argentier][oauth] Journalisation de la révocation échouée :", erreur);
      }
    }
  }

  // 3. Le cookie part dès lors que plus aucun jeton n'est joignable pour ce
  // navigateur — y compris quand il n'y avait pas de session du tout.
  const reponse = sansCache(NextResponse.json({ revoked: true }));
  reponse.cookies.set(NOM_COOKIE_SESSION, "", optionsEffacement("/"));
  return reponse;
}
