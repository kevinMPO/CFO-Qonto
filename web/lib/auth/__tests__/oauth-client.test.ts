// ---------------------------------------------------------------------------
// Tests de `lib/auth/oauth-client.ts` (et de la résolution de provider).
// Rôle : garantir que le flux authorization code + PKCE est conforme et
// AGNOSTIQUE du serveur — un provider fictif suffit à tout exercer. On vérifie
// aussi qu'aucun `client_secret` ne part jamais sur le réseau (client public)
// et que les erreurs OAuth remontent en français, exploitables par l'UI.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  OAuthError,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  refreshTokens,
  tokenExpire,
} from "@/lib/auth/oauth-client";
import {
  QONTO_DIRECT_READONLY,
  QONTO_MCP_PROXY,
  activeProvider,
} from "@/lib/auth/providers";
import type { OAuthProvider } from "@/lib/auth/providers";

/** Provider de test : prouve que le client ne connaît aucune URL en dur. */
const PROVIDER_FICTIF: OAuthProvider = {
  id: "fictif",
  issuer: "https://auth.example.test",
  authorizationEndpoint: "https://auth.example.test/authorize",
  tokenEndpoint: "https://auth.example.test/token",
  clientId: "client-public-de-test",
  redirectUri: "https://argentier.test/api/auth/qonto/callback",
  scopes: ["organization.read", "transaction.read"],
  readOnly: true,
  resource: "https://api.example.test/mcp",
};

