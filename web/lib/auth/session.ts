// ---------------------------------------------------------------------------
// Session Argentier — cookie signé (HMAC-SHA256, WebCrypto).
//
// Rôle : dire « cette requête appartient à l'organisation X », et rien d'autre.
// Le cookie ne transporte QUE l'identifiant interne opaque du locataire et sa
// date d'émission. Aucune PII : ni raison sociale, ni IBAN, ni identifiant
// Qonto, ni jeton d'accès. Les jetons OAuth vivent chiffrés dans le token store
// (cf. `token-store.ts`) ; le cookie n'est qu'un pointeur vers eux.
//
// Signé, pas chiffré : le contenu est public (un identifiant opaque), mais il
// doit être IMPOSSIBLE à forger — sinon n'importe qui lirait le compte
// bancaire d'un autre en changeant un caractère. D'où :
//   - HMAC-SHA256 sur `v1.<charge utile>` avec `ARGENTIER_SESSION_SECRET` ;
//   - comparaison à temps constant de la signature ;
//   - date d'émission vérifiée (une session expirée est refusée même signée).
//
// UN COOKIE SIGNÉ NE SUFFIT PAS : il faut pouvoir le TUER côté serveur.
// Une signature valide et une date fraîche ne disent rien de la révocation. Or
// `deriverOrgId` est volontairement DÉTERMINISTE : après un « débranchement »
// puis une reconnexion, la même organisation retrouve la même clé de locataire
// et des jetons frais sont rangés dessous. Un cookie capturé avant la
// révocation (profil de navigateur emprunté, export HAR, log de proxy) serait
// alors REDEVENU pleinement valide — la révocation ne couperait rien de
// durable. D'où une GÉNÉRATION de session, et deux fonctions distinctes :
//
//   - `lireSessionSignee` : signature + âge. Le strict minimum, hors ligne. Elle
//     sert à la RÉVOCATION, qui doit rester possible même avec un cookie périmé
//     (et même quand la base est en panne) ;
//   - `lireSession` : signature + âge + GÉNÉRATION, confrontée à l'état du
//     locataire en base. C'est celle que doivent appeler les surfaces qui
//     LISENT la banque.
//
// La génération n'est pas un champ de plus dans le cookie : c'est sa date
// d'émission (`t`), comparée à deux colonnes que la base porte déjà —
// `organizations.connected_at` (dernier consentement) et
// `organizations.revoked_at` (débranchement). Un cookie émis AVANT le dernier
// consentement, ou pendant une période révoquée, est refusé. Réutiliser ces
// deux colonnes plutôt qu'ajouter un compteur évite un `ALTER TABLE` non
// idempotent sur une migration déjà appliquée en distant, pour exactement la
// même propriété : la révocation est monotone, donc la date d'émission suffit
// à ordonner les générations.
//
// Sens de la vérification, à ne pas inverser : l'état en base ne peut que
// RETIRER un accès, jamais en accorder un. Pas de ligne d'organisation (base
// non provisionnée, schéma jamais appliqué) = rien n'a jamais été révoqué = le
// cookie garde sa valeur, et c'est le token store qui reste seul juge. Un
// binding D1 absent en production, lui, est refusé plus loin, sur le chemin de
// lecture (`baseD1()` lève) : une lecture bancaire non journalisée n'est pas
// servie.
//
// Contrainte d'exécution : Cloudflare Workers → WebCrypto uniquement, jamais
// `node:crypto`. Le module ne dépend pas de Next.js : il manipule des chaînes,
// ce qui le rend testable et réutilisable côté Worker comme côté route.
// ---------------------------------------------------------------------------

import { estTableManquante, getOrganizationById } from "@/lib/db/tenant";
import {
  base64UrlEncode,
  base64UrlVersTexte,
  texteVersOctets,
} from "@/lib/encodage";
import { baseD1SiPresente, bindingsArgentier } from "@/lib/runtime/bindings";

/** Nom du cookie de session. */
export const NOM_COOKIE_SESSION = "argentier_session";

