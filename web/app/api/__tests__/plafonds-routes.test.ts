// ---------------------------------------------------------------------------
// Tests du plafonnement des trois routes PAYANTES : /api/benchmark,
// /api/letter, /api/voice.
//
// Le constat qu'ils referment est un fait de pentest, pas une hypothèse : une
// requête anonyme sur le site public déclenchait réellement des appels Linkup,
// Anthropic et ElevenLabs facturés au propriétaire, sans aucune limite.
//
// Ce qui est vérifié ici, et qui compte plus que le code de statut : au-delà du
// plafond, le TRAVAIL PAYANT N'A PAS LIEU. On espionne donc `benchmark()`,
// `generateLetter()` et le `fetch` vers ElevenLabs, et on exige zéro appel
// supplémentaire une fois le quota atteint.
//
// Ce qui est vérifié aussi, en creux : la démo d'un visiteur NON CONNECTÉ à
// Qonto continue de fonctionner — les premiers appels passent sans session ni
// cookie. C'est la raison pour laquelle ces routes sont plafonnées et non
// authentifiées.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PLAFONDS, __resetRateLimitForTests } from "@/lib/api/rate-limit";

vi.mock("@/lib/benchmark", () => ({
  benchmark: vi.fn(async () => ({
    verified: true,
    note: "ok",
    alternatives: [],
    sources: [],
  })),
}));

vi.mock("@/lib/letters", () => ({
  generateLetter: vi.fn(async () => "Madame, Monsieur, …"),
}));

const { POST: postBenchmark } = await import("@/app/api/benchmark/route");
const { POST: postLetter } = await import("@/app/api/letter/route");
const { POST: postVoice } = await import("@/app/api/voice/route");
const { benchmark } = await import("@/lib/benchmark");
const { generateLetter } = await import("@/lib/letters");

/** Requête anonyme — pas de cookie de session, comme un visiteur de /demo. */
function requeteAnonyme(chemin: string, ip: string, corps: unknown): Request {
  return new Request(`https://argentier.test${chemin}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(corps),
  });
}

beforeEach(() => {
  __resetRateLimitForTests();
  vi.mocked(benchmark).mockClear();
  vi.mocked(generateLetter).mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/benchmark", () => {
  const CORPS = { merchant: "Notion", category: "SaaS", monthly: 20 };

  it("sert un visiteur anonyme jusqu'au plafond, puis coupe", async () => {
    const { max } = PLAFONDS.benchmark[0];
    const ip = "203.0.113.11";

    for (let i = 1; i <= max; i++) {
      const reponse = await postBenchmark(requeteAnonyme("/api/benchmark", ip, CORPS));
      expect(reponse.status, `requête ${i}`).toBe(200);
    }
    expect(vi.mocked(benchmark)).toHaveBeenCalledTimes(max);

    const refus = await postBenchmark(requeteAnonyme("/api/benchmark", ip, CORPS));
    expect(refus.status).toBe(429);
    expect(refus.headers.get("Retry-After")).toBeTruthy();

    // LE point du test : la recherche web payante n'a pas été relancée.
    expect(vi.mocked(benchmark)).toHaveBeenCalledTimes(max);

    const corps = (await refus.json()) as { error: string; note: string };
    expect(corps.error).toBe("rate_limited");
    // L'écran de la démo affiche `note` : il doit montrer une explication.
    expect(corps.note).toMatch(/plafonnée/);
  });

  it("n'entame pas le quota d'une autre adresse", async () => {
    const { max } = PLAFONDS.benchmark[0];
    for (let i = 0; i <= max; i++) {
      await postBenchmark(requeteAnonyme("/api/benchmark", "203.0.113.12", CORPS));
    }
    const autre = await postBenchmark(
      requeteAnonyme("/api/benchmark", "203.0.113.13", CORPS),
    );
    expect(autre.status).toBe(200);
  });
});

describe("POST /api/letter", () => {
  const CORPS = { merchant: "Notion", action: "cancel" };

  it("sert un visiteur anonyme jusqu'au plafond, puis coupe", async () => {
    const { max } = PLAFONDS.letter[0];
    const ip = "203.0.113.21";

    for (let i = 1; i <= max; i++) {
      const reponse = await postLetter(requeteAnonyme("/api/letter", ip, CORPS));
      expect(reponse.status, `requête ${i}`).toBe(200);
    }
    expect(vi.mocked(generateLetter)).toHaveBeenCalledTimes(max);

    const refus = await postLetter(requeteAnonyme("/api/letter", ip, CORPS));
    expect(refus.status).toBe(429);
    expect(vi.mocked(generateLetter)).toHaveBeenCalledTimes(max);

    // La modale de la démo affiche `letter` : elle doit expliquer, pas rester
    // vide.
    const corps = (await refus.json()) as { error: string; letter: string };
    expect(corps.error).toBe("rate_limited");
    expect(corps.letter).toMatch(/plafonnée/);
  });
});

describe("POST /api/voice", () => {
  const CORPS = { text: "Bienvenue sur Argentier.", lang: "fr" };

  it("sert un visiteur anonyme jusqu'au plafond, puis coupe sans appeler ElevenLabs", async () => {
    const cleOrigine = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = "cle-de-test";

    // Une `Response` NEUVE par appel : un corps déjà lu ne se relit pas.
    const appels = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        }),
    );

    try {
      const { max } = PLAFONDS.voice[0];
      const ip = "203.0.113.31";

      for (let i = 1; i <= max; i++) {
        const reponse = await postVoice(requeteAnonyme("/api/voice", ip, CORPS));
        expect(reponse.status, `requête ${i}`).toBe(200);
      }
      expect(appels).toHaveBeenCalledTimes(max);

      const refus = await postVoice(requeteAnonyme("/api/voice", ip, CORPS));
      expect(refus.status).toBe(429);
      // Le vrai enjeu : aucune synthèse vocale facturée de plus.
      expect(appels).toHaveBeenCalledTimes(max);
    } finally {
      if (cleOrigine === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = cleOrigine;
    }
  });

  it("plafonne AVANT même de regarder si la clé ElevenLabs existe", async () => {
    const cleOrigine = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;

    try {
      const { max } = PLAFONDS.voice[0];
      const ip = "203.0.113.32";

      for (let i = 1; i <= max; i++) {
        expect((await postVoice(requeteAnonyme("/api/voice", ip, CORPS))).status).toBe(503);
      }
      expect((await postVoice(requeteAnonyme("/api/voice", ip, CORPS))).status).toBe(429);
    } finally {
      if (cleOrigine !== undefined) process.env.ELEVENLABS_API_KEY = cleOrigine;
    }
  });
});
