// ---------------------------------------------------------------------------
// Chiffrement authentifié des secrets OAuth (AES-GCM 256).
//
// Rôle : rendre illisible tout token Qonto au repos. Un token OAuth Qonto porte
// aujourd'hui des droits d'ÉCRITURE que le serveur d'autorisation refuse de
// restreindre (cf. décision d'architecture) : le stockage en clair est donc
// exclu, y compris dans un KV privé.
//
// Trois choix non négociables :
//  1. WebCrypto UNIQUEMENT (`globalThis.crypto.subtle`) — le runtime cible est
//     Cloudflare Workers, `node:crypto` n'y a pas sa place.
//  2. AES-GCM = chiffrement AUTHENTIFIÉ : un blob altéré d'un seul bit est
//     rejeté au déchiffrement (tag d'intégrité), il n'est jamais « réparé ».
//  3. IV aléatoire de 12 octets RÉGÉNÉRÉ à chaque chiffrement. Réutiliser un IV
//     avec la même clé casse AES-GCM ; l'IV est préfixé au ciphertext.
//
// Format du blob : base64( IV[12] || ciphertext+tag ).
//
// La clé vient de `ARGENTIER_TOKEN_KEY` (base64, 32 octets). Si elle manque ou
// est mal dimensionnée, on lève au PREMIER usage : jamais de repli silencieux
// en clair.
// ---------------------------------------------------------------------------

import {
  depuisBase64,
  octetsVersTexte,
  texteVersOctets,
  versBase64,
} from "@/lib/encodage";

/** Nom de la variable d'environnement portant la clé maîtresse. */
const VARIABLE_CLE = "ARGENTIER_TOKEN_KEY";

/** Taille de clé AES-256, en octets. */
const OCTETS_CLE = 32;

/** Taille d'IV recommandée pour AES-GCM, en octets. */
const OCTETS_IV = 12;

/** Taille du tag d'authentification GCM, en octets (128 bits). */
const OCTETS_TAG = 16;

/**
 * Cache de la CryptoKey importée, indexé par la clé base64 source.
 * On mémorise la source pour qu'une rotation de `ARGENTIER_TOKEN_KEY` (ou un
 * test qui change la variable) reparte bien d'une importation neuve.
 */
let cleImportee: { source: string; cle: CryptoKey } | null = null;

// Conversions octets ↔ base64 et UTF-8 : `lib/encodage.ts`, source unique du
// dépôt. Rien n'est réimplémenté ici.

/** Accès à WebCrypto, avec un message clair si le runtime ne le fournit pas. */
function sousSysteme(): SubtleCrypto {
  const disponible = globalThis.crypto?.subtle;
  if (!disponible) {
    throw new Error(
      "WebCrypto (crypto.subtle) est indisponible dans ce runtime : impossible " +
        "de chiffrer les tokens OAuth.",
    );
  }
  return disponible;
}

/**
 * Fabrique une clé maîtresse neuve, à coller dans `ARGENTIER_TOKEN_KEY`.
 * Destinée à l'exploitant (`node -e`, script de déploiement) — jamais appelée
 * par le code applicatif, qui doit échouer plutôt que d'improviser une clé.
 */
export function generateKeyBase64(): string {
  const octets = new Uint8Array(OCTETS_CLE);
  globalThis.crypto.getRandomValues(octets);
  return versBase64(octets);
}

/**
 * Lit `ARGENTIER_TOKEN_KEY` et importe la CryptoKey AES-GCM correspondante.
 * Lève en français si la variable est absente, vide, non base64, ou si elle ne
 * fait pas exactement 32 octets.
 */
async function chargerCle(): Promise<CryptoKey> {
  const source = process.env[VARIABLE_CLE]?.trim();

  if (!source) {
    throw new Error(
      `${VARIABLE_CLE} est absente : impossible de chiffrer les tokens OAuth. ` +
        "Génère une clé avec generateKeyBase64() (32 octets en base64) et " +
        "place-la dans l'environnement. Aucun stockage en clair n'est autorisé.",
    );
  }

  if (cleImportee && cleImportee.source === source) return cleImportee.cle;

  const octets = depuisBase64(source, `${VARIABLE_CLE} est invalide`);
  if (octets.length !== OCTETS_CLE) {
    throw new Error(
      `${VARIABLE_CLE} fait ${octets.length} octet(s) une fois décodée au lieu ` +
        `de ${OCTETS_CLE} : AES-256 exige exactement ${OCTETS_CLE} octets. ` +
        "Régénère-la avec generateKeyBase64().",
    );
  }

  const cle = await sousSysteme().importKey(
    "raw",
    octets as unknown as BufferSource,
    { name: "AES-GCM" },
    false, // non exportable : la clé ne doit jamais ressortir du runtime.
    ["encrypt", "decrypt"],
  );

  cleImportee = { source, cle };
  return cle;
}

/**
 * Chiffre une valeur JSON-sérialisable et renvoie le blob base64
 * `IV || ciphertext+tag`. Deux appels sur le même clair produisent deux blobs
 * différents : l'IV est retiré à chaque fois.
 */
export async function encryptJson<T>(value: T): Promise<string> {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new Error(
      "Valeur non sérialisable en JSON : rien à chiffrer (undefined, fonction " +
        "ou symbole).",
    );
  }

  const cle = await chargerCle();

  const iv = new Uint8Array(OCTETS_IV);
  globalThis.crypto.getRandomValues(iv);

  const chiffre = new Uint8Array(
    await sousSysteme().encrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      cle,
      texteVersOctets(json) as unknown as BufferSource,
    ),
  );

  const blob = new Uint8Array(iv.length + chiffre.length);
  blob.set(iv, 0);
  blob.set(chiffre, iv.length);
  return versBase64(blob);
}

/**
 * Déchiffre un blob produit par `encryptJson`. Toute altération (un seul bit
 * suffit), troncature ou clé différente fait échouer l'authentification GCM :
 * on lève, on ne renvoie jamais de contenu partiel.
 */
export async function decryptJson<T>(blob: string): Promise<T> {
  if (typeof blob !== "string" || blob.length === 0) {
    throw new Error("Blob chiffré vide : rien à déchiffrer.");
  }

  const cle = await chargerCle();
  const octets = depuisBase64(blob, "Blob chiffré invalide");

  if (octets.length < OCTETS_IV + OCTETS_TAG) {
    throw new Error(
      `Blob chiffré tronqué : ${octets.length} octet(s), il en faut au moins ` +
        `${OCTETS_IV + OCTETS_TAG} (IV + tag d'authentification).`,
    );
  }

  const iv = octets.subarray(0, OCTETS_IV);
  const chiffre = octets.subarray(OCTETS_IV);

  let clair: ArrayBuffer;
  try {
    clair = await sousSysteme().decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      cle,
      chiffre as unknown as BufferSource,
    );
  } catch {
    throw new Error(
      "Déchiffrement impossible : le blob est altéré, tronqué ou chiffré avec " +
        `une autre clé (authentification AES-GCM refusée). Vérifie ${VARIABLE_CLE}.`,
    );
  }

  try {
    return JSON.parse(octetsVersTexte(new Uint8Array(clair))) as T;
  } catch {
    throw new Error(
      "Blob déchiffré illisible : le contenu n'est pas du JSON valide.",
    );
  }
}
