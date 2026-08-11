// ---------------------------------------------------------------------------
// Tests du stockage des tokens OAuth (lib/auth/token-store.ts).
//
// Trois exigences y sont vérifiées au-delà du CRUD :
//  1. ce qui part dans KV est CHIFFRÉ — jamais un token en clair ;
//  2. `delete()` révoque vraiment, et se rappelle sans exploser (idempotence) ;
//  3. HORS DÉVELOPPEMENT, l'absence de binding KV LÈVE. C'est le correctif de la
//     faille de fond : tant que `getTokenStore()` se contentait d'un
//     `console.warn` avant de retomber en mémoire, toute la couche AES-GCM était
//     du code mort sur la cible déployée, et des jetons bancaires porteurs de
//     `request_transfers.write` vivaient en clair dans le tas, sans TTL, avec une
//     révocation qui ne portait que sur l'instance ayant répondu.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateKeyBase64 } from "@/lib/auth/crypto";
import { BindingManquantError, NOM_ECHAPPATOIRE } from "@/lib/runtime/bindings";
import {
  DUREE_REFRESH_SECONDES,
  KvTokenStore,
  MemoryTokenStore,
  __resetTokenStoreForTests,
  getTokenStore,
  ttlSeconds,
  type KvNamespaceLike,
} from "@/lib/auth/token-store";
import type { TokenSet } from "@/lib/auth/oauth-client";

const CLE_INITIALE = process.env.ARGENTIER_TOKEN_KEY;

const ORG = "org_123";

/** TokenSet de référence (valeurs bidon, aucun secret réel). */
function tokens(surcharge: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "at_secret_1234567890",
    refreshToken: "rt_secret_0987654321",
    expiresAt: Date.now() + 3_600_000,
    scope: "organization.read",
    tokenType: "Bearer",
    ...surcharge,
  };
}

/** Faux KVNamespace : mémorise valeur ET TTL, pour pouvoir les inspecter. */
class FauxKv implements KvNamespaceLike {
  readonly entrees = new Map<string, { valeur: string; ttl?: number }>();
  suppressions = 0;

  async get(key: string): Promise<string | null> {
    return this.entrees.get(key)?.valeur ?? null;
  }

  async put(
    key: string,
    valeur: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    this.entrees.set(key, { valeur, ttl: options?.expirationTtl });
  }

  async delete(key: string): Promise<void> {
    this.suppressions += 1;
    this.entrees.delete(key);
  }
}

beforeEach(() => {
  process.env.ARGENTIER_TOKEN_KEY = generateKeyBase64();
  __resetTokenStoreForTests();
});

