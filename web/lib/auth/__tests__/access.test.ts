// ---------------------------------------------------------------------------
// Tests du renouvellement de jeton (lib/auth/access.ts).
//
// Ce qu'ils protègent : un jeton bancaire mort qui traîne dans le stockage, un
// refresh token perdu au premier renouvellement (l'utilisateur devrait alors
// reconnecter son compte toutes les heures), et le silence en cas de refus du
// serveur. Le `fetch` est faux : aucun appel réseau réel.
//
// Et surtout, depuis l'audit, LA FRONTIÈRE ENTRE PANNE ET REFUS. Un refresh
// token supprimé ne revient pas : il faut un nouveau consentement du DAF. Les
// cas ci-dessous exigent donc que la purge soit réservée aux refus DÉFINITIFS du
// serveur d'autorisation, et que ni une coupure réseau, ni un 502, ni une course
// entre deux onglets ne fasse disparaître un secret encore valide.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { jetonValide, renouveler } from "@/lib/auth/access";
import type { TokenSet } from "@/lib/auth/oauth-client";
import { QONTO_MCP_PROXY } from "@/lib/auth/providers";
import { MemoryTokenStore } from "@/lib/auth/token-store";

const ORG = "org_test";

/** Jeton valide encore une heure. */
function jetonFrais(surcharge: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "acces-courant",
    refreshToken: "rafraichissement-courant",
    expiresAt: Date.now() + 3_600_000,
    tokenType: "Bearer",
    ...surcharge,
  };
}

/** Jeton déjà expiré. */
function jetonExpire(surcharge: Partial<TokenSet> = {}): TokenSet {
  return jetonFrais({ expiresAt: Date.now() - 1_000, ...surcharge });
}