/** Nom du cookie temporaire portant le `code_verifier` PKCE. */
export const NOM_COOKIE_VERIFIER = "argentier_oauth_verifier";

/** Nom du cookie temporaire portant le `state` anti-CSRF. */
export const NOM_COOKIE_STATE = "argentier_oauth_state";

/**
 * Chemin des cookies temporaires du flux OAuth : ils ne sont envoyés qu'aux
 * routes `/api/auth/qonto/*`, et nulle part ailleurs sur le site.
 */
export const CHEMIN_COOKIES_OAUTH = "/api/auth/qonto";

/** Durée de vie d'une session, en secondes (30 jours). */
export const DUREE_SESSION_SECONDES = 60 * 60 * 24 * 30;

/**
 * Durée de vie des cookies temporaires du flux OAuth, en secondes.
 * 10 minutes : le temps d'un consentement, pas davantage.
 */
export const DUREE_COOKIES_OAUTH_SECONDES = 600;

/** Variable d'environnement portant le secret de signature. */
const VARIABLE_SECRET = "ARGENTIER_SESSION_SECRET";

/** Version du format, préfixée au jeton : permet une rotation de format. */
const VERSION = "v1";

/** Session valide, telle que la lisent les routes. */
export interface SessionArgentier {
  /** Identifiant interne opaque du locataire (jamais l'identifiant Qonto). */
  orgId: string;
  /** Date d'émission, epoch millisecondes. */
  emisA: number;
}

/** Charge utile sérialisée dans le cookie. Clés courtes : le cookie reste petit. */
interface ChargeUtile {
  o: string;
  t: number;
}

/** Options d'un cookie, telles que les attend `NextResponse.cookies.set`. */
export interface OptionsCookie {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
}

/** Cache de la clé HMAC importée, indexé sur le secret source (cf. crypto.ts). */
let cleImportee: { source: string; cle: CryptoKey } | null = null;

/**
 * Cookie `Secure` sauf en développement local en clair : Chrome et Firefox
 * acceptent `Secure` sur `http://localhost`, mais pas sur un `http://` distant
 * (tunnel de test, IP de LAN). On se cale donc sur `ARGENTIER_BASE_URL`.
 */
function cookieSecurise(): boolean {
  const base = process.env.ARGENTIER_BASE_URL?.trim() ?? "";
  if (!base) return true;
  return !base.startsWith("http://");
}

/** Charge la clé HMAC. Lève en français si le secret manque ou est trop court. */
async function chargerCle(): Promise<CryptoKey> {
  const source = process.env[VARIABLE_SECRET]?.trim();
  if (!source) {
    throw new Error(
      `${VARIABLE_SECRET} est absente : impossible de signer la session. ` +
        "Génère une valeur aléatoire d'au moins 32 caractères et place-la dans " +
        "l'environnement. Aucune session non signée n'est acceptée.",
    );
  }
  if (source.length < 32) {
    throw new Error(
      `${VARIABLE_SECRET} fait ${source.length} caractère(s) : 32 au minimum. ` +
        "Un secret court se force hors ligne, et forger une session, c'est " +
        "lire le compte bancaire d'un tiers.",
    );
  }

  if (cleImportee && cleImportee.source === source) return cleImportee.cle;

  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      "WebCrypto (crypto.subtle) est indisponible dans ce runtime : impossible " +
        "de signer la session.",
    );
  }

  const cle = await subtle.importKey(
    "raw",
    texteVersOctets(source) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false, // non exportable : le secret ne ressort pas du runtime.
    ["sign"],
  );

  cleImportee = { source, cle };
  return cle;
}

/** Signature base64url d'un message, avec la clé de session. */
async function signer(message: string): Promise<string> {
  const cle = await chargerCle();
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    cle,
    texteVersOctets(message) as unknown as BufferSource,
  );
  return base64UrlEncode(signature);
}

