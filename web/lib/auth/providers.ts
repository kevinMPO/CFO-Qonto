// ---------------------------------------------------------------------------
// Description des serveurs d'autorisation OAuth 2.1 utilisables par Argentier.
//
// Rôle : concentrer ICI, et nulle part ailleurs, tout ce qui dépend d'un
// fournisseur donné (issuer, endpoints, client_id, scopes, redirect_uri). Le
// reste de la couche auth (`pkce.ts`, `oauth-client.ts`, les routes) est
// AGNOSTIQUE : il reçoit un `OAuthProvider` et n'a aucune constante en dur.
//
// Pourquoi c'est structurant : on code aujourd'hui contre le proxy MCP de
// Qonto, qui n'accorde pas de token restreint en lecture. Le jour où Qonto
// délivre à Argentier un client OAuth dédié avec uniquement des scopes `.read`,
// la bascule doit se faire par CONFIGURATION seule (une variable
// d'environnement), sans réécrire une ligne de logique.
// ---------------------------------------------------------------------------

/** Un serveur d'autorisation OAuth 2.1, décrit de façon complète et injectable. */
export interface OAuthProvider {
  /** Identifiant court, celui attendu dans `QONTO_OAUTH_PROVIDER`. */
  readonly id: string;
  /** `issuer` au sens RFC 8414 (métadonnées `/.well-known/...`). */
  readonly issuer: string;
  /** URL absolue de l'endpoint d'autorisation (redirection navigateur). */
  readonly authorizationEndpoint: string;
  /** URL absolue de l'endpoint de jetons (POST form-urlencoded). */
  readonly tokenEndpoint: string;
  /** URL absolue de l'enregistrement dynamique de client (RFC 7591), si offert. */
  readonly registrationEndpoint?: string;
  /** Client PUBLIC : aucun `client_secret` n'existe, PKCE tient lieu de preuve. */
  readonly clientId: string;
  /** URI de retour, doit correspondre exactement à celle déclarée au serveur. */
  readonly redirectUri: string;
  /** Scopes demandés. Certains serveurs les ignorent — voir chaque provider. */
  readonly scopes: string[];
  /**
   * Vrai si le token obtenu est intrinsèquement limité à la lecture.
   * FAUX = la lecture seule ne repose QUE sur l'allowlist applicative.
   */
  readonly readOnly: boolean;
  /**
   * Ressource protégée au sens RFC 8707 (`resource`), exigée par la spec MCP
   * 2025-06-18. Sert de valeur par défaut si l'appelant n'en fournit pas.
   */
  readonly resource?: string;
  /**
   * Vrai tant que le fournisseur n'est pas réellement délivré par Qonto : le
   * provider est décrit et prêt, mais pas encore utilisable en production.
   */
  readonly notYetAvailable?: boolean;
}

/**
 * Chemin de la route de callback OAuth. Exporté pour que la route Next.js et
 * la `redirect_uri` envoyée au serveur ne puissent pas diverger.
 */
export const CHEMIN_CALLBACK_OAUTH = "/api/auth/qonto/callback";

/** URL de base publique d'Argentier, sans slash final. */
export function baseUrlArgentier(): string {
  const brut = process.env.ARGENTIER_BASE_URL?.trim();
  const base = brut && brut.length > 0 ? brut : "http://localhost:3000";
  return base.replace(/\/+$/, "");
}

/** `redirect_uri` calculée depuis l'environnement (override possible en env). */
export function redirectUriArgentier(): string {
  const explicite = process.env.QONTO_OAUTH_REDIRECT_URI?.trim();
  if (explicite) return explicite;
  return `${baseUrlArgentier()}${CHEMIN_CALLBACK_OAUTH}`;
}

/**
 * Scopes de lecture dont Argentier a besoin, et rien de plus : lire
 * l'organisation, les comptes et leurs transactions pour l'audit de dépenses.
 * Aucun `.write`, jamais — même si le serveur choisit de les ignorer.
 * (Liste à confirmer avec Qonto le jour du client dédié.)
 */
const SCOPES_LECTURE_SEULE: string[] = [
  "organization.read",
  "bank_account.read",
  "transaction.read",
  "attachment.read",
  "membership.read",
];

/**
 * Proxy MCP de Qonto — le fournisseur utilisé AUJOURD'HUI.
 *
 * DEUX FAITS MESURÉS le 11 août 2026, contre le serveur réel. Le premier
 * corrige une erreur d'analyse antérieure, ne pas la réintroduire :
 *
 * 1. `GET /authorize` HONORE le paramètre `scope`. Envoyé avec
 *    `scope=organization.read bank_account.read transaction.read`, il redirige
 *    vers `oauth.qonto.com` avec EXACTEMENT ces trois scopes, zéro écriture.
 *    Ce n'est QUE lorsqu'aucun `scope` n'est transmis qu'il substitue son
 *    catalogue par défaut — 32 scopes dont 16 en écriture, `request_transfers.write`
 *    compris. Autrement dit : le silence vaut consentement à tout.
 *    → Toujours envoyer SCOPES_LECTURE_SEULE explicitement. Un jour où ce
 *      paramètre disparaîtrait de la requête, Argentier demanderait
 *      silencieusement des droits de virement.
 *
 * 2. `GET /authorize` REFUSE (400 « invalid redirect_uri ») toute URI qui
 *    n'est ni du loopback (`http://localhost:*`, `http://127.0.0.1:*`), ni
 *    inscrite dans sa liste blanche codée en dur (p. ex.
 *    `https://claude.ai/api/mcp/auth_callback`). Testé et refusé :
 *    `https://www.getargentier.com/...` et l'URL workers.dev.
 *    → Ce provider fonctionne en DÉVELOPPEMENT LOCAL uniquement. Une
 *      application web hébergée ne peut pas s'y connecter, quoi qu'elle
 *      demande. C'est le blocage réel, et l'objet de la demande adressée à
 *      Qonto (client OAuth dédié sur oauth.qonto.com).
 *
 * `readOnly` vaut `true` : les scopes demandés ne contiennent aucune écriture.
 * Cela ne dispense JAMAIS de l'allowlist applicative — la défense en
 * profondeur suppose que l'une des deux barrières puisse céder, et c'est le
 * périmètre du jeton qui dépend d'un tiers, pas notre allowlist.
 */
