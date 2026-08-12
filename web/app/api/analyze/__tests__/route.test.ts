// ---------------------------------------------------------------------------
// Tests du câblage de /api/analyze.
//
// Ce qu'ils protègent, par ordre d'importance :
//
//  1. LE CLOISONNEMENT. Un visiteur ne peut voir QUE son compte. Il n'existe
//     plus de troisième source : la clé API statique du fondateur (`lib/qonto.ts`,
//     supprimée) servait le compte bancaire RÉEL du fondateur, badgé « live », à
//     tout visiteur dont le jeton avait disparu. Le test correspondant existait
//     déjà — mais son `beforeEach` effaçait `QONTO_LOGIN`, si bien qu'il
//     vérifiait le repli mock et jamais le repli réellement actif en production.
//     Ici, on pose la clé du fondateur dans l'environnement EXPRÈS, et on exige
//     un 401.
//  2. La distinction « pas de visiteur » (→ démo, /demo doit vivre) et
//     « visiteur connu dont le jeton a disparu » (→ 401, reconnecte ton compte).
//  3. Le chemin OAuth n'emprunte jamais d'IBAN de configuration, et la forme de
//     la réponse JSON ne bouge pas.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "@/app/api/analyze/route";
import { signerSession } from "@/lib/auth/session";
import { getTokenStore } from "@/lib/auth/token-store";

const SECRET = "un-secret-de-test-suffisamment-long-0123456789";
const ORG = "org_analyse_test";

const ORGANISATION = {
  organization: {
    id: "e2c1a0d4-1111-2222-3333-444455556666",
    legal_name: "MAMFORMA",
    bank_accounts: [{ iban: "FR7616798000010000012345070", balance: 7646.5 }],
  },
};

const TRANSACTIONS = {
  transactions: [
    {
      transaction_id: "t1",
      clean_counterparty_name: "Notion",
      amount: 20,
      side: "debit",
      operation_type: "card",
      settled_at: "2026-07-15T10:00:00.000Z",
    },
    {
      transaction_id: "t2",
      clean_counterparty_name: "Notion",
      amount: 20,
      side: "debit",
      operation_type: "card",
      settled_at: "2026-08-15T10:00:00.000Z",
    },
  ],
  meta: { next_page: null },
};

function reponse(corps: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => corps,
    text: async () => JSON.stringify(corps),
  } as unknown as Response;
}

const faux = vi.fn<typeof fetch>();
let fetchInitial: typeof fetch;
const envInitial: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const cle of [
    "ARGENTIER_SESSION_SECRET",
    "QONTO_LOGIN",
    "QONTO_SECRET_KEY",
    "QONTO_IBAN",
    "ANTHROPIC_API_KEY",
  ]) {
    envInitial[cle] = process.env[cle];
    delete process.env[cle];
  }
  process.env.ARGENTIER_SESSION_SECRET = SECRET;

  fetchInitial = globalThis.fetch;
  faux.mockReset();
  faux.mockImplementation(async (entree: RequestInfo | URL) => {
    const url = String(entree);
    if (url.includes("/organization")) return reponse(ORGANISATION);
    if (url.includes("/transactions")) return reponse(TRANSACTIONS);
    throw new Error(`Appel réseau inattendu : ${url}`);
  });
  globalThis.fetch = faux as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = fetchInitial;
  for (const [cle, valeur] of Object.entries(envInitial)) {
    if (valeur === undefined) delete process.env[cle];
    else process.env[cle] = valeur;
  }
});

async function requeteAvecSession(): Promise<Request> {
  await getTokenStore().put(ORG, {
    accessToken: "jeton-visiteur",
    refreshToken: "rafraichissement-visiteur",
    expiresAt: Date.now() + 3_600_000,
    tokenType: "Bearer",
  });
  return new Request("https://argentier.test/api/analyze", {
    headers: { cookie: `argentier_session=${await signerSession(ORG)}` },
  });
}

/** Requête porteuse d'une session signée pour une organisation SANS jeton. */
async function requeteSessionSansJeton(): Promise<Request> {
  const cookie = `argentier_session=${await signerSession("org_sans_jeton")}`;
  return new Request("https://argentier.test/api/analyze", { headers: { cookie } });
}

