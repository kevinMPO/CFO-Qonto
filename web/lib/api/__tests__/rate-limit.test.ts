// ---------------------------------------------------------------------------
// Tests de `lib/api/rate-limit.ts`.
//
// Ce qu'ils protègent : le fait qu'une route payante ne puisse PAS être appelée
// en boucle par un anonyme. Le pentest a montré qu'une simple requête curl
// déclenchait des appels Linkup et Anthropic facturés ; ces cas figent le
// plafond qui referme ce trou, et la propriété qui compte le plus — le compteur
// survit au recyclage de l'isolat, parce qu'il est aussi tenu dans le KV.
//
// Ils vérifient aussi la règle n°3 : aucune adresse IP en clair dans le
// stockage partagé.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PLAFONDS,
  __resetRateLimitForTests,
  ipDemandeur,
  messageTropDeRequetes,
  reponseTropDeRequetes,
  verifierDebit,
} from "@/lib/api/rate-limit";

/** Faux KVNamespace : mémoire du test, avec journal des écritures. */
class FauxKv {
  readonly valeurs = new Map<string, string>();
  readonly ecritures: Array<{ cle: string; valeur: string; ttl?: number }> = [];

  async get(cle: string): Promise<string | null> {
    return this.valeurs.get(cle) ?? null;
  }

  async put(
    cle: string,
    valeur: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    this.valeurs.set(cle, valeur);
    this.ecritures.push({ cle, valeur, ttl: options?.expirationTtl });
  }

  async delete(cle: string): Promise<void> {
    this.valeurs.delete(cle);
  }
}

/** Requête minimale portant l'IP telle que la pose l'edge Cloudflare. */
function requeteDepuis(ip: string): Request {
  return new Request("https://argentier.test/api/voice", {
    method: "POST",
    headers: { "cf-connecting-ip": ip },
  });
}

/** Pose (ou retire) le binding KV vu par `bindingsArgentier()`. */
function poserKv(kv: FauxKv | null): void {
  const global = globalThis as { ARGENTIER_TOKENS?: unknown };
  if (kv) global.ARGENTIER_TOKENS = kv;
  else delete global.ARGENTIER_TOKENS;
}

const T0 = Date.parse("2026-08-11T12:00:00.000Z");

beforeEach(() => {
  __resetRateLimitForTests();
  poserKv(null);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  poserKv(null);
  vi.restoreAllMocks();
});

describe("ipDemandeur", () => {
  it("préfère CF-Connecting-IP, la seule source non falsifiable", () => {
    const requete = new Request("https://argentier.test/api/voice", {
      headers: {
        "cf-connecting-ip": "203.0.113.7",
        "x-real-ip": "198.51.100.1",
        "x-forwarded-for": "192.0.2.1, 10.0.0.1",
      },
    });
    expect(ipDemandeur(requete)).toBe("203.0.113.7");
  });

  it("retombe sur x-real-ip puis sur le premier x-forwarded-for", () => {
    const reel = new Request("https://argentier.test/", {
      headers: { "x-real-ip": "198.51.100.1", "x-forwarded-for": "192.0.2.1" },
    });
    expect(ipDemandeur(reel)).toBe("198.51.100.1");

    const transmis = new Request("https://argentier.test/", {
      headers: { "x-forwarded-for": " 192.0.2.1 , 10.0.0.1" },
    });
    expect(ipDemandeur(transmis)).toBe("192.0.2.1");
  });

  it("range les requêtes sans en-tête dans un seau commun, jamais hors limite", () => {
    expect(ipDemandeur(new Request("https://argentier.test/"))).toBe("inconnue");
  });
});

