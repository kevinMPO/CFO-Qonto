// ---------------------------------------------------------------------------
// Accès aux bindings Cloudflare (KV `ARGENTIER_TOKENS`, D1 `ARGENTIER_DB`).
//
// Rôle : donner au code applicatif un point d'accès UNIQUE aux ressources du
// Worker, et TRANCHER une bonne fois ce qu'il advient quand elles manquent.
//
// La règle, désormais : le mode dégradé (jetons en mémoire, aucun journal
// d'audit) est un confort de DÉVELOPPEMENT. En production il est INTERDIT, et
// son absence de binding lève `BindingManquantError` au lieu de se contenter
// d'un `console.warn`. Un secret bancaire en clair dans le tas et une lecture
// bancaire non traçable ne sont pas des « modes dégradés » : ce sont des
// incidents, et un incident se voit.
//
// Terrains d'exécution :
//   - Cloudflare Workers (OpenNext)  → les bindings sont là, rien ne lève ;
//   - `next dev` / tests unitaires   → aucun binding, mode dégradé AUTORISÉ ;
//   - production sans binding        → refus explicite, en français.
//
// Pourquoi lire un symbole global plutôt qu'importer `@opennextjs/cloudflare` :
// ce paquet est une dépendance de BUILD (wrangler, ast-grep…). L'importer dans
// une route l'embarquerait dans le bundle. Or son `getCloudflareContext()` ne
// fait que lire `globalThis[Symbol.for("__cloudflare-context__")]`, posé par
// l'entrypoint du Worker : on lit donc directement ce symbole. Zéro dépendance,
// zéro import, compatible Workers.
// ---------------------------------------------------------------------------

import type { D1Database } from "@/lib/db/tenant";
import type { KvNamespaceLike, TokenStoreEnv } from "@/lib/auth/token-store";

/** Bindings attendus dans `wrangler.jsonc`. `unknown` : on valide la forme. */
export interface BindingsArgentier extends TokenStoreEnv {
  /** KV : tokens OAuth chiffrés (cf. lib/auth/token-store.ts). */
  ARGENTIER_TOKENS?: unknown;
  /** D1 : socle multi-locataire (cf. lib/db/tenant.ts). */
  ARGENTIER_DB?: unknown;
}

/** Symbole posé par l'entrypoint OpenNext, en production comme en dev Wrangler. */
const SYMBOLE_CONTEXTE = Symbol.for("__cloudflare-context__");

/** Contexte Cloudflare tel qu'on l'exploite ici : rien d'autre que `env`. */
interface ContexteCloudflare {
  env?: Record<string, unknown>;
}

/**
 * Un binding indispensable manque alors que le mode dégradé est interdit.
 * Type distinct pour que les routes puissent répondre 503 « configuration
 * incomplète » plutôt que de confondre avec une panne applicative.
 */
export class BindingManquantError extends Error {
  /** Nom du binding attendu, tel qu'il figure dans `wrangler.jsonc`. */
  readonly binding: string;

  constructor(binding: string, consequence: string) {
    super(
      `Binding « ${binding} » absent en production : ${consequence} ` +
        `Vérifie sa déclaration dans wrangler.jsonc et son provisionnement ` +
        `sur Cloudflare. Pour travailler sans binding en local, positionne ` +
        `${NOM_ECHAPPATOIRE}=1 — jamais en production.`,
    );
    this.name = "BindingManquantError";
    this.binding = binding;
  }
}

/**
 * Échappatoire explicite, à ne poser QUE sur un poste de développement : elle
 * réautorise le mode dégradé même quand `NODE_ENV=production`. Elle existe pour
 * les cas légitimes (`next build` local, inspection d'un bundle de production),
 * jamais pour servir du trafic réel.
 */
export const NOM_ECHAPPATOIRE = "ARGENTIER_ALLOW_DEGRADED_BINDINGS";

/**
 * Le mode dégradé (stockage mémoire, absence de journal) est-il tolérable ?
 * Oui partout SAUF en production, et en production uniquement sur échappatoire
 * explicite. Lu à chaque appel : aucun cache, pour que les tests puissent
 * basculer d'un environnement à l'autre.
 */
export function modeDegradeAutorise(): boolean {
  if (process.env[NOM_ECHAPPATOIRE] === "1") return true;
  return process.env.NODE_ENV !== "production";
}

/**
 * Bindings disponibles pour la requête en cours. Rend un objet vide hors
 * Cloudflare — jamais `undefined`, pour que l'appelant n'ait pas à s'en méfier.
 * C'est l'accès BRUT : c'est aux accesseurs typés ci-dessous (`baseD1`,
 * `getTokenStore`) de décider si l'absence est acceptable.
 */
export function bindingsArgentier(): BindingsArgentier {
  const global = globalThis as Record<symbol, unknown> & Record<string, unknown>;
  const contexte = global[SYMBOLE_CONTEXTE] as ContexteCloudflare | undefined;
  const env = contexte?.env;

  return {
    // Repli sur le global : utile aux tests, qui peuvent poser un faux binding.
    ARGENTIER_TOKENS: env?.ARGENTIER_TOKENS ?? global.ARGENTIER_TOKENS,
    ARGENTIER_DB: env?.ARGENTIER_DB ?? global.ARGENTIER_DB,
  };
}

/** Vrai si la valeur se comporte comme un `D1Database` (contrôle structurel). */
export function estBaseD1(valeur: unknown): valeur is D1Database {
  return (
    !!valeur &&
    typeof valeur === "object" &&
    typeof (valeur as D1Database).prepare === "function"
  );
}

/**
 * Vrai si l'objet a la forme d'un `KVNamespace` exploitable.
 * Vit ici, aux côtés d'`estBaseD1` : un seul endroit pour « cet objet
 * ressemble-t-il à un binding ? », que `lib/auth/token-store.ts` importe.
 */
export function estKvNamespace(valeur: unknown): valeur is KvNamespaceLike {
  if (!valeur || typeof valeur !== "object") return false;
  const candidat = valeur as Partial<KvNamespaceLike>;
  return (
    typeof candidat.get === "function" &&
    typeof candidat.put === "function" &&
    typeof candidat.delete === "function"
  );
}

/**
 * Base D1 du Worker.
 *
 * En développement et en test : `null` quand elle n'est pas provisionnée —
 * l'analyse tourne alors sans journal d'audit, ce qui est admissible sur un
 * poste de travail.
 *
 * En production : LÈVE. Une lecture bancaire qui ne laisse aucune trace est
 * précisément ce qu'un DAF nous paie pour empêcher ; on refuse la lecture
 * plutôt que de la servir sans journal.
 */
export function baseD1(
  bindings: BindingsArgentier = bindingsArgentier(),
): D1Database | null {
  if (estBaseD1(bindings.ARGENTIER_DB)) return bindings.ARGENTIER_DB;
  if (modeDegradeAutorise()) return null;
  throw new BindingManquantError(
    "ARGENTIER_DB",
    "aucune lecture Qonto ne pourrait être journalisée (organisations et " +
      "journal d'audit resteraient vides).",
  );
}

/**
 * Variante de DIAGNOSTIC : rend `null` sans jamais lever, même en production.
 * Réservée aux surfaces qui se contentent de constater l'état du système (la
 * route `/api/auth/qonto/status`), jamais à celles qui lisent la banque.
 */
export function baseD1SiPresente(
  bindings: BindingsArgentier = bindingsArgentier(),
): D1Database | null {
  return estBaseD1(bindings.ARGENTIER_DB) ? bindings.ARGENTIER_DB : null;
}
