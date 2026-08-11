// ---------------------------------------------------------------------------
// Obtention d'un jeton d'accès Qonto VALIDE pour un locataire donné.
//
// Rôle : concentrer en un seul endroit la question « ce jeton est-il encore
// bon, et sinon, comment le renouveler ? ». Les routes n'ont plus qu'à demander
// un jeton ; elles ne manipulent ni `expiresAt`, ni `refresh_token`.
//
// Deux chemins de renouvellement, et un seul point de vérité pour les deux :
//   - PRÉVENTIF : le jeton expire dans moins d'une minute → on rafraîchit avant
//     d'appeler Qonto (`tokenExpire` applique la marge) ;
//   - RÉACTIF : Qonto répond 401 malgré une date d'expiration valide (jeton
//     révoqué côté banque, horloge décalée) → `renouveler` force un
//     rafraîchissement, une fois, puis l'appelant réessaie.
//
// PURGER EST UNE DÉCISION IRRÉVERSIBLE, PAS UNE RÉACTION D'ERREUR.
// Un refresh token supprimé ne revient pas : il faut un nouveau consentement
// OAuth du DAF. Ce module distingue donc deux familles d'échec, et une seule
// autorise la purge :
//
//   · REFUS DÉFINITIF du serveur d'autorisation (`invalid_grant`,
//     `invalid_client`, `unauthorized_client`) → le jeton est mort côté Qonto,
//     le garder ne sert à rien : on purge ;
//   · PANNE TRANSITOIRE (DNS, TLS, timeout, 502, 5xx sans corps OAuth) → le
//     jeton était peut-être parfaitement valide. On ne touche à RIEN, on rend
//     `null`, et l'appel suivant réessaiera. Dix minutes d'indisponibilité chez
//     le serveur d'autorisation ne doivent pas déconnecter définitivement tous
//     les locataires qui passaient leur marge d'expiration pendant la fenêtre.
//
// CONCURRENCE. Deux requêtes du même locataire (deux onglets, un rafraîchissement
// de page pendant une analyse lente) peuvent entrer ici en même temps avec le
// MÊME refresh token. Si le serveur les fait tourner à usage unique, l'un reçoit
// `invalid_grant` — et, sans précaution, effacerait les jetons frais que l'autre
// vient d'écrire. Deux garde-fous :
//   1. DÉDUPLICATION intra-isolat : un seul renouvellement en vol par
//      organisation ; les suivants attendent son résultat au lieu de rejouer le
//      refresh token ;
//   2. RELECTURE avant purge : si le store contient désormais autre chose que ce
//      qu'on a tenté de renouveler, un autre a gagné la course — on rend SA
//      valeur, on ne l'efface pas.
// Le point 1 ne franchit pas la frontière d'un isolat Workers ; c'est le point 2
// qui protège du cas inter-instances, et c'est pour cela qu'il existe.
// ---------------------------------------------------------------------------

import {
  OAuthError,
  refreshTokens,
  tokenExpire,
  type TokenSet,
} from "@/lib/auth/oauth-client";
import { activeProvider, type OAuthProvider } from "@/lib/auth/providers";
import type { TokenStore } from "@/lib/auth/token-store";

/**
 * Codes OAuth (RFC 6749 §5.2) qui signifient « ce jeton ne sera plus jamais
 * accepté ». Eux seuls autorisent la suppression du secret. Tout le reste —
 * `server_error`, `temporarily_unavailable`, une absence de réponse — est
 * traité comme transitoire.
 */
const REFUS_DEFINITIFS: ReadonlySet<string> = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
]);

/**
 * Renouvellements en vol, indexés par organisation. Vidé dès la résolution :
 * la table ne grossit pas et ne garde aucun secret au-delà de l'appel.
 */
const renouvellementsEnVol = new Map<string, Promise<TokenSet | null>>();

/**
 * Jeton utilisable pour `orgId`, rafraîchi si besoin, ou `null` :
 *  - aucun jeton stocké (jamais connecté, ou révoqué) ;
 *  - jeton expiré sans refresh token (purgé au passage) ;
 *  - rafraîchissement refusé définitivement (purgé au passage) ;
 *  - rafraîchissement empêché par une panne transitoire (RIEN n'est purgé, un
 *    prochain appel réessaiera).
 */
export async function jetonValide(
  store: TokenStore,
  orgId: string,
  provider: OAuthProvider = activeProvider(),
): Promise<TokenSet | null> {
  const jetons = await store.get(orgId);
  if (!jetons) return null;
  if (!tokenExpire(jetons)) return jetons;
  return renouveler(store, orgId, jetons, provider);
}

/**
 * Force un rafraîchissement et réécrit le résultat dans le stockage.
 *
 * Rend `null` quand le renouvellement n'a pas abouti. Ne purge le stockage que
 * sur un refus DÉFINITIF du serveur d'autorisation, et jamais sans avoir relu
 * le store au préalable (cf. en-tête).
 *
 * Un second appel concurrent pour la même organisation n'émet PAS un second
 * `POST` : il attend le résultat du premier.
 */
