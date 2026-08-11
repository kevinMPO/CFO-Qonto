// ---------------------------------------------------------------------------
// Client Qonto LECTURE SEULE, authentifié par jeton OAuth (Bearer).
//
// Remplaçant de `lib/qonto.ts`, à règles métier IDENTIQUES : normalisation des
// transactions, pagination (per_page 100, garde-fou 20 pages), détection FX
// (`qonto_fee` + référence contenant « fx »), calcul des montants. Seul le mode
// d'authentification change : la clé statique « login:secret_key » du fondateur
// laisse place au jeton OAuth du visiteur, obtenu par le flux PKCE.
//
// Le jeton porte des scopes d'écriture qu'on ne peut pas refuser (le serveur
// d'autorisation impose sa liste). La lecture seule est donc garantie par
// `assertReadOnly`, et par le fait que ce module n'a qu'UNE SEULE sortie
// réseau : `requeteLecture`. Aucune autre fonction n'appelle `fetch` — c'est
// une invariante testée dans `__tests__/qonto-read-client.test.ts`.
// ---------------------------------------------------------------------------

import { assertReadOnly } from "@/lib/mcp/readonly-guard";
import type { Tx } from "@/lib/types";

/** Base de la Business API Qonto. Surchargeable par configuration (tests, sandbox). */
export const QONTO_API_BASE = "https://thirdparty.qonto.com/v2";

/**
 * Identité d'appel : un jeton d'accès OAuth, et l'IBAN du compte à analyser
 * quand l'organisation en a plusieurs. Rien d'autre — pas de secret partagé.
 */
export interface QontoAuth {
  accessToken: string;
  iban?: string;
}

/**
 * Réglages optionnels, injectés plutôt que codés en dur : le jour où Argentier
 * obtient un client OAuth dédié sur un autre hôte, on bascule par
 * configuration seule.
 */
export interface OptionsLecture {
  /** Base d'API. Doit être en HTTPS. Défaut : `QONTO_API_BASE`. */
  baseUrl?: string;
  /** Implémentation de `fetch` (tests, instrumentation). Défaut : celle du runtime. */
  fetch?: typeof fetch;
}

/** Le jeton est expiré ou révoqué (HTTP 401) : l'appelant doit rafraîchir. */
export class TokenExpiredError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `Jeton Qonto expiré ou révoqué (HTTP 401) sur « ${path} ». ` +
        `Rafraîchir le jeton puis réessayer.`,
    );
    this.name = "TokenExpiredError";
    this.path = path;
  }
}

/** Erreur d'API Qonto autre que 401. */
export class QontoReadError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, corps: string) {
    super(`Qonto ${status} sur ${path} : ${corps.slice(0, 200)}`);
    this.name = "QontoReadError";
    this.status = status;
    this.path = path;
  }
}

interface RawTx {
  transaction_id?: string;
  id?: string;
  amount?: number;
  amount_cents?: number;
  currency?: string;
  local_amount?: number;
  local_currency?: string;
  side?: "debit" | "credit";
  operation_type?: string;
  settled_at?: string;
  emitted_at?: string;
  label?: string;
  clean_counterparty_name?: string;
  reference?: string;
  attachment_required?: boolean;
  attachment_ids?: string[];
}

