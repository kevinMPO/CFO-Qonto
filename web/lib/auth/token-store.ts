// ---------------------------------------------------------------------------
// Stockage des tokens OAuth Qonto, par organisation.
//
// Rôle : ranger un TokenSet quelque part où il survit à la requête, SANS jamais
// l'écrire en clair. Deux implémentations derrière la même interface :
//  - KvTokenStore    : Cloudflare KV, valeurs chiffrées AES-GCM (cf. crypto.ts),
//                      TTL calé sur la durée de vie du refresh token. C'est le
//                      SEUL stockage admis en production ;
//  - MemoryTokenStore: process-local, DÉVELOPPEMENT ET TESTS UNIQUEMENT. Rien
//                      n'y est chiffré, rien n'y expire, et la révocation n'y
//                      porte que sur l'instance qui répond.
//
// Point non négociable (cf. lib/runtime/bindings.ts) : hors développement,
// l'absence du binding KV ne dégrade PLUS en silence vers la mémoire — elle
// lève. Un jeton bancaire porteur de `request_transfers.write` qui vivrait en
// clair dans le tas d'une lambda, sans TTL et sans révocation inter-instances,
// n'est pas un « mode dégradé » : c'est la faille que ce fichier existe pour
// empêcher. Le chiffrement n'a de valeur que s'il est sur le SEUL chemin possible.
//
// `delete()` est la brique de RÉVOCATION : quand un utilisateur débranche son
// compte Qonto, il doit ne rien rester. Elle est donc totale (aucune trace
// résiduelle) et idempotente (rappelable sans erreur, même si rien n'existe).
//
// Le stockage ne sait rien de l'OAuth : le type TokenSet appartient à
// `lib/auth/oauth-client.ts` et n'est PAS redéfini ici — un seul contrat.
// ---------------------------------------------------------------------------

import type { TokenSet } from "@/lib/auth/oauth-client";
import { decryptJson, encryptJson } from "@/lib/auth/crypto";
import {
  BindingManquantError,
  estKvNamespace,
  modeDegradeAutorise,
} from "@/lib/runtime/bindings";

/**
 * Sous-ensemble d'un `KVNamespace` Cloudflare réellement utilisé ici.
 * On le décrit structurellement plutôt que d'importer `@cloudflare/workers-types`
 * (absent du paquet `web/`) : un vrai KVNamespace satisfait cette interface, et
 * un faux de test aussi.
 */
export interface KvNamespaceLike {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Contrat de stockage des tokens. `orgKey` identifie une organisation Qonto. */
export interface TokenStore {
  get(orgKey: string): Promise<TokenSet | null>;
  put(orgKey: string, tokens: TokenSet): Promise<void>;
  delete(orgKey: string): Promise<void>;
}

/** Environnement Workers susceptible de porter le binding KV. */
export interface TokenStoreEnv {
  ARGENTIER_TOKENS?: unknown;
}

/** Préfixe des clés KV — versionné, pour pouvoir changer de format sans collision. */
const PREFIXE_CLE = "argentier:tokens:v1:";

/**
 * Durée de vie présumée d'un refresh token Qonto (30 jours).
 * Le serveur d'autorisation ne renvoie AUCUNE date d'expiration pour le refresh
 * token : faute de champ, on borne nous-mêmes. Un TTL trop court reconnecte
 * l'utilisateur pour rien ; pas de TTL du tout garderait un secret indéfiniment.
 */
export const DUREE_REFRESH_SECONDES = 60 * 60 * 24 * 30;

/** Plancher de TTL imposé par Cloudflare KV (60 s). */
const TTL_MINIMUM_SECONDES = 60;

/**
 * TTL du secret, en secondes.
 * Avec refresh token : la durée de vie du refresh (c'est lui qui prolonge la
 * session). Sans refresh token : on ne garde rien au-delà de l'expiration de
 * l'access token, il serait inutilisable.
 */
export function ttlSeconds(tokens: TokenSet, now: number = Date.now()): number {
  const brut = tokens.refreshToken
    ? DUREE_REFRESH_SECONDES
    : Math.ceil((tokens.expiresAt - now) / 1000);
  return Math.max(TTL_MINIMUM_SECONDES, brut);
}

/** Normalise et valide l'identifiant d'organisation servant de clé. */
function cleDe(prefixe: string, orgKey: string): string {
  const propre = typeof orgKey === "string" ? orgKey.trim() : "";
  if (!propre) {
    throw new Error(
      "orgKey vide : impossible d'adresser les tokens d'une organisation sans " +
        "identifiant.",
    );
  }
  return `${prefixe}${propre}`;
}

/**
 * Stockage Cloudflare KV. La valeur écrite est TOUJOURS un blob chiffré : si
 * `ARGENTIER_TOKEN_KEY` manque, `put` lève plutôt que d'écrire en clair.
 */
export class KvTokenStore implements TokenStore {
  private readonly kv: KvNamespaceLike;
  private readonly prefixe: string;

  constructor(kv: KvNamespaceLike, prefixe: string = PREFIXE_CLE) {
    this.kv = kv;
    this.prefixe = prefixe;
  }

  async get(orgKey: string): Promise<TokenSet | null> {
    const blob = await this.kv.get(cleDe(this.prefixe, orgKey));
    if (!blob) return null;
    // Un échec de déchiffrement remonte volontairement : blob altéré ou clé
    // tournée, ça se corrige côté exploitant, ça ne se masque pas.
    return decryptJson<TokenSet>(blob);
  }

