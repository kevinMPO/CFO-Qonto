// ---------------------------------------------------------------------------
// Tests du chiffrement des secrets OAuth (lib/auth/crypto.ts).
//
// Ce que ces tests protègent, dans l'ordre d'importance :
//  1. l'intégrité — un blob altéré d'UN SEUL BIT doit être rejeté ;
//  2. l'IV aléatoire — deux chiffrements du même clair ne se ressemblent pas ;
//  3. l'absence de repli en clair — sans clé, on lève, on n'improvise pas.
// Si l'un d'eux devient rouge, on ne « contourne » pas : on répare.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decryptJson, encryptJson, generateKeyBase64 } from "@/lib/auth/crypto";
import { depuisBase64, versBase64 } from "@/lib/encodage";

/** Valeur d'origine de la variable, restaurée après chaque cas. */
const CLE_INITIALE = process.env.ARGENTIER_TOKEN_KEY;

/** Clair de référence : la forme d'un TokenSet, sans en dépendre. */
const CLAIR = {
  accessToken: "at_secret_1234567890",
  refreshToken: "rt_secret_0987654321",
  expiresAt: 1_800_000_000_000,
  scope: "organization.read",
  tokenType: "Bearer",
};

// Les conversions viennent de la PRODUCTION (`lib/encodage.ts`) : les tests
// manipulent le blob au bit près, mais avec le MÊME codec que le code testé.

/** base64 → octets. */
function octetsDe(base64: string): Uint8Array {
  return depuisBase64(base64, "Fixture de test invalide");
}

/** octets → base64. */
const base64De = versBase64;

beforeEach(() => {
  process.env.ARGENTIER_TOKEN_KEY = generateKeyBase64();
});

afterEach(() => {
  if (CLE_INITIALE === undefined) delete process.env.ARGENTIER_TOKEN_KEY;
  else process.env.ARGENTIER_TOKEN_KEY = CLE_INITIALE;
});

describe("encryptJson / decryptJson", () => {
  it("fait l'aller-retour sans perte", async () => {
    const blob = await encryptJson(CLAIR);
    const relu = await decryptJson<typeof CLAIR>(blob);

    expect(relu).toEqual(CLAIR);
  });

  it("ne laisse aucun secret lisible dans le blob", async () => {
    const blob = await encryptJson(CLAIR);

    expect(blob).not.toContain(CLAIR.accessToken);
    expect(blob).not.toContain(CLAIR.refreshToken);
    expect(blob).not.toContain("accessToken");
  });

  it("produit deux ciphertexts DIFFÉRENTS pour le même clair (IV aléatoire)", async () => {
    const premier = await encryptJson(CLAIR);
    const second = await encryptJson(CLAIR);

    expect(premier).not.toBe(second);
    // Les 12 premiers octets sont l'IV : c'est bien lui qui doit changer.
    expect(octetsDe(premier).subarray(0, 12)).not.toEqual(
      octetsDe(second).subarray(0, 12),
    );
    // …et les deux se déchiffrent quand même sur le même clair.
    await expect(decryptJson(premier)).resolves.toEqual(CLAIR);
    await expect(decryptJson(second)).resolves.toEqual(CLAIR);
  });

  it("gère les valeurs JSON non triviales (accents, imbrication, null)", async () => {
    const valeur = {
      libelle: "Frais de change — août, 12 € prélevés",
      imbrique: { liste: [1, 2, 3], vide: null },
    };

    await expect(decryptJson(await encryptJson(valeur))).resolves.toEqual(valeur);
  });
});

describe("intégrité AES-GCM", () => {
  it("REFUSE un blob altéré d'un seul bit dans le ciphertext", async () => {
    const octets = octetsDe(await encryptJson(CLAIR));
    // Dernier octet = tag d'authentification : un bit inversé doit suffire.
    octets[octets.length - 1] ^= 0b0000_0001;

    await expect(decryptJson(base64De(octets))).rejects.toThrow(
      /Déchiffrement impossible/,
    );
  });

  it("REFUSE un blob dont seul l'IV a été modifié", async () => {
    const octets = octetsDe(await encryptJson(CLAIR));
    octets[0] ^= 0b0000_0001;

    await expect(decryptJson(base64De(octets))).rejects.toThrow(
      /Déchiffrement impossible/,
    );
  });

  it("REFUSE un blob chiffré avec une AUTRE clé", async () => {
    const blob = await encryptJson(CLAIR);
    process.env.ARGENTIER_TOKEN_KEY = generateKeyBase64();

    await expect(decryptJson(blob)).rejects.toThrow(/Déchiffrement impossible/);
  });

  it("REFUSE un blob tronqué (plus court que IV + tag)", async () => {
    const court = base64De(new Uint8Array(20));

    await expect(decryptJson(court)).rejects.toThrow(/tronqué/);
  });

  it("REFUSE une entrée qui n'est pas du base64", async () => {
    await expect(decryptJson("pas du base64 !!")).rejects.toThrow(
      /Blob chiffré invalide/,
    );
  });

  it("REFUSE un blob vide", async () => {
    await expect(decryptJson("")).rejects.toThrow(/vide/);
  });
});

describe("clé maîtresse ARGENTIER_TOKEN_KEY", () => {
  it("lève une erreur explicite en français si la clé est absente", async () => {
    delete process.env.ARGENTIER_TOKEN_KEY;

    await expect(encryptJson(CLAIR)).rejects.toThrow(
      /ARGENTIER_TOKEN_KEY est absente/,
    );
    await expect(decryptJson("nimporte")).rejects.toThrow(
      /ARGENTIER_TOKEN_KEY est absente/,
    );
  });

  it("lève si la clé est vide ou seulement des espaces", async () => {
    process.env.ARGENTIER_TOKEN_KEY = "   ";

    await expect(encryptJson(CLAIR)).rejects.toThrow(
      /ARGENTIER_TOKEN_KEY est absente/,
    );
  });

  it("lève si la clé n'a pas la bonne taille (AES-256 = 32 octets)", async () => {
    process.env.ARGENTIER_TOKEN_KEY = base64De(new Uint8Array(16));

    await expect(encryptJson(CLAIR)).rejects.toThrow(
      /fait 16 octet\(s\).*au lieu de 32/s,
    );
  });

  it("lève si la clé n'est pas du base64", async () => {
    process.env.ARGENTIER_TOKEN_KEY = "clé maison pas base64 ***";

    await expect(encryptJson(CLAIR)).rejects.toThrow(
      /ARGENTIER_TOKEN_KEY est invalide/,
    );
  });
});

describe("generateKeyBase64", () => {
  it("fabrique une clé de 32 octets", () => {
    expect(octetsDe(generateKeyBase64())).toHaveLength(32);
  });

  it("fabrique une clé différente à chaque appel", () => {
    const cles = new Set(Array.from({ length: 5 }, () => generateKeyBase64()));

    expect(cles.size).toBe(5);
  });

  it("produit une clé directement utilisable par encryptJson", async () => {
    process.env.ARGENTIER_TOKEN_KEY = generateKeyBase64();

    await expect(decryptJson(await encryptJson(CLAIR))).resolves.toEqual(CLAIR);
  });
});