/** Réponse JSON minimale du token endpoint. */
function reponse(corps: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
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

describe("jetonValide", () => {
  it("rend null quand aucun jeton n'est stocké", async () => {
    const store = new MemoryTokenStore();
    await expect(jetonValide(store, ORG, QONTO_MCP_PROXY)).resolves.toBeNull();
    expect(faux).not.toHaveBeenCalled();
  });

  it("rend le jeton tel quel s'il est encore valide (aucun appel réseau)", async () => {
    const store = new MemoryTokenStore();
    await store.put(ORG, jetonFrais());

    const jetons = await jetonValide(store, ORG, QONTO_MCP_PROXY);

    expect(jetons?.accessToken).toBe("acces-courant");
    expect(faux).not.toHaveBeenCalled();
  });

  it("rafraîchit un jeton expiré et réécrit le résultat dans le stockage", async () => {
    const store = new MemoryTokenStore();
    await store.put(ORG, jetonExpire());
    faux.mockResolvedValue(
      reponse({
        access_token: "acces-neuf",
        refresh_token: "rafraichissement-neuf",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    );

    const jetons = await jetonValide(store, ORG, QONTO_MCP_PROXY);

    expect(jetons?.accessToken).toBe("acces-neuf");
    expect(faux).toHaveBeenCalledTimes(1);
    expect(faux.mock.calls[0][0]).toBe(QONTO_MCP_PROXY.tokenEndpoint);
    // Réécrit : la requête suivante ne redemandera pas un rafraîchissement.
    await expect(store.get(ORG)).resolves.toMatchObject({
      accessToken: "acces-neuf",
      refreshToken: "rafraichissement-neuf",
    });
  });

  it("conserve l'ancien refresh token si le serveur n'en renvoie pas", async () => {
    const store = new MemoryTokenStore();
    await store.put(ORG, jetonExpire());
    faux.mockResolvedValue(
      reponse({ access_token: "acces-neuf", expires_in: 3600, token_type: "Bearer" }),
    );

    const jetons = await jetonValide(store, ORG, QONTO_MCP_PROXY);

    // Sans cette conservation, la session mourrait à l'expiration suivante.
    expect(jetons?.refreshToken).toBe("rafraichissement-courant");
    await expect(store.get(ORG)).resolves.toMatchObject({
      refreshToken: "rafraichissement-courant",
    });
  });

  it("purge le stockage quand un jeton expiré n'a pas de refresh token", async () => {
    const store = new MemoryTokenStore();
    await store.put(ORG, jetonExpire({ refreshToken: undefined }));

    await expect(jetonValide(store, ORG, QONTO_MCP_PROXY)).resolves.toBeNull();
    await expect(store.get(ORG)).resolves.toBeNull();
    expect(faux).not.toHaveBeenCalled();
  });

  it("purge le stockage quand le serveur d'autorisation refuse le renouvellement", async () => {
    const store = new MemoryTokenStore();
    await store.put(ORG, jetonExpire());
    faux.mockResolvedValue(reponse({ error: "invalid_grant" }, 400));

    await expect(jetonValide(store, ORG, QONTO_MCP_PROXY)).resolves.toBeNull();
    // Un secret mort ne reste pas dans le stockage.
    await expect(store.get(ORG)).resolves.toBeNull();
  });

  // Ce cas AFFIRMAIT l'inverse avant l'audit (« purge aussi quand le réseau
  // tombe »). Il figeait le pire comportement du module : dix minutes de 502
  // chez le serveur d'autorisation et TOUS les locataires qui passaient leur
  // marge d'expiration pendant la fenêtre perdaient définitivement leur refresh
  // token — une révocation de masse déclenchée par un incident tiers. L'attente
  // a été retournée, pas supprimée : la propriété testée est maintenant la bonne.
  it("CONSERVE les jetons quand le réseau tombe pendant le renouvellement", async () => {
    const store = new MemoryTokenStore();
    await store.put(ORG, jetonExpire());
    faux.mockRejectedValue(new Error("réseau injoignable"));

    // Pas de jeton utilisable pour CETTE requête...
    await expect(jetonValide(store, ORG, QONTO_MCP_PROXY)).resolves.toBeNull();
    // ...mais le secret est intact, et l'appel suivant réessaiera.
    await expect(store.get(ORG)).resolves.toMatchObject({
      refreshToken: "rafraichissement-courant",
    });
  });

  it("conserve les jetons sur un 5xx sans corps OAuth exploitable", async () => {
    const store = new MemoryTokenStore();
    await store.put(ORG, jetonExpire());
    faux.mockResolvedValue(reponse("passerelle en carafe", 502));

    await expect(jetonValide(store, ORG, QONTO_MCP_PROXY)).resolves.toBeNull();
    await expect(store.get(ORG)).resolves.not.toBeNull();
  });

  it("conserve les jetons sur une erreur OAuth qui n'est pas un refus définitif", async () => {
    const store = new MemoryTokenStore();
    await store.put(ORG, jetonExpire());
    // `temporarily_unavailable` : le serveur demande de réessayer, il ne
    // dénonce pas le jeton.
    faux.mockResolvedValue(reponse({ error: "temporarily_unavailable" }, 503));

    await expect(jetonValide(store, ORG, QONTO_MCP_PROXY)).resolves.toBeNull();
    await expect(store.get(ORG)).resolves.not.toBeNull();
  });

  it("purge sur invalid_client comme sur invalid_grant", async () => {
    const store = new MemoryTokenStore();
    await store.put(ORG, jetonExpire());
    faux.mockResolvedValue(reponse({ error: "invalid_client" }, 401));

    await expect(jetonValide(store, ORG, QONTO_MCP_PROXY)).resolves.toBeNull();
    await expect(store.get(ORG)).resolves.toBeNull();
  });
});

// --- Concurrence ------------------------------------------------------------
//
// Le scénario réel : deux onglets /demo, ou un rafraîchissement de page pendant
// une analyse lente, au moment où l'access token entre dans la marge de 60 s.
// Les deux requêtes lisent le MÊME TokenSet et POSTent le MÊME refresh token.

describe("renouveler — concurrence", () => {
  it("ne lance qu'un seul renouvellement pour deux appels simultanés", async () => {
    const store = new MemoryTokenStore();
    const courant = jetonExpire();
    await store.put(ORG, courant);

    // Réponse suspendue : les deux appels se croisent forcément.
    let debloquer: (() => void) | undefined;
    const attente = new Promise<void>((resoudre) => {
      debloquer = resoudre;
    });
    faux.mockImplementation(async () => {
      await attente;
      return reponse({ access_token: "acces-neuf", expires_in: 3600, token_type: "Bearer" });
    });

    const premier = renouveler(store, ORG, courant, QONTO_MCP_PROXY);
    const second = renouveler(store, ORG, courant, QONTO_MCP_PROXY);
    debloquer?.();
    const [a, b] = await Promise.all([premier, second]);

    // Un seul POST : le refresh token n'est joué qu'une fois.
    expect(faux).toHaveBeenCalledTimes(1);
    expect(a?.accessToken).toBe("acces-neuf");
    expect(b?.accessToken).toBe("acces-neuf");
  });

  it("libère la déduplication : un appel ultérieur repart bien vers le serveur", async () => {
    const store = new MemoryTokenStore();
    const courant = jetonExpire();
    faux.mockResolvedValue(
      reponse({ access_token: "acces-neuf", expires_in: 3600, token_type: "Bearer" }),
    );

    await renouveler(store, ORG, courant, QONTO_MCP_PROXY);
    await renouveler(store, ORG, courant, QONTO_MCP_PROXY);

    expect(faux).toHaveBeenCalledTimes(2);
  });

  it("n'efface pas les jetons frais qu'un appel concurrent vient d'écrire", async () => {
    const store = new MemoryTokenStore();
    const perime = jetonExpire();
    await store.put(ORG, perime);

    // Le gagnant de la course (autre isolat, autre instance) a déjà rangé un jeu
    // frais quand le serveur d'autorisation refuse NOTRE refresh token, désormais
    // à usage unique et déjà consommé.
    faux.mockImplementation(async () => {
      await store.put(ORG, jetonFrais({ accessToken: "acces-du-gagnant" }));
      return reponse({ error: "invalid_grant" }, 400);
    });

    const resultat = await renouveler(store, ORG, perime, QONTO_MCP_PROXY);

    // Avant correctif : `store.delete(orgId)` — le perdant déconnectait le
    // locataire en détruisant le travail du gagnant, sans aucune action hostile.
    expect(resultat?.accessToken).toBe("acces-du-gagnant");
    await expect(store.get(ORG)).resolves.toMatchObject({
      accessToken: "acces-du-gagnant",
    });
  });

  it("rend quand même les jetons frais si le stockage refuse de les écrire", async () => {
    // Le refresh token précédent est déjà consommé côté serveur : les détruire
    // ici perdrait le seul secret encore utilisable.
    const store = new MemoryTokenStore();
    const courant = jetonExpire();
    await store.put(ORG, courant);
    const put = vi
      .spyOn(store, "put")
      .mockRejectedValue(new Error("KV indisponible"));
    faux.mockResolvedValue(
      reponse({ access_token: "acces-neuf", expires_in: 3600, token_type: "Bearer" }),
    );

    const resultat = await renouveler(store, ORG, courant, QONTO_MCP_PROXY);

    expect(resultat?.accessToken).toBe("acces-neuf");
    put.mockRestore();
    // Rien n'a été purgé.
    await expect(store.get(ORG)).resolves.not.toBeNull();
  });
});

describe("renouveler", () => {
  it("force le renouvellement même si le jeton n'est pas encore expiré", async () => {
    const store = new MemoryTokenStore();
    const courant = jetonFrais();
    await store.put(ORG, courant);
    faux.mockResolvedValue(
      reponse({ access_token: "acces-force", expires_in: 3600, token_type: "Bearer" }),
    );

    // C'est le chemin du 401 : la date d'expiration disait « valide », Qonto non.
    const jetons = await renouveler(store, ORG, courant, QONTO_MCP_PROXY);

    expect(jetons?.accessToken).toBe("acces-force");
    expect(faux).toHaveBeenCalledTimes(1);
  });

  it("n'envoie jamais de client_secret (client public + PKCE)", async () => {
    const store = new MemoryTokenStore();
    const courant = jetonFrais();
    faux.mockResolvedValue(
      reponse({ access_token: "a", expires_in: 60, token_type: "Bearer" }),
    );

    await renouveler(store, ORG, courant, QONTO_MCP_PROXY);

    const corps = String((faux.mock.calls[0][1] as RequestInit).body);
    expect(corps).toContain("grant_type=refresh_token");
    expect(corps).toContain("client_id=");
    expect(corps).not.toContain("client_secret");
  });
});