  async put(orgKey: string, tokens: TokenSet): Promise<void> {
    const cle = cleDe(this.prefixe, orgKey);
    const blob = await encryptJson(tokens);
    await this.kv.put(cle, blob, { expirationTtl: ttlSeconds(tokens) });
  }

  /** Révocation : suppression totale et idempotente (KV ne lève pas si absent). */
  async delete(orgKey: string): Promise<void> {
    await this.kv.delete(cleDe(this.prefixe, orgKey));
  }
}

/**
 * Stockage en mémoire du process — DÉVELOPPEMENT LOCAL ET TESTS UNIQUEMENT.
 *
 * Trois défauts assumés, qui interdisent la production et pour lesquels
 * `getTokenStore()` lève désormais plutôt que d'y retomber :
 *  1. rien n'est chiffré : le jeton bancaire réside en clair dans le tas ;
 *  2. rien n'expire : `ttlSeconds()` n'est pas appliqué, un refresh token
 *     survit jusqu'au recyclage du process ;
 *  3. la révocation ne porte que sur CETTE instance : sur un hébergeur
 *     multi-instances, les autres continuent de servir le jeton supprimé.
 */
export class MemoryTokenStore implements TokenStore {
  private readonly entrees = new Map<string, TokenSet>();

  async get(orgKey: string): Promise<TokenSet | null> {
    const trouve = this.entrees.get(cleDe("", orgKey));
    // Copie défensive : l'appelant ne doit pas pouvoir muter le contenu stocké.
    return trouve ? { ...trouve } : null;
  }

  async put(orgKey: string, tokens: TokenSet): Promise<void> {
    this.entrees.set(cleDe("", orgKey), { ...tokens });
  }

  /** Révocation : idempotente, `Map.delete` ne lève pas sur une clé absente. */
  async delete(orgKey: string): Promise<void> {
    this.entrees.delete(cleDe("", orgKey));
  }

  /** Nombre d'organisations en mémoire — utile aux tests et au diagnostic. */
  get taille(): number {
    return this.entrees.size;
  }
}

/**
 * Instance mémoire partagée du PROCESS, portée par `globalThis`.
 *
 * Pourquoi pas un simple `let` de module : en `next dev`, chaque route est
 * compilée et chargée comme un module distinct. Une variable de module donne
 * alors une Map par route — le callback OAuth rangeait le jeton dans la sienne
 * et `/api/analyze` en créait une autre, vide, ce qui rendait tout test local
 * de bout en bout impossible (session valide + jeton introuvable → 401).
 * `globalThis` survit à ces réinstanciations.
 *
 * Sans effet en production : le binding KV y est présent, donc ce repli n'est
 * jamais atteint (`getTokenStore` lève avant).
 */
const CLE_MEMOIRE = Symbol.for("argentier.tokenStore.memoire");

type PorteurMemoire = { [CLE_MEMOIRE]?: MemoryTokenStore | null };

function memoireGlobale(): MemoryTokenStore | null {
  return (globalThis as PorteurMemoire)[CLE_MEMOIRE] ?? null;
}

function poserMemoireGlobale(store: MemoryTokenStore | null): void {
  (globalThis as PorteurMemoire)[CLE_MEMOIRE] = store;
}

/**
 * Fabrique du stockage des jetons.
 *
 * - Binding `ARGENTIER_TOKENS` exploitable → `KvTokenStore` (chiffré, avec TTL).
 * - Binding absent ou malformé :
 *     · en développement / test → `MemoryTokenStore`, avec avertissement ;
 *     · en production           → `BindingManquantError`. Pas de repli, pas de
 *       `console.warn` noyé dans un log de démarrage : on refuse de manipuler
 *       un jeton bancaire qu'on ne saurait ni chiffrer, ni expirer, ni révoquer.
 *
 * Le contrôle de forme est volontairement le même qu'ailleurs (`estKvNamespace`,
 * dans `lib/runtime/bindings.ts`) : un binding mal orthographié dans
 * `wrangler.jsonc` doit produire le MÊME refus qu'un binding absent, et non un
 * repli silencieux en clair.
 *
 * `env` vient typiquement de `bindingsArgentier()`.
 */
export function getTokenStore(env?: TokenStoreEnv): TokenStore {
  const binding =
    env?.ARGENTIER_TOKENS ??
    (globalThis as { ARGENTIER_TOKENS?: unknown }).ARGENTIER_TOKENS;

  if (estKvNamespace(binding)) return new KvTokenStore(binding);

  if (!modeDegradeAutorise()) {
    throw new BindingManquantError(
      "ARGENTIER_TOKENS",
      "les jetons OAuth Qonto seraient gardés en MÉMOIRE, en clair, sans " +
        "expiration et sans révocation possible d'une instance à l'autre.",
    );
  }

  let memoire = memoireGlobale();
  if (!memoire) {
    memoire = new MemoryTokenStore();
    poserMemoireGlobale(memoire);
    console.warn(
      "[argentier] Binding KV ARGENTIER_TOKENS absent : les tokens OAuth sont " +
        "gardés en MÉMOIRE, en clair, et perdus au redémarrage. Acceptable en " +
        "dev local uniquement — configure le binding avant tout déploiement.",
    );
  }
  return memoire;
}

/**
 * Remet la fabrique à zéro (instance mémoire + avertissement).
 * RÉSERVÉ AUX TESTS : permet de vérifier le repli mémoire sans dépendre de
 * l'ordre d'exécution des cas.
 */
export function __resetTokenStoreForTests(): void {
  poserMemoireGlobale(null);
}