/** Fabrique une `Response` JSON minimale pour mocker `fetch`. */
function reponseJson(corps: unknown, status = 200): Response {
  return new Response(JSON.stringify(corps), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Corps du dernier appel `fetch`, décodé en paramètres form-urlencoded. */
function corpsEnvoye(mock: ReturnType<typeof vi.fn>): URLSearchParams {
  const [, init] = mock.mock.calls[0] as [string, RequestInit];
  return new URLSearchParams(String(init.body));
}

describe("buildAuthorizationUrl", () => {
  it("contient tous les paramètres exigés par OAuth 2.1 + PKCE + RFC 8707", () => {
    const url = new URL(
      buildAuthorizationUrl(PROVIDER_FICTIF, {
        codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        state: "etat-anti-csrf",
        resource: "https://mcp.example.test/mcp",
      }),
    );
    const p = url.searchParams;

    expect(url.origin + url.pathname).toBe(
      "https://auth.example.test/authorize",
    );
    expect(p.get("response_type")).toBe("code");
    expect(p.get("client_id")).toBe("client-public-de-test");
    expect(p.get("redirect_uri")).toBe(PROVIDER_FICTIF.redirectUri);
    expect(p.get("code_challenge")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("state")).toBe("etat-anti-csrf");
    expect(p.get("scope")).toBe("organization.read transaction.read");
    expect(p.get("resource")).toBe("https://mcp.example.test/mcp");
    // Client public : jamais de secret dans l'URL.
    expect(p.get("client_secret")).toBeNull();
  });

  it("retombe sur la ressource du provider si l'appelant n'en fournit pas", () => {
    const url = new URL(
      buildAuthorizationUrl(PROVIDER_FICTIF, {
        codeChallenge: "challenge",
        state: "state",
      }),
    );

    expect(url.searchParams.get("resource")).toBe(
      "https://api.example.test/mcp",
    );
  });

  it("échoue bruyamment sans challenge, sans state ou sans client_id", () => {
    expect(() =>
      buildAuthorizationUrl(PROVIDER_FICTIF, {
        codeChallenge: "",
        state: "s",
      }),
    ).toThrow(/code_challenge/);

    expect(() =>
      buildAuthorizationUrl(PROVIDER_FICTIF, {
        codeChallenge: "c",
        state: "",
      }),
    ).toThrow(/state/);

    expect(() =>
      buildAuthorizationUrl(
        { ...PROVIDER_FICTIF, clientId: "" },
        { codeChallenge: "c", state: "s" },
      ),
    ).toThrow(/client_id/);
  });

  it("vise bien le proxy MCP de Qonto quand c'est lui le provider", () => {
    const url = new URL(
      buildAuthorizationUrl(QONTO_MCP_PROXY, {
        codeChallenge: "c",
        state: "s",
      }),
    );

    expect(url.origin).toBe("https://mcp.qonto.com");
    expect(url.pathname).toBe("/authorize");
    expect(url.searchParams.get("client_id")).toBe("qonto-mcp-public");
    expect(url.searchParams.get("resource")).toBe("https://mcp.qonto.com/mcp");
  });
});

describe("exchangeCodeForTokens", () => {
  let faux: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    faux = vi.fn();
    vi.stubGlobal("fetch", faux);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("POSTe un formulaire conforme, sans client_secret", async () => {
    faux.mockResolvedValue(
      reponseJson({
        access_token: "jeton-acces",
        refresh_token: "jeton-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "organization.read",
      }),
    );

    await exchangeCodeForTokens(PROVIDER_FICTIF, {
      code: "code-recu",
      codeVerifier: "verifier-pkce",
      resource: "https://mcp.example.test/mcp",
    });

    const [url, init] = faux.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://auth.example.test/token");
    expect(init.method).toBe("POST");
    expect(
      (init.headers as Record<string, string>)["Content-Type"],
    ).toBe("application/x-www-form-urlencoded");

    const corps = corpsEnvoye(faux);
    expect(corps.get("grant_type")).toBe("authorization_code");
    expect(corps.get("code")).toBe("code-recu");
    expect(corps.get("code_verifier")).toBe("verifier-pkce");
    expect(corps.get("client_id")).toBe("client-public-de-test");
    expect(corps.get("redirect_uri")).toBe(PROVIDER_FICTIF.redirectUri);
    expect(corps.get("resource")).toBe("https://mcp.example.test/mcp");
    expect(corps.get("client_secret")).toBeNull();
  });

  it("normalise expires_in en date d'expiration epoch ms", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T10:00:00.000Z"));
    faux.mockResolvedValue(
      reponseJson({ access_token: "a", token_type: "Bearer", expires_in: 1800 }),
    );

    const jetons = await exchangeCodeForTokens(PROVIDER_FICTIF, {
      code: "c",
      codeVerifier: "v",
    });

    expect(jetons.expiresAt).toBe(Date.parse("2026-08-11T10:30:00.000Z"));
    expect(jetons.accessToken).toBe("a");
    expect(jetons.tokenType).toBe("Bearer");
    expect(jetons.refreshToken).toBeUndefined();
    expect(tokenExpire(jetons)).toBe(false);
  });

  it("accepte un expires_in envoyé en chaîne et comble son absence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T10:00:00.000Z"));

    faux.mockResolvedValueOnce(
      reponseJson({ access_token: "a", expires_in: "120" }),
    );
    const chaine = await exchangeCodeForTokens(PROVIDER_FICTIF, {
      code: "c",
      codeVerifier: "v",
    });
    expect(chaine.expiresAt).toBe(Date.parse("2026-08-11T10:02:00.000Z"));
    // `token_type` absent → Bearer par défaut.
    expect(chaine.tokenType).toBe("Bearer");

    faux.mockResolvedValueOnce(reponseJson({ access_token: "a" }));
    const sansDuree = await exchangeCodeForTokens(PROVIDER_FICTIF, {
      code: "c",
      codeVerifier: "v",
    });
    expect(sansDuree.expiresAt).toBe(Date.parse("2026-08-11T11:00:00.000Z"));
  });

  // Le serveur qui répond « expires_in: 0 » ne dit pas « je ne sais pas », il
  // dit « ce jeton est mort ». Lui offrir l'heure de la valeur par défaut, c'est
  // sauter le rafraîchissement préventif et partir en 401 à chaque lecture.
  it("traite un expires_in nul ou négatif comme un jeton DÉJÀ expiré", async () => {
    vi.useFakeTimers();
    const maintenant = Date.parse("2026-08-11T10:00:00.000Z");
    vi.setSystemTime(new Date(maintenant));

    for (const valeur of [0, -1, -3600, "0", "-120"]) {
      faux.mockResolvedValueOnce(
        reponseJson({ access_token: "a", refresh_token: "r", expires_in: valeur }),
      );
      const jetons = await exchangeCodeForTokens(PROVIDER_FICTIF, {
        code: "c",
        codeVerifier: "v",
      });

      expect(jetons.expiresAt, `expires_in=${valeur}`).toBe(maintenant);
      // La seule conséquence qui compte : le refresh préventif se déclenche.
      expect(tokenExpire(jetons), `expires_in=${valeur}`).toBe(true);
    }
  });

  // Symétrique du cas précédent : « je ne sais pas » reste « une heure ».
  it("garde la valeur prudente par défaut quand expires_in est illisible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T10:00:00.000Z"));

    for (const valeur of [null, undefined, "abc", "", {}]) {
      faux.mockResolvedValueOnce(
        reponseJson({ access_token: "a", expires_in: valeur }),
      );
      const jetons = await exchangeCodeForTokens(PROVIDER_FICTIF, {
        code: "c",
        codeVerifier: "v",
      });
      expect(jetons.expiresAt, `expires_in=${JSON.stringify(valeur)}`).toBe(
        Date.parse("2026-08-11T11:00:00.000Z"),
      );
      expect(tokenExpire(jetons)).toBe(false);
    }
  });

  it("transforme une erreur OAuth du serveur en OAuthError lisible", async () => {
    faux.mockResolvedValue(
      reponseJson(
        {
          error: "invalid_grant",
          error_description: "Le code d'autorisation a expiré.",
        },
        400,
      ),
    );

    const echec = exchangeCodeForTokens(PROVIDER_FICTIF, {
      code: "c",
      codeVerifier: "v",
    });

    await expect(echec).rejects.toBeInstanceOf(OAuthError);
    await expect(echec).rejects.toMatchObject({
      error: "invalid_grant",
      errorDescription: "Le code d'autorisation a expiré.",
      status: 400,
    });
    await expect(echec).rejects.toThrow(
      /Erreur OAuth du serveur d'autorisation \(HTTP 400\) : invalid_grant — Le code d'autorisation a expiré\./,
    );
  });

  it("signale un HTTP en erreur même sans corps OAuth exploitable", async () => {
    faux.mockResolvedValue(new Response("<html>502</html>", { status: 502 }));

    await expect(
      exchangeCodeForTokens(PROVIDER_FICTIF, { code: "c", codeVerifier: "v" }),
    ).rejects.toThrow(/a répondu 502/);
  });

  it("refuse une réponse 200 sans access_token", async () => {
    faux.mockResolvedValue(reponseJson({ token_type: "Bearer" }));

    await expect(
      exchangeCodeForTokens(PROVIDER_FICTIF, { code: "c", codeVerifier: "v" }),
    ).rejects.toThrow(/aucun access_token/);
  });

  it("signale en français un réseau qui tombe", async () => {
    faux.mockRejectedValue(new TypeError("fetch failed"));

    const echec = exchangeCodeForTokens(PROVIDER_FICTIF, {
      code: "c",
      codeVerifier: "v",
    });

    await expect(echec).rejects.toThrow(/injoignable/);
    await expect(echec).rejects.toThrow(/auth\.example\.test\/token/);
  });

  it("exige un code et un verifier avant d'appeler le réseau", async () => {
    await expect(
      exchangeCodeForTokens(PROVIDER_FICTIF, { code: "", codeVerifier: "v" }),
    ).rejects.toThrow(/Code d'autorisation manquant/);
    await expect(
      exchangeCodeForTokens(PROVIDER_FICTIF, { code: "c", codeVerifier: "" }),
    ).rejects.toThrow(/code_verifier manquant/);

    expect(faux).not.toHaveBeenCalled();
  });
});

