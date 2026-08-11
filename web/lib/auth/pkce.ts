// ---------------------------------------------------------------------------
// PKCE (RFC 7636) et anti-CSRF pour le flux OAuth 2.1 d'Argentier.
//
// Rôle : fabriquer le `code_verifier`, son `code_challenge` en S256, et le
// `state`. Le serveur d'autorisation de Qonto n'accepte QUE `S256` et n'a pas
// de `client_secret` (client public) : PKCE est donc la seule preuve que le
// client qui échange le code est bien celui qui l'a demandé. Un verifier
// faible, c'est un compte bancaire exposé — d'où l'échantillonnage sans biais.
//
// Contrainte d'exécution : le code tourne sur Cloudflare Workers. On utilise
// EXCLUSIVEMENT la WebCrypto globale (`crypto.getRandomValues`,
// `crypto.subtle.digest`). `node:crypto` est interdit ici.
// ---------------------------------------------------------------------------

import { base64UrlEncode, texteVersOctets } from "@/lib/encodage";

/**
 * Encodage base64url sans padding — l'implémentation vit dans
 * `lib/encodage.ts` (source unique du dépôt). Réexporté ici parce que le flux
 * OAuth l'a toujours importé depuis ce module : la surface publique de `pkce`
 * ne change pas.
 */
export { base64UrlEncode };

/**
 * Alphabet des caractères « unreserved » autorisés dans un `code_verifier`
 * (RFC 7636 §4.1) : ALPHA / DIGIT / "-" / "." / "_" / "~". 66 caractères.
 */
const ALPHABET_VERIFIER =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/** Longueurs légales d'un `code_verifier` (RFC 7636 §4.1). */
export const LONGUEUR_VERIFIER_MIN = 43;
export const LONGUEUR_VERIFIER_MAX = 128;

/** Longueur par défaut : confortablement au-dessus du minimum réglementaire. */
const LONGUEUR_VERIFIER_DEFAUT = 64;

/** Entropie par défaut du `state`, en octets (256 bits). */
const OCTETS_STATE_DEFAUT = 32;

/** Entropie minimale acceptée pour un `state`, en octets. */
export const OCTETS_STATE_MIN = 16;

/** Récupère la WebCrypto globale, ou échoue avec un message explicite. */
function webcrypto(): Crypto {
  const c = globalThis.crypto;
  if (!c?.getRandomValues || !c?.subtle) {
    throw new Error(
      "WebCrypto indisponible : PKCE exige crypto.getRandomValues et " +
        "crypto.subtle (runtime Cloudflare Workers ou Node 18+).",
    );
  }
  return c;
}

/**
 * Tire `longueur` caractères dans l'alphabet PKCE, sans biais de modulo.
 * Les octets >= au plus grand multiple de 66 inférieur à 256 sont rejetés,
 * sinon les premiers caractères de l'alphabet seraient sur-représentés.
 */
function tirageSansBiais(longueur: number): string {
  const c = webcrypto();
  const taille = ALPHABET_VERIFIER.length; // 66
  const plafond = Math.floor(256 / taille) * taille; // 198
  let sortie = "";

  while (sortie.length < longueur) {
    // On tire un peu large pour limiter le nombre d'allers-retours.
    const brut = new Uint8Array(longueur - sortie.length + 16);
    c.getRandomValues(brut);
    for (let i = 0; i < brut.length && sortie.length < longueur; i++) {
      const octet = brut[i];
      if (octet >= plafond) continue; // rejet : garde la distribution uniforme
      sortie += ALPHABET_VERIFIER[octet % taille];
    }
  }

  return sortie;
}

/**
 * Génère un `code_verifier` conforme RFC 7636 : 43 à 128 caractères tirés
 * uniformément dans l'alphabet non réservé.
 */
export function generateCodeVerifier(
  longueur: number = LONGUEUR_VERIFIER_DEFAUT,
): string {
  if (
    !Number.isInteger(longueur) ||
    longueur < LONGUEUR_VERIFIER_MIN ||
    longueur > LONGUEUR_VERIFIER_MAX
  ) {
    throw new Error(
      `Longueur de code_verifier invalide (${longueur}) : la RFC 7636 impose ` +
        `un entier entre ${LONGUEUR_VERIFIER_MIN} et ${LONGUEUR_VERIFIER_MAX}.`,
    );
  }
  return tirageSansBiais(longueur);
}

/**
 * Calcule le `code_challenge` S256 d'un verifier :
 * BASE64URL(SHA-256(ASCII(code_verifier))), sans padding.
 */
export async function generateCodeChallenge(
  codeVerifier: string,
): Promise<string> {
  assertCodeVerifierValide(codeVerifier);
  const c = webcrypto();
  const octets = texteVersOctets(codeVerifier);
  const empreinte = await c.subtle.digest("SHA-256", octets);
  return base64UrlEncode(empreinte);
}

/** Méthode de challenge : le serveur d'autorisation n'accepte que S256. */
export const CODE_CHALLENGE_METHOD = "S256" as const;

/** Un couple PKCE prêt à l'emploi. */
export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: typeof CODE_CHALLENGE_METHOD;
}

/** Génère un couple verifier / challenge S256 complet. */
export async function createPkcePair(
  longueur: number = LONGUEUR_VERIFIER_DEFAUT,
): Promise<PkcePair> {
  const codeVerifier = generateCodeVerifier(longueur);
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: CODE_CHALLENGE_METHOD,
  };
}

/**
 * Génère un `state` anti-CSRF : `octets` octets aléatoires en base64url.
 * Défaut 32 octets (256 bits), minimum accepté 16 octets.
 */
export function generateState(octets: number = OCTETS_STATE_DEFAUT): string {
  if (!Number.isInteger(octets) || octets < OCTETS_STATE_MIN) {
    throw new Error(
      `Entropie de state insuffisante (${octets} octets) : minimum ` +
        `${OCTETS_STATE_MIN} octets pour résister au CSRF.`,
    );
  }
  const brut = new Uint8Array(octets);
  webcrypto().getRandomValues(brut);
  return base64UrlEncode(brut);
}

/** Rejette tout verifier hors spec (longueur ou caractères réservés). */
export function assertCodeVerifierValide(codeVerifier: string): void {
  if (
    typeof codeVerifier !== "string" ||
    codeVerifier.length < LONGUEUR_VERIFIER_MIN ||
    codeVerifier.length > LONGUEUR_VERIFIER_MAX
  ) {
    throw new Error(
      `code_verifier invalide : la RFC 7636 impose entre ` +
        `${LONGUEUR_VERIFIER_MIN} et ${LONGUEUR_VERIFIER_MAX} caractères.`,
    );
  }
  if (!/^[A-Za-z0-9\-._~]+$/.test(codeVerifier)) {
    throw new Error(
      "code_verifier invalide : seuls les caractères non réservés " +
        "(A-Z a-z 0-9 - . _ ~) sont autorisés (RFC 7636 §4.1).",
    );
  }
}
