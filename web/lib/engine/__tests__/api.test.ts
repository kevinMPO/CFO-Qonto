// ---------------------------------------------------------------------------
// Tests de la frontière HTTP de l'API moteur (lib/engine/api) — logique pure.
// Auth par jeton, validation stricte, analyse/simulation déterministes.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from "vitest";

import {
  AnalyzeBody,
  SimulateBody,
  analyzeFromBody,
  authenticateEngine,
  simulateFromBody,
} from "@/lib/engine/api";

const MONTHLY = [
  { merchant: "Notion", amount: 20, date: "2026-06-15" },
  { merchant: "Notion", amount: 20, date: "2026-07-15" },
  { merchant: "Notion", amount: 20, date: "2026-08-15" },
];

function req(auth?: string): Request {
  return new Request("https://x/api/v1/engine/analyze", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });
}

afterEach(() => {
  delete process.env.ENGINE_API_TOKENS;
});

describe("validation stricte des schémas", () => {
  it("rejette une clé inconnue (.strict)", () => {
    const r = AnalyzeBody.safeParse({ transactions: MONTHLY, sneaky: true });
    expect(r.success).toBe(false);
  });

  it("applique les valeurs par défaut (side, windowDays, account)", () => {
    const r = AnalyzeBody.parse({ transactions: MONTHLY });
    expect(r.windowDays).toBe(90);
    expect(r.account).toEqual({ name: "Compte", bank: "Qonto", balance: 0 });
    expect(r.transactions[0].side).toBe("debit");
  });

  it("refuse un tableau de transactions vide", () => {
    expect(AnalyzeBody.safeParse({ transactions: [] }).success).toBe(false);
  });

  it("refuse une date mal formée", () => {
    const r = AnalyzeBody.safeParse({ transactions: [{ merchant: "X", amount: 1, date: "15/06/2026" }] });
    expect(r.success).toBe(false);
  });
});

describe("analyse déterministe depuis une charge validée", () => {
  it("respecte l'étiquette de l'appelant et joint engineVersion", () => {
    const input = AnalyzeBody.parse({
      transactions: MONTHLY,
      labels: [{ merchant: "Notion", nature: "pilotable", action: "cancel", isSubscription: true }],
    });
    const out = analyzeFromBody(input);
    const l = out.levers.find((x) => x.label === "Notion")!;
    expect(l.saving).toBe(20); // cancel ⇒ 100 %
    expect(l.motif).toBe("abonnement");
    expect(typeof out.engineVersion).toBe("string");
  });

  it("sans étiquette, retombe sur le classifieur déterministe (rules)", () => {
    const input = AnalyzeBody.parse({ transactions: MONTHLY });
    const out = analyzeFromBody(input);
    expect(out.meta?.categorized).toBe("rules");
  });

  it("est déterministe (deux appels identiques ⇒ même JSON)", () => {
    const input = AnalyzeBody.parse({ transactions: MONTHLY, labels: [{ merchant: "Notion", nature: "pilotable", action: "renegotiate", isSubscription: true }] });
    expect(JSON.stringify(analyzeFromBody(input))).toBe(JSON.stringify(analyzeFromBody(input)));
  });
});

describe("simulation : les décisions pilotent le total", () => {
  it("désactiver un levier le retire du total", () => {
    const base = SimulateBody.parse({
      transactions: MONTHLY,
      labels: [{ merchant: "Notion", nature: "pilotable", action: "cancel", isSubscription: true }],
    });
    const on = simulateFromBody(base);
    expect(on.monthly).toBe(20);
    expect(on.annual).toBe(240);

    const leverId = on.levers[0].id;
    const off = simulateFromBody(SimulateBody.parse({ ...base, decisions: [{ leverId, active: false }] }));
    expect(off.monthly).toBe(0);
    expect(off.count).toBe(0);
  });
});

describe("authentification par jeton Bearer", () => {
  it("503 quand aucun jeton n'est configuré", () => {
    const a = authenticateEngine(req("Bearer whatever"));
    expect(a).toMatchObject({ ok: false, status: 503, code: "engine_api_not_configured" });
  });

  it("401 sans en-tête Authorization", () => {
    process.env.ENGINE_API_TOKENS = "secret-abc";
    expect(authenticateEngine(req())).toMatchObject({ ok: false, status: 401, code: "missing_bearer" });
  });

  it("401 sur un jeton inconnu", () => {
    process.env.ENGINE_API_TOKENS = "secret-abc,secret-def";
    expect(authenticateEngine(req("Bearer nope"))).toMatchObject({ ok: false, status: 401, code: "invalid_token" });
  });

  it("accepte un jeton valide parmi plusieurs", () => {
    process.env.ENGINE_API_TOKENS = "secret-abc, secret-def";
    const a = authenticateEngine(req("Bearer secret-def"));
    expect(a).toMatchObject({ ok: true, token: "secret-def" });
  });
});