describe("verifierDebit — plafond de rafale", () => {
  it("laisse passer le plafond exact puis refuse la requête suivante", async () => {
    const { max } = PLAFONDS.voice[0];

    for (let i = 1; i <= max; i++) {
      const verdict = await verifierDebit(requeteDepuis("203.0.113.7"), "voice", undefined, T0);
      expect(verdict.autorise, `requête ${i}`).toBe(true);
      expect(verdict.restant).toBe(max - i);
    }

    const refus = await verifierDebit(requeteDepuis("203.0.113.7"), "voice", undefined, T0);
    expect(refus.autorise).toBe(false);
    expect(refus.restant).toBe(0);
    expect(refus.retryApres).toBeGreaterThan(0);
  });

  it("compte séparément deux adresses différentes", async () => {
    const fenetres = [{ max: 1, secondes: 60 }];

    expect((await verifierDebit(requeteDepuis("203.0.113.7"), "voice", fenetres, T0)).autorise).toBe(true);
    expect((await verifierDebit(requeteDepuis("203.0.113.8"), "voice", fenetres, T0)).autorise).toBe(true);
    expect((await verifierDebit(requeteDepuis("203.0.113.7"), "voice", fenetres, T0)).autorise).toBe(false);
    expect((await verifierDebit(requeteDepuis("203.0.113.8"), "voice", fenetres, T0)).autorise).toBe(false);
  });

  it("compte séparément deux routes", async () => {
    const fenetres = [{ max: 1, secondes: 60 }];
    const requete = () => requeteDepuis("203.0.113.7");

    expect((await verifierDebit(requete(), "voice", fenetres, T0)).autorise).toBe(true);
    expect((await verifierDebit(requete(), "letter", fenetres, T0)).autorise).toBe(true);
    expect((await verifierDebit(requete(), "voice", fenetres, T0)).autorise).toBe(false);
  });

  it("rouvre le quota à la fenêtre suivante", async () => {
    const fenetres = [{ max: 1, secondes: 60 }];

    expect((await verifierDebit(requeteDepuis("203.0.113.7"), "voice", fenetres, T0)).autorise).toBe(true);
    expect((await verifierDebit(requeteDepuis("203.0.113.7"), "voice", fenetres, T0)).autorise).toBe(false);

    const plusTard = T0 + 60_000;
    expect((await verifierDebit(requeteDepuis("203.0.113.7"), "voice", fenetres, plusTard)).autorise).toBe(true);
  });

  it("refuse un seau sans plafond déclaré plutôt que de laisser passer", async () => {
    await expect(
      verifierDebit(requeteDepuis("203.0.113.7"), "seau-inconnu", undefined, T0),
    ).rejects.toThrow(/seau-inconnu/i);
  });
});

