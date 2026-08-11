// ---------------------------------------------------------------------------
// Client OAuth 2.1 générique (authorization code + PKCE, client public).
//
// Rôle : construire l'URL d'autorisation, échanger le code contre des jetons,
// et rafraîchir ces jetons. Le module est AGNOSTIQUE du serveur : il ne connaît
// que l'objet `OAuthProvider` qu'on lui passe (cf. `providers.ts`). Aucune URL
// Qonto en dur ici — c'est ce qui permettra de basculer vers un client dédié
// en lecture seule par simple configuration.
//
// Deux points de spec appliqués :
//  - client PUBLIC : aucun `client_secret` n'est envoyé, jamais. PKCE S256 tient
//    lieu de preuve de possession.
//  - `resource` (RFC 8707), exigé par la spec MCP 2025-06-18 : il lie le jeton à
//    UNE ressource protégée, ce qui empêche qu'un jeton émis pour Argentier soit
//    rejoué contre un autre serveur.
//
// Hygiène : ni jeton, ni code, ni verifier ne doit finir dans un log. Les
// messages d'erreur ne reprennent que les champs `error` / `error_description`
// du serveur.
// ---------------------------------------------------------------------------

import { CODE_CHALLENGE_METHOD } from "@/lib/auth/pkce";
import type { OAuthProvider } from "@/lib/auth/providers";

/** Jeu de jetons normalisé, tel que le reste de l'application le manipule. */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Date d'expiration en epoch millisecondes (et non une durée relative). */
  expiresAt: number;
  scope?: string;
  tokenType: string;
}

/** Erreur OAuth renvoyée par le serveur d'autorisation (RFC 6749 §5.2). */
export class OAuthError extends Error {
  readonly error: string;
  readonly errorDescription?: string;
  readonly status?: number;

  constructor(error: string, errorDescription?: string, status?: number) {
    const detail = errorDescription ? ` — ${errorDescription}` : "";
    const code = status ? ` (HTTP ${status})` : "";
    super(`Erreur OAuth du serveur d'autorisation${code} : ${error}${detail}`);
    this.name = "OAuthError";
    this.error = error;
    this.errorDescription = errorDescription;
    this.status = status;
  }
}

/** Paramètres variables de l'URL d'autorisation. */
export interface AuthorizationUrlOptions {
  /** `code_challenge` S256 issu de `pkce.ts`. */
  codeChallenge: string;
  /** `state` anti-CSRF, à re-vérifier au callback. */
  state: string;
  /** Ressource RFC 8707 ; à défaut, celle du provider. */
  resource?: string;
  /** Paramètres additionnels (ex. `prompt`), rarement utiles. */
  extra?: Record<string, string>;
}

/**
 * Construit l'URL vers laquelle rediriger le navigateur pour lancer le flux.
 * Inclut `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`,
 * `code_challenge_method=S256`, `state`, `scope` et `resource`.
 */
export function buildAuthorizationUrl(
  provider: OAuthProvider,
  options: AuthorizationUrlOptions,
): string {
  if (!options.codeChallenge) {
    throw new Error("code_challenge manquant : PKCE S256 est obligatoire.");
  }
  if (!options.state) {
    throw new Error("state manquant : la protection anti-CSRF est obligatoire.");
  }
  if (!provider.clientId) {
    throw new Error(
      `Le provider OAuth "${provider.id}" n'a pas de client_id configuré.`,
    );
  }

  const url = new URL(provider.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", provider.redirectUri);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", CODE_CHALLENGE_METHOD);
  url.searchParams.set("state", options.state);

  if (provider.scopes.length > 0) {
    // Note : le proxy MCP de Qonto IGNORE ce paramètre (cf. providers.ts).
    url.searchParams.set("scope", provider.scopes.join(" "));
  }

  const resource = options.resource ?? provider.resource;
  if (resource) {
    url.searchParams.set("resource", resource);
  }

  for (const [cle, valeur] of Object.entries(options.extra ?? {})) {
    url.searchParams.set(cle, valeur);
  }

  return url.toString();
}

/** Paramètres de l'échange code → jetons. */
export interface ExchangeCodeOptions {
  /** Code d'autorisation reçu sur la `redirect_uri`. */
  code: string;
  /** `code_verifier` correspondant au challenge envoyé à l'autorisation. */
  codeVerifier: string;
  /** Ressource RFC 8707 ; à défaut, celle du provider. */
  resource?: string;
}

/** Échange le code d'autorisation contre un `TokenSet` (grant public + PKCE). */
export async function exchangeCodeForTokens(
  provider: OAuthProvider,
  options: ExchangeCodeOptions,
): Promise<TokenSet> {
  if (!options.code) {
    throw new Error("Code d'autorisation manquant : échange impossible.");
  }
  if (!options.codeVerifier) {
    throw new Error("code_verifier manquant : échange PKCE impossible.");
  }

  const corps = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: provider.redirectUri,
    client_id: provider.clientId,
    code_verifier: options.codeVerifier,
  });

  const resource = options.resource ?? provider.resource;
  if (resource) corps.set("resource", resource);

  return postTokenEndpoint(provider, corps);
}

