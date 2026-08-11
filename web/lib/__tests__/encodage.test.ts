// ---------------------------------------------------------------------------
// Tests de `lib/encodage.ts` — le codec octets ↔ base64 / base64url / UTF-8.
//
// Deux choses à protéger :
//  1. la CORRECTION du codec : il porte la charge utile du cookie de session,
//     le `state` anti-CSRF, le `code_challenge` PKCE et le blob AES-GCM des
//     jetons bancaires. Un padding mal reconstitué, et une session légitime est
//     refusée — ou pire, une valeur tronquée est acceptée ;
//  2. son UNICITÉ : ce module est la seule implémentation autorisée du dépôt.
//     Le test « aucun autre module n'appelle atob/btoa » échoue dès qu'une
//     cinquième copie de la boucle `String.fromCharCode` réapparaît.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  base64UrlDecode,
  base64UrlEncode,
  base64UrlVersTexte,
  depuisBase64,
  octetsVersTexte,
  texteVersOctets,
  versBase64,
} from "@/lib/encodage";

/** Racine du paquet `web/`, pour le scan d'unicité. */
const RACINE = fileURLToPath(new URL("../..", import.meta.url));

describe("base64 standard", () => {
  it("fait l'aller-retour sur des octets arbitraires, y compris 0x00 et 0xFF", () => {
    const octets = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xfe, 0xff]);

    expect(depuisBase64(versBase64(octets), "aller-retour")).toEqual(octets);
  });

  it("reproduit les vecteurs de la RFC 4648 §10", () => {
    expect(versBase64(texteVersOctets("f"))).toBe("Zg==");
    expect(versBase64(texteVersOctets("fo"))).toBe("Zm8=");
    expect(versBase64(texteVersOctets("foo"))).toBe("Zm9v");
    expect(versBase64(texteVersOctets("foobar"))).toBe("Zm9vYmFy");
  });

  it("accepte un ArrayBuffer aussi bien qu'un Uint8Array", () => {
    const vue = new Uint8Array([1, 2, 3]);

    expect(versBase64(vue.buffer)).toBe(versBase64(vue));
  });

  it("rend une chaîne vide pour zéro octet", () => {
    expect(versBase64(new Uint8Array(0))).toBe("");
    expect(depuisBase64("", "vide")).toEqual(new Uint8Array(0));
  });

  it("LÈVE, avec le contexte fourni, sur une entrée qui n'est pas du base64", () => {
    expect(() => depuisBase64("pas du base64 !!", "Blob chiffré invalide")).toThrow(
      /^Blob chiffré invalide : la valeur n'est pas du base64 valide\.$/,
    );
  });

  it("ne tronque pas silencieusement un gros contenu (1 024 octets)", () => {
    const octets = new Uint8Array(1024);
    for (let i = 0; i < octets.length; i += 1) octets[i] = i % 256;

    expect(depuisBase64(versBase64(octets), "gros contenu")).toEqual(octets);
  });
});

describe("base64url", () => {
  it("encode sans padding et avec l'alphabet URL-safe", () => {
    // 0xFF 0xFE 0xFD → "//79" en base64 standard → "__79" en base64url.
    expect(base64UrlEncode(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe("__79");
    // Un octet seul produit 2 caractères + 2 '=' en base64 : ils doivent sauter.
    expect(base64UrlEncode(new Uint8Array([0x00]))).toBe("AA");
  });

  it("ne laisse jamais sortir '+', '/' ni '=' sur 256 octets couvrant l'octet entier", () => {
    const octets = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) octets[i] = i;

    expect(base64UrlEncode(octets)).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("décode ce qu'il encode, pour les trois restes de longueur modulo 3", () => {
    for (const taille of [1, 2, 3, 4, 5, 31, 32, 33]) {
      const octets = new Uint8Array(taille);
      for (let i = 0; i < taille; i += 1) octets[i] = (i * 37 + 11) % 256;

      expect(base64UrlDecode(base64UrlEncode(octets)), `taille ${taille}`).toEqual(
        octets,
      );
    }
  });

  it("accepte indifféremment une entrée padée ou non padée", () => {
    // "Zg==" ↔ "Zg" : le padding est reconstitué avant décodage.
    expect(octetsVersTexte(base64UrlDecode("Zg"))).toBe("f");
    expect(octetsVersTexte(base64UrlDecode("Zg=="))).toBe("f");
    expect(octetsVersTexte(base64UrlDecode("Zm8"))).toBe("fo");
  });

  it("LÈVE sur un base64url invalide, avec un contexte par défaut en français", () => {
    expect(() => base64UrlDecode("@@@@")).toThrow(
      /^Valeur base64url invalide : la valeur n'est pas du base64 valide\.$/,
    );
  });

  it("rend `null` — jamais une exception — via base64UrlVersTexte", () => {
    expect(base64UrlVersTexte("@@@@")).toBeNull();
    expect(base64UrlVersTexte(base64UrlEncode(texteVersOctets("ça passe")))).toBe(
      "ça passe",
    );
  });
});

describe("UTF-8", () => {
  it("fait l'aller-retour sur des accents et des caractères hors BMP", () => {
    const texte = "Économie prouvée — 1 234 € · 🇫🇷";

    expect(octetsVersTexte(texteVersOctets(texte))).toBe(texte);
    expect(base64UrlVersTexte(base64UrlEncode(texteVersOctets(texte)))).toBe(texte);
  });
});

describe("unicité du codec dans le dépôt", () => {
  /** Tous les .ts / .tsx de `lib/` et `app/`, artefacts de build exclus. */
  function sources(dossier: string, acc: string[] = []): string[] {
    for (const entree of readdirSync(dossier, { withFileTypes: true })) {
      const chemin = join(dossier, entree.name);
      if (entree.isDirectory()) {
        if (["node_modules", ".next", ".open-next", ".vercel"].includes(entree.name)) {
          continue;
        }
        sources(chemin, acc);
      } else if (/\.tsx?$/.test(entree.name)) {
        acc.push(chemin);
      }
    }
    return acc;
  }

  const fichiers = [
    ...sources(join(RACINE, "lib")),
    ...sources(join(RACINE, "app")),
  ].filter((chemin) => !chemin.endsWith(join("lib", "encodage.ts")));

  it("trouve bien les sources à scanner (garde-fou du scanner lui-même)", () => {
    expect(fichiers.length).toBeGreaterThan(20);
  });

  it("n'appelle atob/btoa NULLE PART ailleurs que dans lib/encodage.ts", () => {
    const coupables = fichiers.filter((chemin) =>
      /\b(atob|btoa)\s*\(/.test(readFileSync(chemin, "utf8")),
    );

    expect(
      coupables.map((c) => c.slice(RACINE.length)),
      "conversion base64 réimplémentée hors lib/encodage.ts — importe-la",
    ).toEqual([]);
  });

  it("n'instancie TextEncoder/TextDecoder que dans lib/encodage.ts", () => {
    const coupables = fichiers.filter((chemin) =>
      /new\s+Text(Encoder|Decoder)\s*\(/.test(readFileSync(chemin, "utf8")),
    );

    expect(
      coupables.map((c) => c.slice(RACINE.length)),
      "encodeur UTF-8 réinstancié hors lib/encodage.ts — importe texteVersOctets/octetsVersTexte",
    ).toEqual([]);
  });
});