/** Valide et normalise la base d'API (HTTPS obligatoire, sans barre finale). */
function normaliserBase(baseUrl: string): string {
  if (!baseUrl.startsWith("https://")) {
    throw new Error(
      `Base d'API Qonto invalide : « ${baseUrl} » — HTTPS obligatoire.`,
    );
  }
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

/**
 * SEULE sortie réseau du module. Toute requête passe par ici, et `assertReadOnly`
 * est appelé AVANT le `fetch` : si la barrière lève, aucun octet ne part.
 * Ne pas contourner, ne pas dupliquer — ajouter un endpoint se fait en
 * élargissant l'allowlist de `readonly-guard.ts`, pas en appelant `fetch` ailleurs.
 */
async function requeteLecture<T>(
  auth: QontoAuth,
  path: string,
  options?: OptionsLecture,
): Promise<T> {
  // 1. Barrière read-only — avant toute chose.
  assertReadOnly("GET", path);

  // 2. Jeton présent ?
  if (!auth || typeof auth.accessToken !== "string" || auth.accessToken.trim() === "") {
    throw new Error("Jeton d'accès Qonto manquant : impossible d'appeler l'API.");
  }

  const base = normaliserBase(options?.baseUrl ?? QONTO_API_BASE);
  const executer = options?.fetch ?? globalThis.fetch;

  const res = await executer(`${base}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (res.status === 401) throw new TokenExpiredError(path);
  if (!res.ok) {
    const corps = await res.text().catch(() => "");
    throw new QontoReadError(res.status, path, corps);
  }
  return (await res.json()) as T;
}

/** Organisation brute, telle que la renvoie `/organization`. */
interface OrganisationBrute {
  id?: string;
  slug?: string;
  legal_name?: string;
  name?: string;
  bank_accounts?: Array<{ iban?: string; balance?: number; balance_cents?: number }>;
}

/**
 * Lecture unique de `/organization`, partagée par les deux accesseurs publics :
 * une seule requête réseau, une seule règle de choix du compte bancaire.
 */
async function lireOrganisation(
  auth: QontoAuth,
  options?: OptionsLecture,
): Promise<{ org: OrganisationBrute; iban?: string; balance: number }> {
  const data = await requeteLecture<{ organization?: OrganisationBrute }>(
    auth,
    "/organization",
    options,
  );

  const org = data.organization ?? {};
  const accounts = org.bank_accounts ?? [];
  const chosen =
    (auth.iban && accounts.find((a) => a.iban === auth.iban)) || accounts[0] || {};
  const balance =
    chosen.balance != null
      ? chosen.balance
      : chosen.balance_cents != null
        ? chosen.balance_cents / 100
        : 0;

  return { org, iban: chosen.iban ?? auth.iban, balance };
}

/** Compte + solde (get_organization). */
export async function getOrganization(
  auth: QontoAuth,
  options?: OptionsLecture,
): Promise<{
  name: string;
  balance: number;
  iban?: string;
}> {
  const { org, iban, balance } = await lireOrganisation(auth, options);

  return {
    name: org.legal_name || org.name || "Mon entreprise",
    balance,
    iban,
  };
}

/**
 * Identité de l'organisation : le même appel que `getOrganization`, plus
 * l'identifiant Qonto du compte.
 *
 * Pourquoi une fonction à part : cet identifiant sert UNIQUEMENT à rattacher la
 * connexion OAuth à un locataire (`organizations.qonto_org_id`). Il n'a rien à
 * faire dans la charge d'analyse, et surtout rien à faire dans une sortie web
 * (règle 3) — d'où deux surfaces distinctes plutôt qu'un champ optionnel qu'on
 * finirait par transporter partout par inadvertance.
 */
export async function getOrganizationIdentity(
  auth: QontoAuth,
  options?: OptionsLecture,
): Promise<{
  qontoOrgId: string;
  name: string;
  balance: number;
  iban?: string;
}> {
  const { org, iban, balance } = await lireOrganisation(auth, options);

  // `id` quand l'API le fournit, `slug` sinon : les deux sont stables et
  // uniques côté Qonto. Sans l'un des deux, on ne sait pas à quel locataire
  // rattacher les jetons — on refuse plutôt que d'inventer une clé.
  const qontoOrgId = String(org.id ?? org.slug ?? "").trim();
  if (!qontoOrgId) {
    throw new Error(
      "Réponse Qonto sans identifiant d'organisation : impossible d'identifier " +
        "le locataire, connexion refusée.",
    );
  }

  return {
    qontoOrgId,
    name: org.legal_name || org.name || "Mon entreprise",
    balance,
    iban,
  };
}

function isFxFee(raw: RawTx): boolean {
  return (
    raw.operation_type === "qonto_fee" &&
    String(raw.reference ?? "").toLowerCase().includes("fx")
  );
}

function normalize(raw: RawTx): Tx {
  const amount =
    raw.amount != null
      ? Math.abs(raw.amount)
      : raw.amount_cents != null
        ? Math.abs(raw.amount_cents) / 100
        : 0;
  const rawDate = raw.settled_at || raw.emitted_at || "";
  return {
    id: raw.transaction_id || raw.id || `${raw.label}-${rawDate}`,
    merchant: (raw.clean_counterparty_name || raw.label || "inconnu").trim(),
    amount,
    localCurrency: raw.local_currency || raw.currency || "EUR",
    isFx: isFxFee(raw) || (!!raw.local_currency && raw.local_currency !== "EUR"),
    side: raw.side === "credit" ? "credit" : "debit",
    operationType: raw.operation_type || "unknown",
    date: rawDate.slice(0, 10),
    attachmentRequired: !!raw.attachment_required,
    hasAttachment: (raw.attachment_ids?.length ?? 0) > 0,
  };
}

/** Garde-fou de pagination : 20 pages × 100 = 2000 transactions maximum. */
const MAX_PAGES = 20;

/** list_transactions paginé sur une fenêtre glissante. Filtre `settled_at`. */
export async function listTransactions(
  auth: QontoAuth,
  windowDays: number,
  options?: OptionsLecture,
): Promise<Tx[]> {
  const iban = auth.iban;
  const from = new Date(Date.now() - windowDays * 86_400_000).toISOString();

  const all: Tx[] = [];
  let page = 1;

  // On compte les ITÉRATIONS, pas le numéro de page renvoyé par l'API : le
  // garde-fou reste vrai même si `meta.next_page` est incohérent (une API qui
  // renverrait toujours le même numéro ferait boucler une condition `page <= 20`).
  for (let iteration = 0; iteration < MAX_PAGES; iteration++) {
    const params = new URLSearchParams({
      sort_by: "settled_at:desc",
      per_page: "100",
      current_page: String(page),
      settled_at_from: from,
    });
    if (iban) params.set("iban", iban);

    const data = await requeteLecture<{
      transactions?: RawTx[];
      meta?: { total_pages?: number; next_page?: number | null };
    }>(auth, `/transactions?${params.toString()}`, options);

    const txs = data.transactions ?? [];
    all.push(...txs.map(normalize));

    const next = data.meta?.next_page;
    if (!next || txs.length === 0) break;
    page = next;
  }

  return all;
}