/** Options du rafraîchissement. */
export interface RefreshOptions {
  /** Ressource RFC 8707 ; à défaut, celle du provider. */
  resource?: string;
}

/** Rafraîchit un `TokenSet` à partir d'un refresh token. */
export async function refreshTokens(
  provider: OAuthProvider,
  refreshToken: string,
  options: RefreshOptions = {},
): Promise<TokenSet> {
  if (!refreshToken) {
    throw new Error("Refresh token manquant : rafraîchissement impossible.");
  }

  const corps = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: provider.clientId,
  });

  // Certains serveurs restreignent les scopes au refresh : on redemande
  // explicitement les mêmes, jamais davantage.
  if (provider.scopes.length > 0) {
    corps.set("scope", provider.scopes.join(" "));
  }

  const resource = options.resource ?? provider.resource;
  if (resource) corps.set("resource", resource);

  return postTokenEndpoint(provider, corps);
}

/** Réponse brute attendue du token endpoint (RFC 6749 §5.1 / §5.2). */
interface ReponseJetons {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
  error_description?: string;
}

/**
 * Durée de vie retenue quand le serveur n'envoie pas `expires_in` : une heure,
 * valeur prudente. Mieux vaut rafraîchir trop tôt que d'utiliser un jeton mort.
 */
const DUREE_VIE_PAR_DEFAUT_S = 3600;

/** POST form-urlencoded sur le token endpoint, sans `client_secret`. */
async function postTokenEndpoint(
  provider: OAuthProvider,
  corps: URLSearchParams,
): Promise<TokenSet> {
  let reponse: Response;
  try {
    reponse = await fetch(provider.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: corps.toString(),
      cache: "no-store",
    });
  } catch (cause) {
    throw new Error(
      `Serveur d'autorisation injoignable (${provider.id}) : la requête vers ` +
        `${provider.tokenEndpoint} a échoué.`,
      { cause },
    );
  }

  const texte = await reponse.text().catch(() => "");
  let charge: ReponseJetons | null = null;
  try {
    charge = texte ? (JSON.parse(texte) as ReponseJetons) : null;
  } catch {
    charge = null;
  }

  if (charge?.error) {
    throw new OAuthError(
      charge.error,
      charge.error_description,
      reponse.ok ? undefined : reponse.status,
    );
  }

  if (!reponse.ok) {
    throw new Error(
      `Le serveur d'autorisation (${provider.id}) a répondu ${reponse.status} ` +
        `sans erreur OAuth exploitable : ${texte.slice(0, 200)}`,
    );
  }

  if (!charge || typeof charge.access_token !== "string" || !charge.access_token) {
    throw new Error(
      `Réponse du serveur d'autorisation (${provider.id}) inexploitable : ` +
        "aucun access_token dans le corps.",
    );
  }

  return normaliserJetons(charge);
}

/**
 * Traduit la réponse brute en `TokenSet` (durée relative → epoch ms).
 *
 * Trois cas, et surtout PAS deux :
 *  - `expires_in` exploitable et strictement positif → on suit le serveur ;
 *  - `expires_in` absent ou illisible (`null`, `"abc"`, `Infinity`) → le
 *    serveur n'a rien dit, on applique la valeur prudente par défaut ;
 *  - `expires_in` <= 0 → le serveur AFFIRME que le jeton est déjà mort. Lui
 *    accorder une heure d'optimisme ferait sauter le rafraîchissement
 *    préventif : chaque appel Qonto partirait avec un jeton invalide, prendrait
 *    un 401 et brûlerait un refresh token. On pose donc `expiresAt = maintenant`,
 *    ce qui rend `tokenExpire()` vrai immédiatement et déclenche le refresh.
 */
function normaliserJetons(charge: ReponseJetons): TokenSet {
  const brut =
    typeof charge.expires_in === "string"
      ? Number.parseInt(charge.expires_in, 10)
      : charge.expires_in;
  const lisible = typeof brut === "number" && Number.isFinite(brut);
  const dureeVie = lisible ? Math.max(brut, 0) : DUREE_VIE_PAR_DEFAUT_S;

  return {
    accessToken: charge.access_token as string,
    refreshToken: charge.refresh_token || undefined,
    expiresAt: Date.now() + dureeVie * 1000,
    scope: charge.scope || undefined,
    tokenType: charge.token_type || "Bearer",
  };
}

/** Vrai si le jeton est expiré, ou expire dans moins de `margeS` secondes. */
export function tokenExpire(jetons: TokenSet, margeS = 60): boolean {
  return jetons.expiresAt - margeS * 1000 <= Date.now();
}
