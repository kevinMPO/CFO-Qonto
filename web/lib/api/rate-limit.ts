// ---------------------------------------------------------------------------
// Limitation de débit par IP des routes PAYANTES (/api/benchmark, /api/letter,
// /api/voice).
//
// Le problème qu'elle ferme : ces trois routes déclenchent des appels facturés
// (Linkup, Anthropic, ElevenLabs) et sont ouvertes au public — la page /demo
// doit rester utilisable par un visiteur qui n'a JAMAIS connecté Qonto. Exiger
// une session casserait la démo, donc la porte reste ouverte ; ce module se
// contente d'en border le débit. Sans lui, une boucle `curl` anonyme vide le
// budget API du propriétaire en quelques minutes.
//
// Deux compteurs cumulatifs, par IP et par route :
//   (a) RAFALE — fenêtre courte, tenue en mémoire de l'isolat. Instantanée,
//       gratuite, elle absorbe le martèlement d'un script.
//   (b) QUOTA — fenêtre longue, tenue dans le KV. Elle survit au recyclage des
//       isolats et se partage entre eux, donc elle borne l'abus DURABLE.
// Le compte retenu est le MAXIMUM des deux sources : la mémoire ne peut que
// durcir le verdict du KV, jamais l'adoucir.
//
// Honnêteté sur la garantie : le KV est éventuellement cohérent (une lecture
// peut être servie depuis un cache jusqu'à ~60 s). Une rafale distribuée sur
// plusieurs colos peut donc dépasser le quota le temps d'une fenêtre de cache.
// C'est un plafond souple, pas un compteur exact — il transforme « budget
// illimité » en « quelques dizaines d'appels par heure et par IP », ce qui est
// l'objectif. Le durcissement suivant, hors de ce module, est le binding
// natif `[[ratelimit]]` de Cloudflare, à déclarer dans `wrangler.jsonc`.
//
// Aucune PII n'est écrite : la clé KV ne contient que le nom du seau, la
// fenêtre et un HACHAGE tronqué de l'IP (règle non négociable n°3).
// ---------------------------------------------------------------------------

import type { KvNamespaceLike } from "@/lib/auth/token-store";
import { bindingsArgentier } from "@/lib/runtime/bindings";

/** Une fenêtre glissante-par-paliers : `max` requêtes toutes les `secondes`. */
export interface Fenetre {
  /** Nombre de requêtes tolérées dans la fenêtre. */
  max: number;
  /** Largeur de la fenêtre, en secondes. */
  secondes: number;
}

/** Réponse du contrôle de débit. */
export interface Verdict {
  /** Faux : la requête doit être refusée en 429. */
  autorise: boolean;
  /** Plafond de la fenêtre la plus contraignante pour cette requête. */
  limite: number;
  /** Requêtes encore disponibles dans cette fenêtre (0 si refusé). */
  restant: number;
  /** Secondes avant réouverture — valeur de l'en-tête `Retry-After`. */
  retryApres: number;
}

/** Plancher de TTL imposé par Cloudflare KV (60 s). */
const TTL_MINIMUM_SECONDES = 60;

/**
 * Plafonds par route. Calibrés sur l'usage réel de /demo, mesuré sur le
 * parcours complet : un visiteur écoute la voix une fois, benchmarke deux ou
 * trois leviers et prépare une ou deux lettres. Les valeurs ci-dessous laissent
 * un ordre de grandeur de marge à un utilisateur curieux, et coupent net une
 * boucle automatisée.
 */
export const PLAFONDS: Readonly<Record<string, readonly Fenetre[]>> = Object.freeze({
  // ElevenLabs facture au caractère et la narration fait ~2500 signes :
  // c'est la route la plus chère à l'appel, donc la plus serrée.
  voice: Object.freeze([
    { max: 3, secondes: 60 },
    { max: 20, secondes: 3600 },
  ]),
  // Linkup + Anthropic, plusieurs secondes de recherche web par appel.
  benchmark: Object.freeze([
    { max: 5, secondes: 60 },
    { max: 40, secondes: 3600 },
  ]),
  // Anthropic seul, réponse courte : la plus tolérante des trois.
  letter: Object.freeze([
    { max: 8, secondes: 60 },
    { max: 60, secondes: 3600 },
  ]),
  // CompanyRiskAgent : plusieurs recherches Linkup + 2 appels Anthropic par
  // analyse d'entreprise — la plus lourde, donc serrée.
  risk: Object.freeze([
    { max: 3, secondes: 60 },
    { max: 20, secondes: 3600 },
  ]),
});

