// ---------------------------------------------------------------------------
// Tests de l'accès aux bindings Cloudflare (lib/runtime/bindings.ts).
//
// L'enjeu n'est pas la lecture d'un symbole global, c'est la POLITIQUE DE
// DÉFAILLANCE : que se passe-t-il quand un binding manque ? Avant correctif, la
// réponse était « rien, on continue » — d'où des jetons bancaires en clair et
// une lecture Qonto qui ne laissait aucune trace, sur la cible réellement
// déployée. Désormais : rien en développement, refus explicite en production.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BindingManquantError,
  NOM_ECHAPPATOIRE,
  baseD1,
  baseD1SiPresente,
  bindingsArgentier,
  estBaseD1,
  estKvNamespace,
  modeDegradeAutorise,
} from "@/lib/runtime/bindings";

/** Double minimal de D1 : seule la forme compte pour le contrôle structurel. */
const FAUSSE_D1 = { prepare: () => ({}) };

/** Double minimal de KVNamespace. */
const FAUX_KV = {
  get: async () => null,
  put: async () => {},
  delete: async () => {},
};

const SYMBOLE_CONTEXTE = Symbol.for("__cloudflare-context__");

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as Record<symbol, unknown>)[SYMBOLE_CONTEXTE];
});

describe("modeDegradeAutorise", () => {
  it("autorise le mode dégradé en développement et en test", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(modeDegradeAutorise()).toBe(true);

    vi.stubEnv("NODE_ENV", "test");
    expect(modeDegradeAutorise()).toBe(true);
  });

  it("l'interdit en production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(modeDegradeAutorise()).toBe(false);
  });

  it("ne le rouvre en production que sur échappatoire explicite", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(NOM_ECHAPPATOIRE, "1");
    expect(modeDegradeAutorise()).toBe(true);
  });
});

describe("contrôles de forme", () => {
  it("reconnaît un D1 à sa méthode prepare", () => {
    expect(estBaseD1(FAUSSE_D1)).toBe(true);
    expect(estBaseD1({})).toBe(false);
    expect(estBaseD1(null)).toBe(false);
    expect(estBaseD1("ARGENTIER_DB")).toBe(false);
  });

  it("reconnaît un KVNamespace à son triplet get/put/delete", () => {
    expect(estKvNamespace(FAUX_KV)).toBe(true);
    // Un binding incomplet n'est pas « à moitié bon » : il est refusé.
    expect(estKvNamespace({ get: async () => null })).toBe(false);
    expect(estKvNamespace({ get: "pas une fonction", put: () => {}, delete: () => {} })).toBe(
      false,
    );
    expect(estKvNamespace(undefined)).toBe(false);
  });
});

describe("bindingsArgentier", () => {
  it("rend un objet même hors Cloudflare, jamais undefined", () => {
    expect(bindingsArgentier()).toEqual({
      ARGENTIER_TOKENS: undefined,
      ARGENTIER_DB: undefined,
    });
  });

  it("lit le contexte posé par l'entrypoint OpenNext", () => {
    (globalThis as Record<symbol, unknown>)[SYMBOLE_CONTEXTE] = {
      env: { ARGENTIER_DB: FAUSSE_D1, ARGENTIER_TOKENS: FAUX_KV },
    };

    const bindings = bindingsArgentier();
    expect(bindings.ARGENTIER_DB).toBe(FAUSSE_D1);
    expect(bindings.ARGENTIER_TOKENS).toBe(FAUX_KV);
  });
});

describe("baseD1", () => {
  it("rend la base quand le binding est là", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(baseD1({ ARGENTIER_DB: FAUSSE_D1 })).toBe(FAUSSE_D1);
  });

  it("rend null sans binding en développement", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(baseD1({})).toBeNull();
  });

  it("LÈVE sans binding en production : une lecture bancaire non traçable est refusée", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(() => baseD1({})).toThrow(BindingManquantError);
    expect(() => baseD1({})).toThrow(/ARGENTIER_DB/);
    expect(() => baseD1({})).toThrow(/journal d'audit/);
  });

  it("LÈVE aussi sur un binding D1 malformé en production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => baseD1({ ARGENTIER_DB: { requete: () => {} } })).toThrow(
      BindingManquantError,
    );
  });

  it("baseD1SiPresente ne lève jamais : c'est la variante de diagnostic", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(baseD1SiPresente({})).toBeNull();
    expect(baseD1SiPresente({ ARGENTIER_DB: FAUSSE_D1 })).toBe(FAUSSE_D1);
  });
});