export const QONTO_MCP_PROXY: OAuthProvider = {
  id: "mcp-proxy",
  issuer: "https://mcp.qonto.com",
  authorizationEndpoint: "https://mcp.qonto.com/authorize",
  tokenEndpoint: "https://mcp.qonto.com/token",
  registrationEndpoint: "https://mcp.qonto.com/register",
  // Client public partagé renvoyé par le DCR — pas de client_secret, PKCE S256.
  clientId: "qonto-mcp-public",
  // Obligatoires : sans eux, Qonto accorde 16 scopes d'écriture (cf. ci-dessus).
  scopes: SCOPES_LECTURE_SEULE,
  readOnly: true,
  resource: "https://mcp.qonto.com/mcp",
  get redirectUri(): string {
    // Getter : l'environnement d'un Worker n'est lisible qu'à l'exécution.
    return redirectUriArgentier();
  },
};

/**
 * Qonto OAuth en direct, avec un client dédié à Argentier — la CIBLE.
 *
 * À activer le jour où Qonto délivre à Argentier un client OAuth propre,
 * restreint aux scopes `.read`. Ce jour-là, la bascule est purement de la
 * configuration : `QONTO_OAUTH_PROVIDER=direct-readonly` et
 * `QONTO_OAUTH_CLIENT_ID=<client délivré>`. Aucun code à réécrire.
 *
 * `readOnly: true` : le jeton lui-même est alors incapable d'écrire, et la
 * lecture seule cesse de dépendre uniquement de l'allowlist (qui reste en
 * place, en défense en profondeur).
 */
export const QONTO_DIRECT_READONLY: OAuthProvider = {
  id: "direct-readonly",
  issuer: "https://oauth.qonto.com",
  authorizationEndpoint: "https://oauth.qonto.com/oauth2/auth",
  tokenEndpoint: "https://oauth.qonto.com/oauth2/token",
  scopes: SCOPES_LECTURE_SEULE,
  readOnly: true,
  // Pas encore délivré par Qonto à ce jour (2026-08) : décrit, pas utilisable.
  notYetAvailable: true,
  get clientId(): string {
    return process.env.QONTO_OAUTH_CLIENT_ID?.trim() ?? "";
  },
  get redirectUri(): string {
    return redirectUriArgentier();
  },
};

/** Tous les providers connus, indexés par identifiant. */
export const PROVIDERS: Record<string, OAuthProvider> = {
  [QONTO_MCP_PROXY.id]: QONTO_MCP_PROXY,
  [QONTO_DIRECT_READONLY.id]: QONTO_DIRECT_READONLY,
};

/** Provider utilisé faute de configuration explicite. */
export const PROVIDER_PAR_DEFAUT: OAuthProvider = QONTO_MCP_PROXY;

/** Alias tolérés dans `QONTO_OAUTH_PROVIDER`, pour éviter les pièges de saisie. */
const ALIAS: Record<string, string> = {
  mcp: QONTO_MCP_PROXY.id,
  "mcp-proxy": QONTO_MCP_PROXY.id,
  "qonto-mcp": QONTO_MCP_PROXY.id,
  direct: QONTO_DIRECT_READONLY.id,
  "direct-readonly": QONTO_DIRECT_READONLY.id,
  "qonto-direct": QONTO_DIRECT_READONLY.id,
};

/**
 * Résout le provider actif d'après `QONTO_OAUTH_PROVIDER`.
 * Défaut : le proxy MCP. Une valeur inconnue est une erreur de configuration
 * et échoue BRUYAMMENT — on ne devine pas quel serveur d'autorisation utiliser.
 */
export function activeProvider(): OAuthProvider {
  const demande = process.env.QONTO_OAUTH_PROVIDER?.trim().toLowerCase();
  if (!demande) return PROVIDER_PAR_DEFAUT;

  const id = ALIAS[demande];
  const provider = id ? PROVIDERS[id] : undefined;
  if (!provider) {
    const connus = Object.keys(PROVIDERS).join(", ");
    throw new Error(
      `QONTO_OAUTH_PROVIDER="${demande}" est inconnu. Valeurs acceptées : ${connus}.`,
    );
  }

  if (!provider.clientId) {
    throw new Error(
      `Le provider OAuth "${provider.id}" n'a pas de client_id : renseigne ` +
        `QONTO_OAUTH_CLIENT_ID (client délivré par Qonto) avant de l'activer.`,
    );
  }

  return provider;
}