/**
 * IP de l'appelant.
 *
 * `CF-Connecting-IP` est posé par l'edge Cloudflare et ÉCRASE toute valeur
 * fournie par le client : c'est la seule source non falsifiable, et c'est celle
 * de la production. Les replis `X-Real-IP` / `X-Forwarded-For` ne valent que
 * pour les autres hébergements ; ils sont falsifiables, donc dégradés — un
 * attaquant qui les forge se répartit sur autant de seaux qu'il invente
 * d'adresses. On l'accepte : la cible de déploiement est Cloudflare.
 *
 * Sans aucun en-tête (dev local, tests), tout le monde partage le seau
 * « inconnue ». C'est volontaire : pas d'IP identifiable ne doit jamais
 * signifier pas de limite.
 */
export function ipDemandeur(requete: Request): string {
  const entetes = requete.headers;
  const cloudflare = entetes.get("cf-connecting-ip");
  if (cloudflare?.trim()) return cloudflare.trim();

  const reel = entetes.get("x-real-ip");
  if (reel?.trim()) return reel.trim();

  const transmis = entetes.get("x-forwarded-for");
  const premier = transmis?.split(",")[0]?.trim();
  if (premier) return premier;

  return "inconnue";
}

/**
 * Empreinte courte et stable d'une IP (FNV-1a 32 bits, en hexadécimal).
 * Objectif : ne jamais écrire une adresse en clair dans un stockage partagé.
 * Ce n'est PAS un hachage cryptographique — il n'a pas à l'être : il protège
 * contre la lecture accidentelle, pas contre un adversaire qui aurait déjà
 * accès au KV. Synchrone, donc utilisable sans await, et sans `node:crypto`.
 */
function empreinteIp(ip: string): string {
  let hachage = 0x811c9dc5;
  for (let i = 0; i < ip.length; i++) {
    hachage ^= ip.charCodeAt(i);
    hachage = Math.imul(hachage, 0x01000193);
  }
  return (hachage >>> 0).toString(16).padStart(8, "0");
}

/** Compteurs en mémoire de l'isolat : clé de fenêtre → compte + péremption. */
const compteursMemoire = new Map<string, { compte: number; expireA: number }>();

/** Au-delà, on purge les entrées périmées : la carte ne doit pas enfler. */
const TAILLE_AVANT_PURGE = 5000;

/** Purge les fenêtres périmées. Appelée seulement quand la carte grossit. */
function purger(maintenant: number): void {
  for (const [cle, valeur] of compteursMemoire) {
    if (valeur.expireA <= maintenant) compteursMemoire.delete(cle);
  }
}

/** Incrémente le compteur mémoire de la fenêtre et rend le nouveau compte. */
function incrementerMemoire(cle: string, expireA: number, maintenant: number): number {
  if (compteursMemoire.size > TAILLE_AVANT_PURGE) purger(maintenant);

  const existant = compteursMemoire.get(cle);
  if (!existant || existant.expireA <= maintenant) {
    compteursMemoire.set(cle, { compte: 1, expireA });
    return 1;
  }
  existant.compte += 1;
  return existant.compte;
}

/** Vrai si l'objet se comporte comme un KVNamespace exploitable. */
function estKvNamespace(valeur: unknown): valeur is KvNamespaceLike {
  if (!valeur || typeof valeur !== "object") return false;
  const candidat = valeur as Partial<KvNamespaceLike>;
  return typeof candidat.get === "function" && typeof candidat.put === "function";
}

/** L'avertissement « pas de KV » ne doit sortir qu'une fois par process. */
let kvManquantSignale = false;

/** KV de comptage, ou `null` hors Cloudflare (le limiteur reste mémoire seule). */
function kvDebit(): KvNamespaceLike | null {
  const binding = bindingsArgentier().ARGENTIER_TOKENS;
  if (estKvNamespace(binding)) return binding;

  if (!kvManquantSignale) {
    kvManquantSignale = true;
    console.warn(
      "[argentier][debit] Binding KV ARGENTIER_TOKENS absent : la limitation de " +
        "débit ne tient plus que dans la mémoire de l'isolat, donc elle est " +
        "remise à zéro à chaque redémarrage et n'est pas partagée. Acceptable " +
        "en dev local uniquement.",
    );
  }
  return null;
}