export async function renouveler(
  store: TokenStore,
  orgId: string,
  jetons: TokenSet,
  provider: OAuthProvider = activeProvider(),
): Promise<TokenSet | null> {
  if (!jetons.refreshToken) {
    // Sans refresh token, il n'y a rien à renouveler : le jeton est mort.
    await store.delete(orgId);
    return null;
  }

  const enVol = renouvellementsEnVol.get(orgId);
  if (enVol) return enVol;

  const promesse = renouvellementUnique(store, orgId, jetons, provider);
  // On mémorise la promesse AVANT tout `await` : c'est ce qui rend la
  // déduplication effective (aucun point de reprise entre le get et le set).
  renouvellementsEnVol.set(orgId, promesse);
  try {
    return await promesse;
  } finally {
    renouvellementsEnVol.delete(orgId);
  }
}

/** Le renouvellement lui-même, un seul en vol par organisation. */
async function renouvellementUnique(
  store: TokenStore,
  orgId: string,
  jetons: TokenSet,
  provider: OAuthProvider,
): Promise<TokenSet | null> {
  let neufs: TokenSet;
  try {
    neufs = await refreshTokens(provider, jetons.refreshToken as string);
  } catch (erreur) {
    return traiterEchec(store, orgId, jetons, erreur);
  }

  // Certains serveurs ne renvoient pas de nouveau refresh token au
  // renouvellement : on conserve alors l'ancien, sinon la session mourrait
  // à la première expiration suivante.
  const fusionnes: TokenSet = {
    ...neufs,
    refreshToken: neufs.refreshToken ?? jetons.refreshToken,
  };

  try {
    await store.put(orgId, fusionnes);
  } catch (erreur) {
    // Cas le plus vicieux : le serveur a ACCEPTÉ le renouvellement (l'ancien
    // refresh token est donc déjà consommé côté Qonto) mais on n'arrive pas à
    // ranger le nouveau. Ne rien purger surtout pas : l'ancien jeu est notre
    // seule chance si l'écriture repasse. On sert la requête en cours avec les
    // jetons frais et on crie dans le journal — c'est un incident d'exploitation
    // (clé de chiffrement tournée, KV indisponible), pas une erreur utilisateur.
    console.error(
      "[argentier][oauth] INCIDENT : jetons Qonto rafraîchis mais NON stockés " +
        "(le refresh token précédent est déjà consommé). Cause :",
      erreur instanceof Error ? erreur.name : "erreur inconnue",
    );
  }

  return fusionnes;
}

/**
 * Décide du sort du stockage après un échec de rafraîchissement.
 * Purge uniquement si le refus est définitif ET que personne n'a écrit entre-temps.
 */
async function traiterEchec(
  store: TokenStore,
  orgId: string,
  tentes: TokenSet,
  erreur: unknown,
): Promise<TokenSet | null> {
  const definitif = erreur instanceof OAuthError && REFUS_DEFINITIFS.has(erreur.error);

  if (!definitif) {
    // On ne journalise que le nom de l'erreur : ni jeton, ni code, ni verifier.
    console.error(
      "[argentier][oauth] Rafraîchissement du jeton Qonto impossible " +
        "(panne présumée transitoire) — les jetons sont CONSERVÉS :",
      erreur instanceof Error ? erreur.name : "erreur inconnue",
    );
    return null;
  }

  // Refus définitif. Reste à savoir si c'est bien NOTRE jeu qui a été refusé :
  // une requête concurrente a peut-être déjà rangé un jeu frais sous cette clé,
  // auquel cas c'est elle qui a gagné la course au refresh token.
  const courants = await store.get(orgId).catch(() => null);
  if (courants && !memeJeu(courants, tentes)) {
    console.warn(
      "[argentier][oauth] Refus du serveur sur un refresh token déjà remplacé " +
        "par un appel concurrent : les jetons frais sont conservés.",
    );
    return courants;
  }

  console.error(
    "[argentier][oauth] Rafraîchissement du jeton Qonto REFUSÉ définitivement " +
      "par le serveur d'autorisation :",
    erreur instanceof OAuthError ? erreur.error : "erreur inconnue",
  );
  await store.delete(orgId);
  return null;
}

/**
 * Deux jeux de jetons sont-ils le même ? Comparaison sur `accessToken` en
 * premier : un rafraîchissement en produit TOUJOURS un nouveau, alors qu'il
 * peut parfaitement réutiliser le même refresh token — comparer ce dernier
 * seul conclurait à tort « personne n'a écrit ».
 */
function memeJeu(a: TokenSet, b: TokenSet): boolean {
  return (
    a.accessToken === b.accessToken &&
    a.refreshToken === b.refreshToken &&
    a.expiresAt === b.expiresAt
  );
}
