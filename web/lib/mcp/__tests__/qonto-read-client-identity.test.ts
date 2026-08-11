// ---------------------------------------------------------------------------
// Tests de `getOrganizationIdentity` — l'accesseur qui rattache une connexion
// OAuth a un locataire.
//
// Ce qu'ils protegent : une cle de locataire inventee (deux clients qui
// partageraient le meme `org_id` verraient les memes donnees), et le fait que
// cette lecture reste UNE lecture — un seul GET, sur `/organization`.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getOrganizationIdentity } from "@/lib/mcp/qonto-read-client";

const AUTH = { accessToken: "jeton-de-test" };

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

beforeEach(() => {
  fetchInitial = globalThis.fetch;
  globalThis.fetch = faux as unknown as typeof fetch;
  faux.mockReset();
});

afterEach(() => {
  globalThis.fetch = fetchInitial;
});

describe("getOrganizationIdentity", () => {
  it("retient l'id de l'organisation quand l'API le fournit", async () => {
    faux.mockResolvedValue(
      reponse({
        organization: {
          id: "e2c1a0d4-1111-2222-3333-444455556666",
          slug: "croissant-9134",
          legal_name: "MAMFORMA",
          bank_accounts: [{ iban: "FR7616798000010000012345070", balance: 7646.5 }],
        },
      }),
    );

    await expect(getOrganizationIdentity(AUTH)).resolves.toEqual({
      qontoOrgId: "e2c1a0d4-1111-2222-3333-444455556666",
      name: "MAMFORMA",
      balance: 7646.5,
      iban: "FR7616798000010000012345070",
    });
  });

  it("retombe sur le slug quand l'API ne renvoie pas d'id", async () => {
    faux.mockResolvedValue(
      reponse({ organization: { slug: "croissant-9134", legal_name: "MAMFORMA" } }),
    );

    await expect(getOrganizationIdentity(AUTH)).resolves.toMatchObject({
      qontoOrgId: "croissant-9134",
    });
  });

  it("refuse de deviner une cle de locataire quand les deux manquent", async () => {
    faux.mockResolvedValue(reponse({ organization: { legal_name: "Sans identifiant" } }));

    await expect(getOrganizationIdentity(AUTH)).rejects.toThrow(
      /sans identifiant d'organisation/i,
    );
  });

  it("n'emet qu'un seul GET, sur /organization, avec un Bearer", async () => {
    faux.mockResolvedValue(reponse({ organization: { id: "org-1" } }));

    await getOrganizationIdentity(AUTH);

    expect(faux).toHaveBeenCalledTimes(1);
    const [url, init] = faux.mock.calls[0];
    expect(String(url)).toBe("https://thirdparty.qonto.com/v2/organization");
    expect((init as RequestInit).method).toBe("GET");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer jeton-de-test",
    });
  });

  it("exige un jeton : sans lui, rien ne part sur le reseau", async () => {
    await expect(getOrganizationIdentity({ accessToken: "" })).rejects.toThrow(
      /Jeton d'accès Qonto manquant/,
    );
    expect(faux).not.toHaveBeenCalled();
  });
});
