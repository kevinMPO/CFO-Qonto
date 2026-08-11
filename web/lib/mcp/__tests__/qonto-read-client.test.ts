// ---------------------------------------------------------------------------
// Tests du client Qonto lecture seule.
//
// Trois choses à prouver, dans cet ordre d'importance :
//  1. AUCUNE requête ne peut sortir sans passer par `assertReadOnly`, et aucune
//     requête non-GET ne part jamais — y compris si la barrière refuse.
//  2. Les règles métier reprises de `lib/qonto.ts` sont intactes : pagination
//     (per_page 100, garde-fou 20 pages), détection FX, calcul des montants.
//  3. Un 401 lève `TokenExpiredError` pour que l'appelant rafraîchisse le jeton.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertReadOnly } from "@/lib/mcp/readonly-guard";
import {
  QONTO_API_BASE,
  QontoReadError,
  TokenExpiredError,
  getOrganization,
  listTransactions,
} from "@/lib/mcp/qonto-read-client";

// La barrière reste RÉELLE (on veut que les vrais chemins soient validés),
// mais on l'espionne pour prouver qu'elle est bien sur le chemin critique.
vi.mock("@/lib/mcp/readonly-guard", async (importOriginal) => {
  const reel = await importOriginal<typeof import("@/lib/mcp/readonly-guard")>();
  return { ...reel, assertReadOnly: vi.fn(reel.assertReadOnly) };
});

const garde = vi.mocked(assertReadOnly);

const AUTH = { accessToken: "jeton-oauth-test" };

/** Fabrique une réponse HTTP minimale compatible avec le client. */
function reponse(corps: unknown, status = 200, texte?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => corps,
    text: async () => texte ?? JSON.stringify(corps),
  } as unknown as Response;
}

/** Transaction brute par défaut, surchargeable champ par champ. */
function brute(champs: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transaction_id: "tx-1",
    amount: 42,
    currency: "EUR",
    side: "debit",
    operation_type: "card",
    settled_at: "2026-07-01T09:30:00.000Z",
    label: "STRIPE",
    clean_counterparty_name: "Stripe",
    ...champs,
  };
}

/** Page de transactions au format de l'API. */
function page(transactions: unknown[], nextPage: number | null) {
  return reponse({ transactions, meta: { next_page: nextPage } });
}

let faux: ReturnType<typeof vi.fn>;