/**
 * Comparaison à temps constant SUR LE CONTENU. Un `===` sur une signature fuit,
 * par son temps de réponse, le nombre de caractères corrects : de quoi la
 * reconstituer octet par octet. Ici, la boucle parcourt toujours la chaîne
 * entière, quel que soit le premier caractère qui diffère.
 *
 * Ce qui FUIT volontairement : la LONGUEUR. Le court-circuit initial rend
 * `false` sans rien comparer quand les longueurs diffèrent. C'est la pratique
 * standard, et elle est sans conséquence ici : la longueur d'une signature
 * HMAC-SHA256 base64url est une constante publique du format, et celle d'un
 * `state` est fixée par `pkce.ts`. Un attaquant n'apprend donc rien qu'il ne
 * sache déjà. Ne pas lire ce court-circuit comme un oubli.
 *
 * Exportée : la vérification du `state` anti-CSRF au callback s'en sert aussi.
 */
export function egalTempsConstant(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

/**
 * Fabrique la valeur du cookie de session pour un locataire.
 * Format : `v1.<charge utile base64url>.<HMAC base64url>`.
 *
 * `maintenant` n'est pas qu'un horodatage d'expiration : c'est la GÉNÉRATION de
 * la session (cf. en-tête). L'appelant qui émet un cookie DOIT écrire la même
 * valeur dans `organizations.connected_at`, sinon il émet un cookie que
 * `lireSession` refusera aussitôt comme antérieur au dernier consentement.
 */
export async function signerSession(
  orgId: string,
  maintenant: number = Date.now(),
): Promise<string> {
  const propre = typeof orgId === "string" ? orgId.trim() : "";
  if (!propre) {
    throw new Error("orgId vide : impossible d'émettre une session sans locataire.");
  }

  const charge: ChargeUtile = { o: propre, t: maintenant };
  const encodee = base64UrlEncode(texteVersOctets(JSON.stringify(charge)));
  const message = `${VERSION}.${encodee}`;
  return `${message}.${await signer(message)}`;
}

/**
 * Vérifie la SIGNATURE et l'ÂGE d'une valeur de cookie, et rend la session, ou
 * `null`. Rend `null` — jamais une exception — pour toute valeur absente, mal
 * formée, mal signée ou expirée : côté appelant, « pas de session » est un état
 * normal. Seule une erreur de CONFIGURATION (secret absent) lève, et elle doit
 * lever.
 *
 * Ne vérifie PAS la génération : cette fonction est hors ligne, elle ne connaît
 * pas l'état du locataire. Une surface qui va LIRE la banque doit passer par
 * `lireSession`, pas par celle-ci.
 */
export async function verifierSession(
  valeur: string | null | undefined,
  maintenant: number = Date.now(),
): Promise<SessionArgentier | null> {
  if (typeof valeur !== "string" || valeur === "") return null;

  const morceaux = valeur.split(".");
  if (morceaux.length !== 3) return null;
  const [version, encodee, signature] = morceaux;
  if (version !== VERSION || !encodee || !signature) return null;

  const attendue = await signer(`${version}.${encodee}`);
  if (!egalTempsConstant(signature, attendue)) return null;

  const json = base64UrlVersTexte(encodee);
  if (json === null) return null;

  let charge: ChargeUtile;
  try {
    charge = JSON.parse(json) as ChargeUtile;
  } catch {
    return null;
  }

  const orgId = typeof charge?.o === "string" ? charge.o.trim() : "";
  const emisA = typeof charge?.t === "number" ? charge.t : NaN;
  if (!orgId || !Number.isFinite(emisA)) return null;

  // Une session dont l'horodatage est dans le futur est aussi suspecte qu'une
  // session expirée : on refuse les deux.
  const ageSecondes = (maintenant - emisA) / 1000;
  if (ageSecondes < -60 || ageSecondes > DUREE_SESSION_SECONDES) return null;

  return { orgId, emisA };
}

/**
 * Extrait un cookie d'un en-tête `Cookie` brut.
 * Écrit à la main : `next/headers` n'existe pas hors d'une requête Next.js, et
 * ce module doit rester utilisable partout (Worker, test).
 */
export function lireCookie(enteteCookie: string | null | undefined, nom: string): string | null {
  if (!enteteCookie) return null;
  for (const morceau of enteteCookie.split(";")) {
    const separateur = morceau.indexOf("=");
    if (separateur === -1) continue;
    if (morceau.slice(0, separateur).trim() !== nom) continue;
    const brut = morceau.slice(separateur + 1).trim();
    try {
      return decodeURIComponent(brut);
    } catch {
      return brut;
    }
  }
  return null;
}

/**
 * Lit la session SIGNÉE portée par une requête : signature et âge, rien de plus.
 * `null` si la requête n'en porte pas.
 *
 * Réservée aux surfaces qui ne lisent PAS la banque et pour lesquelles une
 * génération périmée ne change rien :
 *  - la RÉVOCATION, qui doit fonctionner précisément quand le cookie est
 *    périmé, et sans dépendre de la disponibilité de la base ;
 *  - le diagnostic.
 * Toute autre surface doit appeler `lireSession`.
 */
export async function lireSessionSignee(
  requete: { headers: { get(nom: string): string | null } },
  maintenant: number = Date.now(),
): Promise<SessionArgentier | null> {
  const brut = lireCookie(requete.headers.get("cookie"), NOM_COOKIE_SESSION);
  if (!brut) return null;
  return verifierSession(brut, maintenant);
}

/**
 * État de révocation d'un locataire, tel qu'il sert à ordonner les générations.
 * Deux colonnes de `organizations`, et pas une de plus.
 */
export interface EtatLocataire {
  /** Dernier consentement OAuth accordé (epoch ms), `null` si jamais connecté. */
  connectedAt: number | null;
  /** Débranchement horodaté (epoch ms), `null` tant que l'accès est actif. */
  revokedAt: number | null;
}

/**
 * La session est-elle encore de la génération courante du locataire ?
 *
 * Pure et exportée : c'est LA règle de révocation, elle doit pouvoir être lue
 * et testée sans base. Deux refus, dans cet ordre :
 *
 *  1. ORGANISATION RÉVOQUÉE — `revoked_at` est postérieur (ou égal) au dernier
 *     consentement : l'accès a été retiré et n'a pas été rétabli. Aucune
 *     session n'est acceptée, même fraîchement signée. C'est ici, et nulle part
 *     ailleurs, que `revoked_at` est enfin CONSULTÉ ;
 *  2. GÉNÉRATION PÉRIMÉE — le cookie a été émis avant le dernier consentement.
 *     C'est le cas du cookie capturé puis « réarmé » par une reconnexion : il
 *     porte la bonne clé de locataire, une signature valide, une date dans les
 *     30 jours… et une génération d'avant. Refusé.
 *
 * `etat === null` (organisation inconnue de la base, ou base absente) ne refuse
 * RIEN : l'état en base ne peut que retirer un accès, jamais en accorder un
 * (cf. en-tête).
 */
export function sessionEncoreValide(
  session: SessionArgentier,
  etat: EtatLocataire | null,
): boolean {
  if (!etat) return true;

  const revoquee =
    etat.revokedAt !== null &&
    (etat.connectedAt === null || etat.revokedAt >= etat.connectedAt);
  if (revoquee) return false;

  if (etat.connectedAt !== null && session.emisA < etat.connectedAt) return false;

  return true;
}

/**
 * État du locataire en base, ou `null` quand il n'y a rien à confronter.
 *
 * `baseD1SiPresente` et non `baseD1` : le refus fail-closed d'un binding D1
 * absent en production appartient au chemin de LECTURE bancaire
 * (`app/api/analyze`), qui appelle `baseD1()` et répond 503. Le dupliquer ici
 * transformerait ce 503 explicite en « visiteur anonyme », donc en démo — un
 * mensonge plus discret que la panne qu'il masque.
 *
 * Une table absente (schéma jamais appliqué) est traitée comme une organisation
 * inconnue : aucune révocation n'a jamais pu y être écrite, donc il n'y a rien
 * à opposer au cookie. Toute AUTRE erreur de base remonte : un contrôle de
 * sécurité qui échoue ne se conclut pas par « c'est bon ».
 */
async function etatLocataire(orgId: string): Promise<EtatLocataire | null> {
  const db = baseD1SiPresente(bindingsArgentier());
  if (!db) return null;

  try {
    const organisation = await getOrganizationById(db, orgId);
    if (!organisation) return null;
    return {
      connectedAt: organisation.connectedAt,
      revokedAt: organisation.revokedAt,
    };
  } catch (erreur) {
    if (estTableManquante(erreur)) {
      console.error(
        "[argentier][session] Schéma multi-locataire absent : la génération de " +
          "session n'a pu être vérifiée. Applique db/0001_init.sql.",
      );
      return null;
    }
    throw erreur;
  }
}

/**
 * Lit, vérifie et VALIDE la session portée par une requête : signature, âge, et
 * génération confrontée à l'état du locataire. `null` si non connectée, si le
 * cookie est antérieur au dernier consentement, ou si l'accès est révoqué.
 *
 * C'est la fonction que doit appeler toute surface qui s'apprête à lire des
 * données bancaires.
 */
export async function lireSession(
  requete: { headers: { get(nom: string): string | null } },
  maintenant: number = Date.now(),
): Promise<SessionArgentier | null> {
  const session = await lireSessionSignee(requete, maintenant);
  if (!session) return null;

  const etat = await etatLocataire(session.orgId);
  if (!sessionEncoreValide(session, etat)) {
    // Aucun identifiant dans le log : le motif suffit au diagnostic.
    console.warn(
      "[argentier][session] Session refusée : accès révoqué, ou cookie émis " +
        "avant le dernier consentement (génération périmée).",
    );
    return null;
  }

  return session;
}

/** Options du cookie de session (30 jours, httpOnly, SameSite=Lax). */
export function optionsCookieSession(): OptionsCookie {
  return {
    httpOnly: true,
    secure: cookieSecurise(),
    // Lax : le cookie doit survivre au retour de redirection depuis Qonto.
    sameSite: "lax",
    path: "/",
    maxAge: DUREE_SESSION_SECONDES,
  };
}

/** Options d'un cookie temporaire du flux OAuth (verifier, state). */
export function optionsCookieOAuth(): OptionsCookie {
  return {
    httpOnly: true,
    secure: cookieSecurise(),
    sameSite: "lax",
    path: CHEMIN_COOKIES_OAUTH,
    maxAge: DUREE_COOKIES_OAUTH_SECONDES,
  };
}

/** Options d'effacement : même portée, durée nulle. */
export function optionsEffacement(chemin: string): OptionsCookie {
  return {
    httpOnly: true,
    secure: cookieSecurise(),
    sameSite: "lax",
    path: chemin,
    maxAge: 0,
  };
}

/**
 * Dérive l'identifiant interne de locataire à partir de l'identifiant Qonto.
 *
 * Trois propriétés voulues :
 *  - OPAQUE : c'est un HMAC, il ne laisse pas remonter au compte Qonto, ce qui
 *    permet de le mettre dans un cookie sans y mettre de donnée identifiante ;
 *  - STABLE : la même organisation retrouve le même identifiant à chaque
 *    reconnexion, donc ses décisions déjà enregistrées ne deviennent pas
 *    orphelines, même quand D1 n'est pas provisionné ;
 *  - DÉTERMINISTE sans base : c'est cet identifiant qui sert de clé au token
 *    store, y compris en développement sans binding.
 */
export async function deriverOrgId(qontoOrgId: string): Promise<string> {
  const propre = typeof qontoOrgId === "string" ? qontoOrgId.trim() : "";
  if (!propre) {
    throw new Error(
      "Identifiant d'organisation Qonto vide : impossible de dériver un locataire.",
    );
  }
  const empreinte = await signer(`org:${propre}`);
  // 32 caractères base64url ≈ 192 bits : aucune collision réaliste.
  return `org_${empreinte.slice(0, 32)}`;
}