describe("refreshTokens", () => {
  let faux: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    faux = vi.fn();
    vi.stubGlobal("fetch", faux);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTe grant_type=refresh_token sans client_secret", async () => {
    faux.mockResolvedValue(
      reponseJson({
        access_token: "nouveau",
        refresh_token: "rotation",
        expires_in: 900,
      }),
    );

    const jetons = await refreshTokens(PROVIDER_FICTIF, "ancien-refresh");

    const corps = corpsEnvoye(faux);
    expect(corps.get("grant_type")).toBe("refresh_token");
    expect(corps.get("refresh_token")).toBe("ancien-refresh");
    expect(corps.get("client_id")).toBe("client-public-de-test");
    expect(corps.get("scope")).toBe("organization.read transaction.read");
    expect(corps.get("resource")).toBe("https://api.example.test/mcp");
    expect(corps.get("client_secret")).toBeNull();

    // Rotation du refresh token prise en compte.
    expect(jetons.refreshToken).toBe("rotation");
    expect(jetons.accessToken).toBe("nouveau");
  });

  it("remonte l'erreur OAuth quand le refresh est révoqué", async () => {
    faux.mockResolvedValue(
      reponseJson(
        { error: "invalid_grant", error_description: "Jeton révoqué." },
        400,
      ),
    );

    await expect(refreshTokens(PROVIDER_FICTIF, "mort")).rejects.toMatchObject({
      error: "invalid_grant",
      errorDescription: "Jeton révoqué.",
    });
  });

  it("exige un refresh token avant d'appeler le réseau", async () => {
    await expect(refreshTokens(PROVIDER_FICTIF, "")).rejects.toThrow(
      /Refresh token manquant/,
    );

    expect(faux).not.toHaveBeenCalled();
  });
});