describe("verifierDebit — quota persistant en KV", () => {
  it("survit au recyclage de l'isolat : la mémoire repart à zéro, pas le KV", async () => {
    const kv = new FauxKv();
    poserKv(kv);
    const fenetres = [{ max: 2, secondes: 3600 }];

    expect((await verifierDebit(requeteDepuis("203.0.113.7"), "voice", fenetres, T0)).autorise).toBe(true);
    expect((await verifierDebit(requeteDepuis("203.0.113.7"), "voice", fenetres, T0)).autorise).toBe(true);

    // L'isolat est recyclé : seuls les compteurs mémoire disparaissent.
    __resetRateLimitForTests();

    const apres = await verifierDebit(requeteDepuis("203.0.113.7"), "voice", fenetres, T0);
    expect(apres.autorise).toBe(false);
  });

  it("n'écrit rien dans le KV quand elle refuse — refuser doit rester gratuit", async () => {
    const kv = new FauxKv();
    poserKv(kv);
    const fenetres = [{ max: 1, secondes: 60 }];

    await verifierDebit(requeteDepuis("203.0.113.7"), "voice", fenetres, T0);
    const ecrituresApresAcceptation = kv.ecritures.length;
    expect(ecrituresApresAcceptation).toBe(1);

    for (let i = 0; i < 5; i++) {
      await verifierDebit(requeteDepuis("203.0.113.7"), "voice", fenetres, T0);
    }
    expect(kv.ecritures.length).toBe(ecrituresApresAcceptation);
  });

  it("cale le TTL de la clé sur la fin de la fenêtre", async () => {
    const kv = new FauxKv();
    poserKv(kv);

    await verifierDebit(requeteDepuis("203.0.113.7"), "voice", [{ max: 5, secondes: 3600 }], T0);

    const [ecriture] = kv.ecritures;
    expect(ecriture.ttl).toBeGreaterThan(0);
    expect(ecriture.ttl).toBeLessThanOrEqual(3600);
  });

  it("n'écrit JAMAIS l'adresse IP en clair (règle n°3)", async () => {
    const kv = new FauxKv();
    poserKv(kv);

    await verifierDebit(requeteDepuis("203.0.113.7"), "voice", [{ max: 5, secondes: 3600 }], T0);

    for (const { cle, valeur } of kv.ecritures) {
      expect(cle).not.toContain("203.0.113.7");
      expect(valeur).not.toContain("203.0.113.7");
    }
  });

  it("limite quand même si le KV tombe en panne", async () => {
    const kv = new FauxKv();
    kv.put = async () => {
      throw new Error("KV indisponible");
    };
    poserKv(kv);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fenetres = [{ max: 1, secondes: 60 }];

    expect((await verifierDebit(requeteDepuis("203.0.113.7"), "voice", fenetres, T0)).autorise).toBe(true);
    expect((await verifierDebit(requeteDepuis("203.0.113.7"), "voice", fenetres, T0)).autorise).toBe(false);
  });

  it("limite aussi sans binding KV du tout (dev local)", async () => {
    const fenetres = [{ max: 1, secondes: 60 }];

    expect((await verifierDebit(requeteDepuis("203.0.113.7"), "voice", fenetres, T0)).autorise).toBe(true);
    expect((await verifierDebit(requeteDepuis("203.0.113.7"), "voice", fenetres, T0)).autorise).toBe(false);
  });
});

describe("reponseTropDeRequetes", () => {
  it("répond 429 avec Retry-After et une explication en français", async () => {
    const verdict = { autorise: false, limite: 3, restant: 0, retryApres: 42 };
    const reponse = reponseTropDeRequetes(verdict);

    expect(reponse.status).toBe(429);
    expect(reponse.headers.get("Retry-After")).toBe("42");
    expect(reponse.headers.get("RateLimit-Limit")).toBe("3");
    expect(reponse.headers.get("Cache-Control")).toBe("no-store");

    const corps = (await reponse.json()) as { error: string; message: string };
    expect(corps.error).toBe("rate_limited");
    expect(corps.message).toBe(messageTropDeRequetes(verdict));
    expect(corps.message).toMatch(/Réessaie dans 42 s/);
  });

  it("laisse la route ajouter les champs que son écran attend", async () => {
    const reponse = reponseTropDeRequetes(
      { autorise: false, limite: 8, restant: 0, retryApres: 10 },
      { letter: "explication" },
    );
    const corps = (await reponse.json()) as { letter: string };
    expect(corps.letter).toBe("explication");
  });
});

describe("plafonds déclarés", () => {
  it("couvre exactement les routes limitées", () => {
    // `engine` : API moteur publique (par jeton). Les autres : routes payantes.
    expect(Object.keys(PLAFONDS).sort()).toEqual(["benchmark", "engine", "letter", "risk", "voice"]);
  });

  it("garde des plafonds finis et strictement positifs", () => {
    for (const [seau, fenetres] of Object.entries(PLAFONDS)) {
      expect(fenetres.length, seau).toBeGreaterThan(0);
      for (const { max, secondes } of fenetres) {
        expect(max, seau).toBeGreaterThan(0);
        expect(max, seau).toBeLessThanOrEqual(100);
        expect(secondes, seau).toBeGreaterThanOrEqual(60);
      }
    }
  });
});
