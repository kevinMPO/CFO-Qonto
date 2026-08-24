// ---------------------------------------------------------------------------
// Tests HTTP de l'API moteur : la chaîne auth → débit → parse strict → calcul,
// à travers les vraies routes /api/v1/engine/{analyze,health}.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as analyze } from "@/app/api/v1/engine/analyze/route";
import { GET as health } from "@/app/api/v1/engine/health/route";
import { __resetRateLimitForTests } from "@/lib/api/rate-limit";

const BODY = {
  transactions: [
    { merchant: "Notion", amount: 20, date: "2026-06-15" },
    { merchant: "Notion", amount: 20, date: "2026-07-15" },
    { merchant: "Notion", amount: 20, date: "2026-08-15" },
  ],
  labels: [{ merchant: "Notion", nature: "pilotable", action: "cancel", isSubscription: true }],
};

function post(body: unknown, auth?: string): Request {
  return new Request("https://x/api/v1/engine/analyze", {
    method: "POST",
    headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  __resetRateLimitForTests();
});
afterEach(() => {
  delete process.env.ENGINE_API_TOKENS;
  __resetRateLimitForTests();
});

describe("/api/v1/engine/analyze", () => {
  it("503 quand l'API n'est pas armée (aucun jeton)", async () => {
    const res = await analyze(post(BODY, "Bearer x"));
    expect(res.status).toBe(503);
  });

  it("401 sur un jeton inconnu", async () => {
    process.env.ENGINE_API_TOKENS = "tok-1";
    const res = await analyze(post(BODY, "Bearer wrong"));
    expect(res.status).toBe(401);
  });

  it("200 + engineVersion sur un jeton valide", async () => {
    process.env.ENGINE_API_TOKENS = "tok-1";
    const res = await analyze(post(BODY, "Bearer tok-1"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.engineVersion).toBeDefined();
    expect(json.levers.find((l: { label: string }) => l.label === "Notion").saving).toBe(20);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("400 sur une charge invalide (clé inconnue)", async () => {
    process.env.ENGINE_API_TOKENS = "tok-1";
    const res = await analyze(post({ ...BODY, sneaky: 1 }, "Bearer tok-1"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_body");
  });

  it("429 au-delà du plafond du jeton", async () => {
    process.env.ENGINE_API_TOKENS = "tok-burst";
    let last = 200;
    for (let i = 0; i < 65; i++) {
      last = (await analyze(post(BODY, "Bearer tok-burst"))).status;
    }
    expect(last).toBe(429);
  });
});

describe("/api/v1/engine/health", () => {
  it("200 sans auth, expose la version, ne cache pas", async () => {
    const res = await health();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.engineVersion).toBeDefined();
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });
});