beforeEach(() => {
  garde.mockClear();
  faux = vi.fn();
  vi.stubGlobal("fetch", faux);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Init de la n-ième requête sortante. */
function initAppel(n: number): RequestInit {
  return faux.mock.calls[n]?.[1] as RequestInit;
}

/** URL de la n-ième requête sortante. */
function urlAppel(n: number): string {
  return String(faux.mock.calls[n]?.[0]);
}

describe("sortie réseau unique et lecture seule", () => {
  it("n'émet que des requêtes GET, quelle que soit la fonction appelée", async () => {
    faux.mockResolvedValue(page([brute()], null));
    await listTransactions(AUTH, 90);

    faux.mockResolvedValue(reponse({ organization: { name: "Acme" } }));
    await getOrganization(AUTH);

    expect(faux).toHaveBeenCalled();
    for (const appel of faux.mock.calls) {
      const init = appel[1] as RequestInit;
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
    }
  });

  it("appelle assertReadOnly AVANT chaque fetch, avec « GET » et le chemin", async () => {
    faux.mockResolvedValue(reponse({ organization: {} }));
    await getOrganization(AUTH);

    expect(garde).toHaveBeenCalledTimes(1);
    expect(garde).toHaveBeenCalledWith("GET", "/organization");
    expect(garde.mock.invocationCallOrder[0]).toBeLessThan(
      faux.mock.invocationCallOrder[0],
    );
  });

  it("ne laisse SORTIR AUCUN octet si la barrière refuse", async () => {
    garde.mockImplementationOnce(() => {
      throw new Error("barrière read-only");
    });

    await expect(getOrganization(AUTH)).rejects.toThrow("barrière read-only");
    expect(faux).not.toHaveBeenCalled();
  });

  it("interrompt la pagination si la barrière refuse en cours de route", async () => {
    faux.mockResolvedValue(page([brute()], 2));
    garde
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("barrière read-only");
      });

    await expect(listTransactions(AUTH, 90)).rejects.toThrow("barrière read-only");
    expect(faux).toHaveBeenCalledTimes(1);
  });

  it("porte le jeton OAuth en Bearer et jamais de clé login:secret", async () => {
    faux.mockResolvedValue(reponse({ organization: {} }));
    await getOrganization({ accessToken: "abc123" });

    const entetes = initAppel(0).headers as Record<string, string>;
    expect(entetes.Authorization).toBe("Bearer abc123");
    expect(entetes.Authorization).not.toContain(":");
  });

  it("refuse d'appeler sans jeton, sans toucher au réseau", async () => {
    await expect(getOrganization({ accessToken: "" })).rejects.toThrow(
      /Jeton d'accès Qonto manquant/,
    );
    await expect(
      getOrganization({ accessToken: "   " }),
    ).rejects.toThrow(/Jeton d'accès Qonto manquant/);
    expect(faux).not.toHaveBeenCalled();
  });

  it("vise la Business API par défaut et accepte une base injectée", async () => {
    faux.mockResolvedValue(reponse({ organization: {} }));
    await getOrganization(AUTH);
    expect(urlAppel(0)).toBe(`${QONTO_API_BASE}/organization`);
    expect(QONTO_API_BASE).toBe("https://thirdparty.qonto.com/v2");

    faux.mockClear();
    await getOrganization(AUTH, { baseUrl: "https://sandbox.qonto.test/v2/" });
    expect(urlAppel(0)).toBe("https://sandbox.qonto.test/v2/organization");
  });

  it("refuse une base non HTTPS, sans toucher au réseau", async () => {
    await expect(
      getOrganization(AUTH, { baseUrl: "http://evil.test/v2" }),
    ).rejects.toThrow(/HTTPS obligatoire/);
    expect(faux).not.toHaveBeenCalled();
  });

  it("utilise le fetch injecté plutôt que le global quand il est fourni", async () => {
    const injecte = vi.fn().mockResolvedValue(reponse({ organization: {} }));
    await getOrganization(AUTH, { fetch: injecte as unknown as typeof fetch });

    expect(injecte).toHaveBeenCalledTimes(1);
    expect(faux).not.toHaveBeenCalled();
  });
});

describe("invariantes statiques du module", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../qonto-read-client.ts", import.meta.url)),
    "utf8",
  );

  it("ne mentionne aucune méthode d'écriture", () => {
    for (const verbe of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(source.includes(`"${verbe}"`), `verbe ${verbe} présent`).toBe(false);
    }
  });

  it("ne fixe qu'une seule méthode HTTP, et c'est GET", () => {
    const methodes = source.match(/method:\s*"[A-Z]+"/g) ?? [];
    expect(methodes).toEqual(['method: "GET"']);
  });

  it("n'a qu'une seule sortie réseau", () => {
    // Un unique site d'appel : `await executer(...)` dans `requeteLecture`.
    const appels = source.match(/\bexecuter\(/g) ?? [];
    expect(appels).toHaveLength(1);
    // Aucun appel direct à fetch(...) ailleurs dans le module.
    const directs = source.match(/(?<![.\w])fetch\(/g) ?? [];
    expect(directs).toHaveLength(0);
  });

  it("place assertReadOnly avant la sortie réseau dans le code source", () => {
    expect(source.indexOf('assertReadOnly("GET", path)')).toBeGreaterThan(-1);
    expect(source.indexOf('assertReadOnly("GET", path)')).toBeLessThan(
      source.indexOf("await executer("),
    );
  });
});

describe("getOrganization", () => {
  it("choisit le compte correspondant à l'IBAN fourni", async () => {
    faux.mockResolvedValue(
      reponse({
        organization: {
          legal_name: "MAMFORMA",
          bank_accounts: [
            { iban: "FR00AUTRE", balance: 1 },
            { iban: "FR76CIBLE", balance: 7646.5 },
          ],
        },
      }),
    );

    await expect(
      getOrganization({ accessToken: "t", iban: "FR76CIBLE" }),
    ).resolves.toEqual({ name: "MAMFORMA", balance: 7646.5, iban: "FR76CIBLE" });
  });

  it("retombe sur le premier compte si l'IBAN demandé est introuvable", async () => {
    faux.mockResolvedValue(
      reponse({
        organization: {
          name: "Acme",
          bank_accounts: [{ iban: "FR00PREMIER", balance: 100 }],
        },
      }),
    );

    await expect(
      getOrganization({ accessToken: "t", iban: "FR99ABSENT" }),
    ).resolves.toEqual({ name: "Acme", balance: 100, iban: "FR00PREMIER" });
  });

  it("convertit balance_cents en euros quand balance est absent", async () => {
    faux.mockResolvedValue(
      reponse({ organization: { bank_accounts: [{ balance_cents: 764_650 }] } }),
    );

    const org = await getOrganization(AUTH);
    expect(org.balance).toBe(7646.5);
  });

  it("préfère legal_name à name", async () => {
    faux.mockResolvedValue(
      reponse({ organization: { legal_name: "MAMFORMA SAS", name: "Mamforma" } }),
    );
    await expect(getOrganization(AUTH)).resolves.toMatchObject({
      name: "MAMFORMA SAS",
    });
  });

  it("dégrade proprement quand la réponse est vide", async () => {
    faux.mockResolvedValue(reponse({}));
    await expect(getOrganization(AUTH)).resolves.toEqual({
      name: "Mon entreprise",
      balance: 0,
      iban: undefined,
    });
  });

  it("conserve l'IBAN demandé si le compte choisi n'en expose pas", async () => {
    faux.mockResolvedValue(reponse({ organization: { bank_accounts: [{ balance: 5 }] } }));
    await expect(
      getOrganization({ accessToken: "t", iban: "FR76DEMANDE" }),
    ).resolves.toMatchObject({ iban: "FR76DEMANDE" });
  });
});

describe("listTransactions — pagination", () => {
  it("envoie les paramètres attendus (per_page 100, tri, fenêtre, iban)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T12:00:00.000Z"));
    faux.mockResolvedValue(page([], null));

    await listTransactions({ accessToken: "t", iban: "FR76CIBLE" }, 90);

    const url = new URL(urlAppel(0));
    expect(url.pathname).toBe("/v2/transactions");
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(url.searchParams.get("sort_by")).toBe("settled_at:desc");
    expect(url.searchParams.get("current_page")).toBe("1");
    expect(url.searchParams.get("iban")).toBe("FR76CIBLE");
    // 90 jours avant le 11 août 2026 → 13 mai 2026.
    expect(url.searchParams.get("settled_at_from")).toBe("2026-05-13T12:00:00.000Z");
  });

  it("omet le paramètre iban quand aucun n'est fourni", async () => {
    faux.mockResolvedValue(page([], null));
    await listTransactions(AUTH, 30);
    expect(new URL(urlAppel(0)).searchParams.has("iban")).toBe(false);
  });

  it("suit next_page puis s'arrête quand il est nul", async () => {
    faux
      .mockResolvedValueOnce(page([brute({ transaction_id: "a" })], 2))
      .mockResolvedValueOnce(page([brute({ transaction_id: "b" })], 3))
      .mockResolvedValueOnce(page([brute({ transaction_id: "c" })], null));

    const txs = await listTransactions(AUTH, 90);

    expect(faux).toHaveBeenCalledTimes(3);
    expect(txs.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(new URL(urlAppel(1)).searchParams.get("current_page")).toBe("2");
    expect(new URL(urlAppel(2)).searchParams.get("current_page")).toBe("3");
  });

  it("s'arrête sur une page vide même si next_page est renseigné", async () => {
    faux.mockResolvedValue(page([], 2));
    const txs = await listTransactions(AUTH, 90);
    expect(faux).toHaveBeenCalledTimes(1);
    expect(txs).toEqual([]);
  });

  it("s'arrête au garde-fou de 20 pages si l'API ne s'arrête jamais", async () => {
    let numero = 0;
    faux.mockImplementation(async () => {
      numero += 1;
      return page(
        Array.from({ length: 100 }, (_, i) => brute({ transaction_id: `p${numero}-${i}` })),
        numero + 1,
      );
    });

    const txs = await listTransactions(AUTH, 90);

    expect(faux).toHaveBeenCalledTimes(20);
    expect(txs).toHaveLength(2000);
  });

  it("s'arrête aussi si l'API renvoie toujours le même next_page (pas de boucle infinie)", async () => {
    // Cas pathologique : `meta.next_page` constant. Le garde-fou compte les
    // itérations, pas le numéro de page — donc il tient quand même.
    faux.mockResolvedValue(page([brute()], 2));
    const txs = await listTransactions(AUTH, 90);
    expect(faux).toHaveBeenCalledTimes(20);
    expect(txs).toHaveLength(20);
  });

  it("tolère une réponse sans tableau de transactions", async () => {
    faux.mockResolvedValue(reponse({}));
    await expect(listTransactions(AUTH, 90)).resolves.toEqual([]);
  });
});

