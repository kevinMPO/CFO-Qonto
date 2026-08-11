// ---------------------------------------------------------------------------
// Tests de `lib/auth/pkce.ts`.
// Rôle : verrouiller la conformité RFC 7636. Un challenge mal calculé, et le
// serveur d'autorisation refuse l'échange ; un verifier prévisible, et PKCE ne
// protège plus rien (le client est public, il n'y a pas de secret de repli).
// Ces tests doivent échouer bruyamment à la moindre dérive.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  CODE_CHALLENGE_METHOD,
  LONGUEUR_VERIFIER_MAX,
  LONGUEUR_VERIFIER_MIN,
  OCTETS_STATE_MIN,
  assertCodeVerifierValide,
  base64UrlEncode,
  createPkcePair,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from "@/lib/auth/pkce";

// Le décodeur vient de la PRODUCTION (`lib/encodage.ts`) : un décodeur de test
// réimplémenté à côté peut masquer un bug de l'encodeur qu'il vérifie.
import { base64UrlDecode } from "@/lib/encodage";

describe("code_challenge S256", () => {
  it("reproduit le vecteur de test de la RFC 7636 (appendice B)", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

    await expect(generateCodeChallenge(verifier)).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("produit du base64url sans padding (ni '=', ni '+', ni '/')", async () => {
    const challenge = await generateCodeChallenge(generateCodeVerifier());

    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    // SHA-256 = 32 octets → 43 caractères base64 une fois le padding retiré.
    expect(challenge).toHaveLength(43);
  });

  it("est déterministe : le même verifier donne le même challenge", async () => {
    const verifier = generateCodeVerifier();

    const [a, b] = await Promise.all([
      generateCodeChallenge(verifier),
      generateCodeChallenge(verifier),
    ]);

    expect(a).toBe(b);
  });

  it("refuse un verifier hors spec", async () => {
    await expect(generateCodeChallenge("trop-court")).rejects.toThrow(
      /RFC 7636/,
    );
    await expect(generateCodeChallenge("a".repeat(129))).rejects.toThrow(
      /RFC 7636/,
    );
    // 43 caractères, mais '+' et '/' sont réservés.
    await expect(generateCodeChallenge(`${"a".repeat(41)}+/`)).rejects.toThrow(
      /non réservés/,
    );
  });

  it("annonce S256 comme unique méthode", () => {
    expect(CODE_CHALLENGE_METHOD).toBe("S256");
  });
});

describe("code_verifier", () => {
  it("respecte la longueur et l'alphabet non réservé de la RFC 7636", () => {
    const verifier = generateCodeVerifier();

    expect(verifier.length).toBeGreaterThanOrEqual(LONGUEUR_VERIFIER_MIN);
    expect(verifier.length).toBeLessThanOrEqual(LONGUEUR_VERIFIER_MAX);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(() => assertCodeVerifierValide(verifier)).not.toThrow();
  });

  it("honore une longueur explicite dans les bornes légales", () => {
    expect(generateCodeVerifier(LONGUEUR_VERIFIER_MIN)).toHaveLength(43);
    expect(generateCodeVerifier(LONGUEUR_VERIFIER_MAX)).toHaveLength(128);
  });

  it("rejette une longueur hors bornes", () => {
    expect(() => generateCodeVerifier(42)).toThrow(/RFC 7636/);
    expect(() => generateCodeVerifier(129)).toThrow(/RFC 7636/);
  });

  it("produit un verifier différent à chaque appel", () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();

    expect(a).not.toBe(b);
  });

  it("ne se répète pas sur 200 tirages (pas de générateur figé)", () => {
    const tirages = new Set(
      Array.from({ length: 200 }, () => generateCodeVerifier()),
    );

    expect(tirages.size).toBe(200);
  });

  it("couvre largement l'alphabet — signe d'un tirage non biaisé", () => {
    // 50 verifiers de 128 caractères = 6400 tirages : les 66 caractères de
    // l'alphabet doivent tous sortir. Un modulo biaisé ou un alphabet tronqué
    // se verrait immédiatement ici.
    const vus = new Set<string>();
    for (let i = 0; i < 50; i++) {
      for (const caractere of generateCodeVerifier(LONGUEUR_VERIFIER_MAX)) {
        vus.add(caractere);
      }
    }

    expect(vus.size).toBe(66);
  });
});

describe("createPkcePair", () => {
  it("renvoie un couple cohérent verifier / challenge S256", async () => {
    const paire = await createPkcePair();

    expect(paire.codeChallengeMethod).toBe("S256");
    await expect(generateCodeChallenge(paire.codeVerifier)).resolves.toBe(
      paire.codeChallenge,
    );
  });
});

describe("state anti-CSRF", () => {
  it("porte au moins 16 octets d'entropie", () => {
    const state = generateState();

    expect(base64UrlDecode(state).length).toBeGreaterThanOrEqual(
      OCTETS_STATE_MIN,
    );
    // Le défaut vise 32 octets (256 bits).
    expect(base64UrlDecode(state).length).toBe(32);
  });

  it("est en base64url sans padding", () => {
    expect(generateState()).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("diffère à chaque appel", () => {
    const tirages = new Set(Array.from({ length: 100 }, () => generateState()));

    expect(tirages.size).toBe(100);
  });

  it("refuse une entropie sous le seuil de 16 octets", () => {
    expect(() => generateState(8)).toThrow(/entropie/i);
    expect(() => generateState(OCTETS_STATE_MIN)).not.toThrow();
  });
});

describe("base64UrlEncode", () => {
  it("encode sans padding et avec l'alphabet URL-safe", () => {
    // 0xFF 0xFE 0xFD → "//79" en base64 standard → "__79" en base64url.
    expect(base64UrlEncode(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe("__79");
    // Un octet seul produit 2 caractères + 2 '=' en base64 : ils doivent sauter.
    expect(base64UrlEncode(new Uint8Array([0x00]))).toBe("AA");
  });

  it("accepte un ArrayBuffer aussi bien qu'un Uint8Array", () => {
    const vue = new Uint8Array([1, 2, 3]);

    expect(base64UrlEncode(vue.buffer)).toBe(base64UrlEncode(vue));
  });
});