describe("GET /api/analyze", () => {
  it("sert la session OAuth du visiteur", async () => {
    const reponseHttp = await GET(await requeteAvecSession());
    const corps = (await reponseHttp.json()) as {
      account: { name: string; bank: string; balance: number };
      meta?: { source: string };
    };

    expect(reponseHttp.status).toBe(200);
    expect(corps.meta?.source).toBe("qonto");
    expect(corps.account).toMatchObject({ name: "MAMFORMA", bank: "Qonto", balance: 7646.5 });
  });

  it("appelle Qonto en GET, avec le jeton du visiteur", async () => {
    await GET(await requeteAvecSession());

    expect(faux.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [, init] of faux.mock.calls) {
      expect((init as RequestInit).method).toBe("GET");
      expect((init as RequestInit).headers).toMatchObject({
        Authorization: "Bearer jeton-visiteur",
      });
    }
  });

  it("ignore tout IBAN de configuration, mais transmet celui de l'organisation", async () => {
    // Deux exigences opposées, et l'ancienne version de ce test ne gardait que
    // la première — ce qui laissait passer un bug bloquant :
    //
    //  a) l'IBAN ne doit JAMAIS venir de la configuration. En multi-locataire,
    //     ce serait le compte du fondateur lu pour le compte d'un client ;
    //  b) mais `GET /v2/transactions` REFUSE une requête sans identifiant de
    //     compte : 422 {"code":"missing","detail":"bank_account_id or iban is
    //     missing"}. Il faut donc transmettre l'IBAN lu sur l'organisation.
    process.env.QONTO_IBAN = "FR76IBANDUFONDATEUR000000000";

    await GET(await requeteAvecSession());

    const urls = faux.mock.calls.map(([entree]) => String(entree));
    const urlTransactions = urls.find((url) => url.includes("/transactions"));

    expect(urlTransactions, "aucun appel à /transactions").toBeTruthy();
    // (a) l'IBAN de configuration ne fuite nulle part.
    expect(urls.join(" ")).not.toContain("FR76IBANDUFONDATEUR");
    // (b) l'appel porte bien un identifiant de compte, sinon Qonto renvoie 422.
    expect(
      /[?&](iban|bank_account_id)=/.test(urlTransactions ?? ""),
      "/transactions est appelé sans iban ni bank_account_id : Qonto répondra " +
        "422 et aucune opération ne sera lue",
    ).toBe(true);
  });

  it("conserve la forme du contrat d'API", async () => {
    const corps = (await (await GET(await requeteAvecSession())).json()) as Record<string, unknown>;

    for (const cle of [
      "account",
      "window",
      "totals",
      "natures",
      "poles",
      "score",
      "runway",
      "levers",
      "flux",
    ]) {
      expect(corps, `clé « ${cle} » absente du contrat`).toHaveProperty(cle);
    }
  });

  it("interdit la mise en cache partagée d'une réponse qui varie selon le cookie", async () => {
    const reponseHttp = await GET(await requeteAvecSession());

    expect(reponseHttp.headers.get("Cache-Control")).toContain("no-store");
    expect(reponseHttp.headers.get("Vary")).toBe("Cookie");
  });

  // --- Visiteur ANONYME : la démo doit continuer de vivre -------------------

  it("sert la démo au visiteur sans session, sans appeler Qonto", async () => {
    const reponseHttp = await GET(new Request("https://argentier.test/api/analyze"));
    const corps = (await reponseHttp.json()) as { meta?: { source: string } };

    expect(reponseHttp.status).toBe(200);
    expect(corps.meta?.source).toBe("mock");
    expect(faux).not.toHaveBeenCalled();
  });

  // --- LE cas critique ------------------------------------------------------
  //
  // Ces trois cas échouent si l'on réintroduit le moindre repli : ils sont la
  // preuve de non-régression de la fuite inter-locataire.

  it("répond 401 — et JAMAIS le compte d'un autre — quand la session n'a plus de jeton", async () => {
    // La clé API statique du fondateur est posée EXPRÈS : c'est précisément
    // l'environnement de production qui déclenchait la fuite.
    process.env.QONTO_LOGIN = "fondateur-login";
    process.env.QONTO_SECRET_KEY = "fondateur-secret";
    process.env.QONTO_IBAN = "FR76IBANDUFONDATEUR000000000";

    const reponseHttp = await GET(await requeteSessionSansJeton());
    const corps = (await reponseHttp.json()) as {
      error?: string;
      account?: { name: string };
      meta?: { source: string };
    };

    expect(reponseHttp.status).toBe(401);
    expect(corps.error).toBe("qonto_reconnexion_requise");
    // Aucune sortie réseau : la banque n'est même pas interrogée.
    expect(faux).not.toHaveBeenCalled();
    // Et rien dans le corps ne peut être pris pour un compte réel.
    expect(corps.meta?.source).toBe("mock");
    expect(JSON.stringify(corps)).not.toContain("MAMFORMA");
  });

  it("invite à reconnecter, en français et en anglais", async () => {
    const corps = (await (await GET(await requeteSessionSansJeton())).json()) as {
      message?: { fr: string; en: string };
    };

    expect(corps.message?.fr).toMatch(/[Rr]econnecte/);
    expect(corps.message?.en).toMatch(/[Rr]econnect/);
  });

  it("ne met pas en cache le refus non plus", async () => {
    const reponseHttp = await GET(await requeteSessionSansJeton());

    expect(reponseHttp.headers.get("Cache-Control")).toContain("no-store");
    expect(reponseHttp.headers.get("Vary")).toBe("Cookie");
  });

  it("ne dégrade pas en démo silencieuse quand la lecture Qonto échoue", async () => {
    faux.mockImplementation(async () => {
      return { ok: false, status: 500, text: async () => "boum" } as unknown as Response;
    });

    const reponseHttp = await GET(await requeteAvecSession());
    const corps = (await reponseHttp.json()) as { error?: string };

    // Avant correctif : HTTP 200 avec des chiffres de démonstration, dans la
    // même enveloppe qu'une analyse réelle.
    expect(reponseHttp.status).toBe(502);
    expect(corps.error).toBe("lecture_qonto_impossible");
  });
});
