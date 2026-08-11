// ---------------------------------------------------------------------------
// Encodage d'octets : base64, base64url, UTF-8. Source UNIQUE du dépôt.
//
// Rôle : porter UNE seule implémentation de la conversion octets ↔ texte,
// partagée par le chiffrement des jetons (`lib/auth/crypto.ts`), PKCE
// (`lib/auth/pkce.ts`) et la signature de session (`lib/auth/session.ts`).
//
// Pourquoi ce module existe : la même boucle `String.fromCharCode` /
// `charCodeAt` était recopiée dans quatre fichiers, avec deux gestions de
// padding différentes — dont celle d'un test, qui pouvait donc masquer un bug
// de l'encodeur qu'il était censé vérifier. Un correctif de padding ne doit se
// faire qu'à un seul endroit : ici.
//
// Contrainte d'exécution : Cloudflare Workers. `btoa`, `atob`, `TextEncoder` et
// `TextDecoder` y sont natifs ; `Buffer` et `node:crypto` sont interdits.
// ---------------------------------------------------------------------------

/** Encodeur/décodeur UTF-8 réutilisés (une allocation par module, pas par appel). */
const encodeurUtf8 = new TextEncoder();
const decodeurUtf8 = new TextDecoder();

/**
 * Texte → octets UTF-8.
 * Le type de retour est précisé (`Uint8Array<ArrayBuffer>`, jamais un buffer
 * partagé) pour que le résultat parte directement dans WebCrypto, qui n'accepte
 * pas un `SharedArrayBuffer`.
 */
export function texteVersOctets(texte: string): Uint8Array<ArrayBuffer> {
  return encodeurUtf8.encode(texte);
}

/** Octets UTF-8 → texte (une séquence invalide donne U+FFFD, elle ne lève pas). */
export function octetsVersTexte(octets: Uint8Array): string {
  return decodeurUtf8.decode(octets);
}

/** Normalise une source binaire en vue d'octets, sans recopier un Uint8Array. */
function vueOctets(source: Uint8Array | ArrayBuffer): Uint8Array {
  return source instanceof Uint8Array ? source : new Uint8Array(source);
}

/** Octets → base64 standard, avec padding (`btoa` existe dans les Workers). */
export function versBase64(source: Uint8Array | ArrayBuffer): string {
  const octets = vueOctets(source);
  let binaire = "";
  for (let i = 0; i < octets.length; i += 1) {
    binaire += String.fromCharCode(octets[i]);
  }
  return btoa(binaire);
}

/**
 * base64 standard → octets. Lève une erreur explicite, préfixée par `contexte`,
 * si l'entrée n'est pas du base64 valide : on ne décode jamais « à peu près ».
 */
export function depuisBase64(base64: string, contexte: string): Uint8Array {
  let binaire: string;
  try {
    binaire = atob(base64);
  } catch {
    throw new Error(`${contexte} : la valeur n'est pas du base64 valide.`);
  }
  const octets = new Uint8Array(binaire.length);
  for (let i = 0; i < binaire.length; i += 1) octets[i] = binaire.charCodeAt(i);
  return octets;
}

/** Octets → base64url SANS padding (RFC 4648 §5). */
export function base64UrlEncode(source: Uint8Array | ArrayBuffer): string {
  return versBase64(source)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * base64url → octets. Le padding est facultatif à l'entrée : il est reconstitué
 * avant décodage. Lève si l'encodage est invalide.
 */
export function base64UrlDecode(
  valeur: string,
  contexte: string = "Valeur base64url invalide",
): Uint8Array {
  const base64 = valeur.replace(/-/g, "+").replace(/_/g, "/");
  const rembourre = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return depuisBase64(rembourre, contexte);
}

/**
 * base64url → texte UTF-8, ou `null` si l'encodage est invalide.
 * Variante sans exception, pour les chemins où « valeur illisible » est un état
 * normal (un cookie forgé, par exemple) et non une panne.
 */
export function base64UrlVersTexte(valeur: string): string | null {
  try {
    return octetsVersTexte(base64UrlDecode(valeur));
  } catch {
    return null;
  }
}