afterEach(() => {
  if (CLE_INITIALE === undefined) delete process.env.ARGENTIER_TOKEN_KEY;
  else process.env.ARGENTIER_TOKEN_KEY = CLE_INITIALE;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("MemoryTokenStore", () => {
  it("fait le cycle complet put → get → delete", async () => {
    const store = new MemoryTokenStore();
    const jeu = tokens();

    expect(await store.get(ORG)).toBeNull();

    await store.put(ORG, jeu);
    expect(await store.get(ORG)).toEqual(jeu);

    await store.delete(ORG);
    expect(await store.get(ORG)).toBeNull();
    expect(store.taille).toBe(0);
  });

  it("supporte un delete IDEMPOTENT (rappelé, jamais d'erreur)", async () => {
    const store = new MemoryTokenStore();
    await store.put(ORG, tokens());

    await expect(store.delete(ORG)).resolves.toBeUndefined();
    await expect(store.delete(ORG)).resolves.toBeUndefined();
    await expect(store.delete("org_jamais_vue")).resolves.toBeUndefined();
    expect(await store.get(ORG)).toBeNull();
  });

  it("isole les organisations entre elles", async () => {
    const store = new MemoryTokenStore();
    await store.put("org_a", tokens({ accessToken: "at_a" }));
    await store.put("org_b", tokens({ accessToken: "at_b" }));

    await store.delete("org_a");

    expect(await store.get("org_a")).toBeNull();
    expect((await store.get("org_b"))?.accessToken).toBe("at_b");
  });

  it("renvoie une copie : muter le résultat n'altère pas le stockage", async () => {
    const store = new MemoryTokenStore();
    await store.put(ORG, tokens());

    const relu = await store.get(ORG);
    relu!.accessToken = "at_pirate";

    expect((await store.get(ORG))?.accessToken).toBe("at_secret_1234567890");
  });

  it("refuse un orgKey vide", async () => {
    const store = new MemoryTokenStore();

    await expect(store.put("  ", tokens())).rejects.toThrow(/orgKey vide/);
    await expect(store.get("")).rejects.toThrow(/orgKey vide/);
    await expect(store.delete("")).rejects.toThrow(/orgKey vide/);
  });
});

describe("KvTokenStore", () => {
  it("fait le cycle complet put → get → delete", async () => {
    const kv = new FauxKv();
    const store = new KvTokenStore(kv);
    const jeu = tokens();

    expect(await store.get(ORG)).toBeNull();

    await store.put(ORG, jeu);
    expect(await store.get(ORG)).toEqual(jeu);

    await store.delete(ORG);
    expect(await store.get(ORG)).toBeNull();
    expect(kv.entrees.size).toBe(0);
  });

  it("n'écrit JAMAIS le token en clair dans KV", async () => {
    const kv = new FauxKv();
    const jeu = tokens();

    await new KvTokenStore(kv).put(ORG, jeu);
    const [enregistre] = [...kv.entrees.values()];

    expect(enregistre.valeur).not.toContain(jeu.accessToken);
    expect(enregistre.valeur).not.toContain(jeu.refreshToken!);
    expect(enregistre.valeur).not.toContain("accessToken");
  });

  it("préfixe la clé KV par un espace de noms versionné", async () => {
    const kv = new FauxKv();
    await new KvTokenStore(kv).put(ORG, tokens());

    expect([...kv.entrees.keys()]).toEqual([`argentier:tokens:v1:${ORG}`]);
  });

  it("cale le TTL sur la durée de vie du refresh token", async () => {
    const kv = new FauxKv();
    await new KvTokenStore(kv).put(ORG, tokens());

    expect(kv.entrees.get(`argentier:tokens:v1:${ORG}`)?.ttl).toBe(
      DUREE_REFRESH_SECONDES,
    );
  });

  it("sans refresh token, borne le TTL à l'expiration de l'access token", async () => {
    const kv = new FauxKv();
    const jeu = tokens({ refreshToken: undefined, expiresAt: Date.now() + 7_200_000 });

    await new KvTokenStore(kv).put(ORG, jeu);
    const ttl = kv.entrees.get(`argentier:tokens:v1:${ORG}`)?.ttl ?? 0;

    expect(ttl).toBeGreaterThan(7_100);
    expect(ttl).toBeLessThanOrEqual(7_200);
  });

  it("supporte un delete IDEMPOTENT, même sur une organisation inconnue", async () => {
    const kv = new FauxKv();
    const store = new KvTokenStore(kv);
    await store.put(ORG, tokens());

    await expect(store.delete(ORG)).resolves.toBeUndefined();
    await expect(store.delete(ORG)).resolves.toBeUndefined();
    await expect(store.delete("org_jamais_vue")).resolves.toBeUndefined();
    expect(kv.suppressions).toBe(3);
    expect(kv.entrees.size).toBe(0);
  });

  it("remonte l'erreur si le blob stocké a été altéré", async () => {
    const kv = new FauxKv();
    const store = new KvTokenStore(kv);
    await store.put(ORG, tokens());

    const cle = `argentier:tokens:v1:${ORG}`;
    const abime = kv.entrees.get(cle)!.valeur.replace(/.$/, (dernier) =>
      dernier === "A" ? "B" : "A",
    );
    kv.entrees.set(cle, { valeur: abime });

    await expect(store.get(ORG)).rejects.toThrow(/Déchiffrement impossible/);
  });

  it("refuse d'écrire si ARGENTIER_TOKEN_KEY manque (pas de repli en clair)", async () => {
    delete process.env.ARGENTIER_TOKEN_KEY;
    const kv = new FauxKv();

    await expect(new KvTokenStore(kv).put(ORG, tokens())).rejects.toThrow(
      /ARGENTIER_TOKEN_KEY est absente/,
    );
    expect(kv.entrees.size).toBe(0);
  });
});

describe("ttlSeconds", () => {
  it("ne descend jamais sous le plancher KV de 60 s", () => {
    const expire = tokens({ refreshToken: undefined, expiresAt: Date.now() - 1_000 });

    expect(ttlSeconds(expire)).toBe(60);
  });

  it("ignore l'expiration de l'access token quand un refresh token existe", () => {
    const jeu = tokens({ expiresAt: Date.now() + 60_000 });

    expect(ttlSeconds(jeu)).toBe(DUREE_REFRESH_SECONDES);
  });
});

describe("getTokenStore", () => {
  it("choisit KV quand le binding ARGENTIER_TOKENS est présent", () => {
    const avertissement = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = getTokenStore({ ARGENTIER_TOKENS: new FauxKv() });

    expect(store).toBeInstanceOf(KvTokenStore);
    expect(avertissement).not.toHaveBeenCalled();
  });

  it("retombe en mémoire avec un avertissement en français, sans binding", () => {
    const avertissement = vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = getTokenStore();

    expect(store).toBeInstanceOf(MemoryTokenStore);
    expect(avertissement).toHaveBeenCalledTimes(1);
    expect(avertissement.mock.calls[0]?.[0]).toMatch(/MÉMOIRE/);
    expect(avertissement.mock.calls[0]?.[0]).toMatch(/ARGENTIER_TOKENS/);
  });

  it("réutilise la même instance mémoire et n'avertit qu'une fois", () => {
    const avertissement = vi.spyOn(console, "warn").mockImplementation(() => {});

    const premier = getTokenStore();
    const second = getTokenStore({});

    expect(second).toBe(premier);
    expect(avertissement).toHaveBeenCalledTimes(1);
  });

  it("ignore un binding qui n'a pas la forme d'un KVNamespace", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const store = getTokenStore({ ARGENTIER_TOKENS: { get: "pas une fonction" } });

    expect(store).toBeInstanceOf(MemoryTokenStore);
  });
});

// ---------------------------------------------------------------------------
// Le correctif de fond : en production, PLUS DE REPLI SILENCIEUX.
//
// Sans ces cas, la régression est indolore — le code redevient vert avec un
// simple `console.warn`, et la production repart en stockant des jetons
// bancaires en clair. Chacun de ces tests échoue si l'on retire le garde-fou de
// `getTokenStore()`.
// ---------------------------------------------------------------------------
describe("getTokenStore hors développement", () => {
  it("LÈVE quand le binding KV est absent en production", () => {
    const avertissement = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");

    expect(() => getTokenStore()).toThrow(BindingManquantError);
    // Un avertissement n'est pas une mesure de sécurité : rien ne doit être
    // rendu, et surtout pas un MemoryTokenStore assorti d'un log.
    expect(avertissement).not.toHaveBeenCalled();
  });

  it("nomme le binding manquant et sa conséquence, en français", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(() => getTokenStore()).toThrow(/ARGENTIER_TOKENS/);
    expect(() => getTokenStore()).toThrow(/MÉMOIRE, en clair/);
    expect(() => getTokenStore()).toThrow(/wrangler\.jsonc/);
  });

  it("LÈVE aussi sur un binding MALFORMÉ (nom mal orthographié, faux objet)", () => {
    vi.stubEnv("NODE_ENV", "production");

    // Le cas réel : une coquille dans wrangler.jsonc, ou un namespace non
    // provisionné. Il doit produire le même refus qu'une absence totale.
    expect(() => getTokenStore({ ARGENTIER_TOKENS: { get: "pas une fonction" } })).toThrow(
      BindingManquantError,
    );
    expect(() => getTokenStore({ ARGENTIER_TOKENS: {} })).toThrow(BindingManquantError);
  });

  it("accepte le binding KV en production, sans rien exiger d'autre", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(getTokenStore({ ARGENTIER_TOKENS: new FauxKv() })).toBeInstanceOf(KvTokenStore);
  });

  it("ne réautorise la mémoire en production que sur échappatoire EXPLICITE", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(NOM_ECHAPPATOIRE, "1");

    expect(getTokenStore()).toBeInstanceOf(MemoryTokenStore);
  });

  it("ne se laisse pas amadouer par une échappatoire approximative", () => {
    vi.stubEnv("NODE_ENV", "production");

    for (const valeur of ["true", "yes", "0", "oui", ""]) {
      vi.stubEnv(NOM_ECHAPPATOIRE, valeur);
      expect(() => getTokenStore(), `valeur « ${valeur} » acceptée`).toThrow(
        BindingManquantError,
      );
    }
  });

  it("laisse le développement tranquille (repli mémoire toujours possible)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "development");

    expect(getTokenStore()).toBeInstanceOf(MemoryTokenStore);
  });
});