describe("listTransactions — normalisation et FX", () => {
  async function normaliser(champs: Record<string, unknown>) {
    faux.mockResolvedValue(page([brute(champs)], null));
    const [tx] = await listTransactions(AUTH, 90);
    return tx;
  }

  it("marque FX un frais Qonto dont la référence contient « fx »", async () => {
    const tx = await normaliser({
      operation_type: "qonto_fee",
      reference: "fx_card fee",
      currency: "EUR",
      local_currency: "EUR",
    });
    expect(tx.isFx).toBe(true);
    expect(tx.operationType).toBe("qonto_fee");
  });

  it("reconnaît « FX » quelle que soit la casse de la référence", async () => {
    const tx = await normaliser({ operation_type: "qonto_fee", reference: "FX_CARD" });
    expect(tx.isFx).toBe(true);
  });

  it("ne marque pas FX un frais Qonto sans référence fx", async () => {
    const tx = await normaliser({
      operation_type: "qonto_fee",
      reference: "monthly subscription",
      local_currency: "EUR",
    });
    expect(tx.isFx).toBe(false);
  });

  it("ne marque pas FX une référence fx portée par une opération non-frais", async () => {
    const tx = await normaliser({ operation_type: "card", reference: "fx", local_currency: "EUR" });
    expect(tx.isFx).toBe(false);
  });

  it("marque FX toute devise locale différente de l'euro", async () => {
    const tx = await normaliser({ local_currency: "USD" });
    expect(tx.isFx).toBe(true);
    expect(tx.localCurrency).toBe("USD");
  });

  it("ne marque pas FX une transaction en euros sans référence", async () => {
    const tx = await normaliser({ reference: undefined, local_currency: "EUR" });
    expect(tx.isFx).toBe(false);
  });

  it("prend la valeur absolue du montant", async () => {
    expect((await normaliser({ amount: -99.5 })).amount).toBe(99.5);
    expect((await normaliser({ amount: 99.5 })).amount).toBe(99.5);
  });

  it("convertit amount_cents en euros quand amount est absent", async () => {
    const tx = await normaliser({ amount: undefined, amount_cents: -12_345 });
    expect(tx.amount).toBe(123.45);
  });

  it("retombe sur 0 quand aucun montant n'est exploitable", async () => {
    const tx = await normaliser({ amount: undefined, amount_cents: undefined });
    expect(tx.amount).toBe(0);
  });

  it("préfère clean_counterparty_name au label, et rogne les espaces", async () => {
    expect((await normaliser({ clean_counterparty_name: "  Stripe  " })).merchant).toBe(
      "Stripe",
    );
    expect(
      (await normaliser({ clean_counterparty_name: undefined, label: " OVH " })).merchant,
    ).toBe("OVH");
    expect(
      (await normaliser({ clean_counterparty_name: undefined, label: undefined })).merchant,
    ).toBe("inconnu");
  });

  it("réduit la date à YYYY-MM-DD et retombe sur emitted_at", async () => {
    expect((await normaliser({})).date).toBe("2026-07-01");
    expect(
      (await normaliser({ settled_at: undefined, emitted_at: "2026-06-15T23:00:00Z" })).date,
    ).toBe("2026-06-15");
    expect((await normaliser({ settled_at: undefined, emitted_at: undefined })).date).toBe("");
  });

  it("compose un identifiant de repli à partir du label et de la date", async () => {
    const tx = await normaliser({ transaction_id: undefined, id: undefined, label: "OVH" });
    expect(tx.id).toBe("OVH-2026-07-01T09:30:00.000Z");
  });

  it("préfère transaction_id à id", async () => {
    expect((await normaliser({ transaction_id: "tx-9", id: "autre" })).id).toBe("tx-9");
    expect((await normaliser({ transaction_id: undefined, id: "id-9" })).id).toBe("id-9");
  });

  it("ne retient « credit » que si le côté est explicitement crédit", async () => {
    expect((await normaliser({ side: "credit" })).side).toBe("credit");
    expect((await normaliser({ side: "debit" })).side).toBe("debit");
    expect((await normaliser({ side: undefined })).side).toBe("debit");
  });

  it("retombe sur « unknown » pour un type d'opération absent", async () => {
    expect((await normaliser({ operation_type: undefined })).operationType).toBe("unknown");
  });

  it("expose l'état des justificatifs (base du levier TVA)", async () => {
    const sans = await normaliser({ attachment_required: true, attachment_ids: [] });
    expect(sans.attachmentRequired).toBe(true);
    expect(sans.hasAttachment).toBe(false);

    const avec = await normaliser({ attachment_required: true, attachment_ids: ["a1"] });
    expect(avec.hasAttachment).toBe(true);

    const neutre = await normaliser({
      attachment_required: undefined,
      attachment_ids: undefined,
    });
    expect(neutre.attachmentRequired).toBe(false);
    expect(neutre.hasAttachment).toBe(false);
  });

  it("normalise une page entière en conservant l'ordre", async () => {
    faux.mockResolvedValue(
      page(
        [
          brute({ transaction_id: "a", amount: -10 }),
          brute({ transaction_id: "b", amount: -20, local_currency: "USD" }),
        ],
        null,
      ),
    );
    const txs = await listTransactions(AUTH, 90);
    expect(txs.map((t) => [t.id, t.amount, t.isFx])).toEqual([
      ["a", 10, false],
      ["b", 20, true],
    ]);
  });
});