describe("tokenExpire", () => {
  it("anticipe l'expiration d'une marge de sécurité", () => {
    const dans30s = { accessToken: "a", tokenType: "Bearer", expiresAt: Date.now() + 30_000 };
    const dans10min = { accessToken: "a", tokenType: "Bearer", expiresAt: Date.now() + 600_000 };

    expect(tokenExpire(dans30s)).toBe(true);
    expect(tokenExpire(dans10min)).toBe(false);
  });
});

describe("providers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("dit la vérité sur la lecture seule de chaque provider", () => {
    // Le proxy MCP accorde des scopes d'écriture qu'on ne peut pas refuser :
    // si ce booléen passait à `true` un jour, l'allowlist applicative pourrait
    // être relâchée à tort. Ce test est là pour l'interdire.
    expect(QONTO_MCP_PROXY.readOnly).toBe(false);
    expect(QONTO_DIRECT_READONLY.readOnly).toBe(true);
    expect(QONTO_DIRECT_READONLY.notYetAvailable).toBe(true);
  });

  it("ne demande jamais un scope d'écriture", () => {
    for (const provider of [QONTO_MCP_PROXY, QONTO_DIRECT_READONLY]) {
      expect(provider.scopes.length).toBeGreaterThan(0);
      for (const scope of provider.scopes) {
        expect(scope).toMatch(/\.read$/);
      }
    }
  });

  it("choisit le proxy MCP par défaut", () => {
    vi.stubEnv("QONTO_OAUTH_PROVIDER", "");

    expect(activeProvider().id).toBe("mcp-proxy");
  });

  it("bascule vers le client dédié par simple configuration", () => {
    vi.stubEnv("QONTO_OAUTH_PROVIDER", "direct-readonly");
    vi.stubEnv("QONTO_OAUTH_CLIENT_ID", "client-dedie-argentier");

    const provider = activeProvider();

    expect(provider.id).toBe("direct-readonly");
    expect(provider.clientId).toBe("client-dedie-argentier");
    expect(provider.issuer).toBe("https://oauth.qonto.com");
  });

  it("refuse le client dédié tant que son client_id n'est pas fourni", () => {
    vi.stubEnv("QONTO_OAUTH_PROVIDER", "direct-readonly");
    vi.stubEnv("QONTO_OAUTH_CLIENT_ID", "");

    expect(() => activeProvider()).toThrow(/QONTO_OAUTH_CLIENT_ID/);
  });

  it("échoue bruyamment sur un provider inconnu", () => {
    vi.stubEnv("QONTO_OAUTH_PROVIDER", "un-serveur-au-hasard");

    expect(() => activeProvider()).toThrow(/inconnu/);
  });

  it("calcule la redirect_uri depuis ARGENTIER_BASE_URL", () => {
    vi.stubEnv("ARGENTIER_BASE_URL", "https://getargentier.com/");

    expect(QONTO_MCP_PROXY.redirectUri).toBe(
      "https://getargentier.com/api/auth/qonto/callback",
    );

    vi.stubEnv("ARGENTIER_BASE_URL", "");

    expect(QONTO_MCP_PROXY.redirectUri).toBe(
      "http://localhost:3000/api/auth/qonto/callback",
    );
  });
});