/**
 * Contrôle le débit d'une requête et le COMPTABILISE (l'appel n'est pas
 * idempotent : chaque invocation consomme une unité).
 *
 * Rend le verdict de la fenêtre la plus contraignante. Une fenêtre déjà pleine
 * n'écrit rien dans le KV : refuser doit rester gratuit, sinon le refus lui-même
 * devient un levier d'abus.
 */
export async function verifierDebit(
  requete: Request,
  seau: string,
  fenetres: readonly Fenetre[] = PLAFONDS[seau] ?? [],
  maintenant: number = Date.now(),
): Promise<Verdict> {
  if (fenetres.length === 0) {
    throw new Error(
      `Seau de limitation « ${seau} » inconnu : aucun plafond n'est défini pour ` +
        "cette route. Ajoute-le dans PLAFONDS plutôt que de laisser passer.",
    );
  }

  const empreinte = empreinteIp(ipDemandeur(requete));
  const kv = kvDebit();

  let verdict: Verdict | null = null;

  for (const fenetre of fenetres) {
    const largeurMs = fenetre.secondes * 1000;
    const palier = Math.floor(maintenant / largeurMs);
    const expireA = (palier + 1) * largeurMs;
    const resteS = Math.max(1, Math.ceil((expireA - maintenant) / 1000));
    const cle = `argentier:debit:v1:${seau}:${fenetre.secondes}:${palier}:${empreinte}`;

    const enMemoire = incrementerMemoire(cle, expireA, maintenant);

    // Le KV ne peut que RENFORCER la mémoire : on retient le plus grand des
    // deux comptes, jamais le plus petit.
    let compte = enMemoire;
    if (kv && fenetre.secondes >= TTL_MINIMUM_SECONDES) {
      const stocke = Number.parseInt((await kv.get(cle)) ?? "", 10);
      if (Number.isFinite(stocke) && stocke + 1 > compte) compte = stocke + 1;
    }

    const depasse = compte > fenetre.max;

    if (kv && !depasse && fenetre.secondes >= TTL_MINIMUM_SECONDES) {
      // `expirationTtl` cale la péremption sur la fin du palier : la clé
      // disparaît d'elle-même, aucun ménage à faire.
      await kv
        .put(cle, String(compte), {
          expirationTtl: Math.max(TTL_MINIMUM_SECONDES, resteS),
        })
        .catch((erreur: unknown) => {
          // Un KV en panne ne doit pas transformer une limite en erreur 500 :
          // on retombe sur le compteur mémoire, en le disant.
          console.error(
            "[argentier][debit] Écriture KV du compteur impossible :",
            erreur instanceof Error ? erreur.name : "erreur inconnue",
          );
        });
    }

    const candidat: Verdict = {
      autorise: !depasse,
      limite: fenetre.max,
      restant: Math.max(0, fenetre.max - compte),
      retryApres: resteS,
    };

    // On garde la fenêtre qui refuse ; à défaut, celle qui laisse le moins.
    if (depasse) return candidat;
    if (!verdict || candidat.restant < verdict.restant) verdict = candidat;
  }

  return verdict as Verdict;
}

/** Explication du refus, en français, affichable telle quelle dans l'UI. */
export function messageTropDeRequetes(verdict: Verdict): string {
  return (
    "Trop de requêtes depuis cette adresse : la démo publique est plafonnée " +
    `pour éviter que ses appels payants soient détournés. Réessaie dans ${verdict.retryApres} s.`
  );
}

/**
 * Réponse 429 normalisée. `supplement` permet à une route d'ajouter les champs
 * que son écran attend (ex. `letter`, `note`), pour que l'UI affiche une
 * explication plutôt qu'un blanc — le front lit le JSON sans regarder le statut.
 */
export function reponseTropDeRequetes(
  verdict: Verdict,
  supplement: Record<string, unknown> = {},
): Response {
  const message = messageTropDeRequetes(verdict);

  return Response.json(
    { error: "rate_limited", message, retryAfter: verdict.retryApres, ...supplement },
    {
      status: 429,
      headers: {
        "Retry-After": String(verdict.retryApres),
        "RateLimit-Limit": String(verdict.limite),
        "RateLimit-Remaining": "0",
        "RateLimit-Reset": String(verdict.retryApres),
        "Cache-Control": "no-store",
      },
    },
  );
}

/**
 * Remet les compteurs mémoire et l'avertissement à zéro.
 * RÉSERVÉ AUX TESTS : sans cela, les cas se contamineraient entre eux.
 */
export function __resetRateLimitForTests(): void {
  compteursMemoire.clear();
  kvManquantSignale = false;
}