describe("erreurs HTTP", () => {
  it("lève TokenExpiredError sur 401 (déclencheur de refresh)", async () => {
    faux.mockResolvedValue(reponse({ error: "unauthorized" }, 401));

    const echec = getOrganization(AUTH);
    await expect(echec).rejects.toBeInstanceOf(TokenExpiredError);
    await expect(echec).rejects.toThrow(/Jeton Qonto expiré ou révoqué/);
  });

  it("expose le chemin fautif dans TokenExpiredError", async () => {
    faux.mockResolvedValue(reponse({}, 401));
    try {
      await listTransactions(AUTH, 90);
      expect.unreachable("aurait dû lever");
    } catch (e) {
      expect(e).toBeInstanceOf(TokenExpiredError);
      expect((e as TokenExpiredError).path).toContain("/transactions?");
    }
  });

  it("lève TokenExpiredError dès la première page paginée", async () => {
    faux.mockResolvedValue(reponse({}, 401));
    await expect(listTransactions(AUTH, 90)).rejects.toBeInstanceOf(TokenExpiredError);
    expect(faux).toHaveBeenCalledTimes(1);
  });

  it("lève QontoReadError sur les autres statuts, message en français", async () => {
    faux.mockResolvedValue(reponse({}, 500, "boom côté Qonto"));

    try {
      await getOrganization(AUTH);
      expect.unreachable("aurait dû lever");
    } catch (e) {
      expect(e).toBeInstanceOf(QontoReadError);
      const erreur = e as QontoReadError;
      expect(erreur.status).toBe(500);
      expect(erreur.path).toBe("/organization");
      expect(erreur.message).toBe("Qonto 500 sur /organization : boom côté Qonto");
    }
  });

  it("distingue 403 (droits insuffisants) de 401 (jeton expiré)", async () => {
    faux.mockResolvedValue(reponse({}, 403, "forbidden"));
    await expect(getOrganization(AUTH)).rejects.toBeInstanceOf(QontoReadError);
    await expect(getOrganization(AUTH)).rejects.not.toBeInstanceOf(TokenExpiredError);
  });

  it("tronque le corps d'erreur à 200 caractères", async () => {
    faux.mockResolvedValue(reponse({}, 502, "x".repeat(500)));
    try {
      await getOrganization(AUTH);
      expect.unreachable("aurait dû lever");
    } catch (e) {
      expect((e as QontoReadError).message).toHaveLength(
        "Qonto 502 sur /organization : ".length + 200,
      );
    }
  });
});
