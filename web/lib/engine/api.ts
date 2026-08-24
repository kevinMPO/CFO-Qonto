// ---------------------------------------------------------------------------
// api.ts — la frontière HTTP de l'API moteur publique (/api/v1/engine).
//
// Rôle : valider STRICTEMENT (Zod `.strict()`) une charge venue du réseau,
// l'amener au moteur déterministe, et rien de plus. Aucun appel LLM, aucun appel
// réseau, aucune écriture : l'API moteur ne fait que CALCULER. La catégorisation
// par le modèle, quand elle a lieu, se fait chez l'APPELANT (Claude Tag), qui
// nous transmet des ÉTIQUETTES déjà posées (`labels`). Sans étiquettes, on
// retombe sur le classifieur déterministe par mots-clés.
//
// Sécurité : jeton Bearer (env `ENGINE_API_TOKENS`, comparé en temps constant),
// schémas stricts (une clé inconnue = rejet), montants bornés. Le jeton lui-même
// sert de clé de débit (haché par le limiteur).
// ---------------------------------------------------------------------------

import { z } from "zod";

import { build, ENGINE_VERSION, toMerchantInputs } from "./core";
import { categorizeByRules, type MerchantInput } from "@/lib/categorize";
import type { AnalyzeResult, MerchantVerdict, Tx } from "@/lib/types";

// --- Schémas d'entrée (STRICTS) --------------------------------------------

const NATURES = ["pilotable", "structurel", "ponctuel", "perso"] as const;
const MOTIFS = ["abonnement", "doublon", "fx", "variable"] as const;
const ACTIONS = ["keep", "cancel", "downgrade", "switch", "consolidate", "renegotiate"] as const;
const RISKS = ["safe", "med", "hard"] as const;
const POLES = [
  "IA & Dev", "Outbound / Sales", "Infra / Prod", "Marketing Ads",
  "Bureau / Telco / Banque", "Perso", "Sous-traitance", "Certif", "Voyage", "Autre",
] as const;

const TxSchema = z
  .object({
    merchant: z.string().min(1).max(140),
    amount: z.number().finite().nonnegative(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date attendue AAAA-MM-JJ"),
    side: z.enum(["debit", "credit"]).default("debit"),
    isFx: z.boolean().default(false),
    fee: z.number().finite().nonnegative().default(0),
    operationType: z.string().max(40).default("card"),
    attachmentRequired: z.boolean().default(false),
    hasAttachment: z.boolean().default(false),
  })
  .strict();

const LabelSchema = z
  .object({
    merchant: z.string().min(1).max(140),
    nature: z.enum(NATURES),
    motif: z.enum(MOTIFS).optional(),
    action: z.enum(ACTIONS).default("keep"),
    pole: z.enum(POLES).optional(),
    isSubscription: z.boolean().default(false),
    alternative: z.string().max(200).default(""),
    risk: z.enum(RISKS).default("safe"),
  })
  .strict();

const accountShape = {
  account: z
    .object({
      name: z.string().max(140).default("Compte"),
      bank: z.string().max(60).default("Qonto"),
      balance: z.number().finite().default(0),
    })
    .strict()
    // Défaut EXPLICITE et complet : `.default({})` ne rejouerait pas les défauts
    // internes (Zod renverrait `{}` tel quel), laissant `balance` indéfini et le
    // runway à NaN. On fournit donc l'objet entier.
    .default({ name: "Compte", bank: "Qonto", balance: 0 }),
  windowDays: z.number().int().positive().max(400).default(90),
  transactions: z.array(TxSchema).min(1).max(5000),
  labels: z.array(LabelSchema).max(2000).optional(),
};

export const AnalyzeBody = z.object(accountShape).strict();

export const SimulateBody = z
  .object({
    ...accountShape,
    decisions: z
      .array(z.object({ leverId: z.string().min(1).max(80), active: z.boolean() }).strict())
      .max(500)
      .default([]),
  })
  .strict();

export type AnalyzeInput = z.infer<typeof AnalyzeBody>;
export type SimulateInput = z.infer<typeof SimulateBody>;

// --- Cœur : de la charge validée au moteur ---------------------------------

function windowLabel(days: number) {
  return { fr: `${days} j`, en: `${days} days` };
}

function toTxs(input: AnalyzeInput): Tx[] {
  return input.transactions.map((t, i) => ({
    id: `tx-${i}`,
    merchant: t.merchant,
    amount: t.amount,
    localCurrency: "EUR",
    isFx: t.isFx,
    side: t.side,
    operationType: t.operationType,
    date: t.date,
    attachmentRequired: t.attachmentRequired,
    hasAttachment: t.hasAttachment,
    fee: t.fee,
  }));
}

/**
 * Étiquettes → verdicts. Un marchand ÉTIQUETÉ par l'appelant prend son
 * étiquette ; les autres retombent sur le classifieur déterministe. Aucun appel
 * LLM ici : l'API moteur ne fait que calculer.
 */
function buildVerdicts(txs: Tx[], input: AnalyzeInput): { verdicts: MerchantVerdict[]; categorized: "claude" | "rules" } {
  const months = Math.max(1, input.windowDays / 30);
  const inputs: MerchantInput[] = toMerchantInputs(txs.filter((t) => t.side === "debit"), months);
  const rules = categorizeByRules(inputs);
  if (!input.labels || input.labels.length === 0) return { verdicts: rules, categorized: "rules" };

  const byName = new Map(input.labels.map((l) => [l.merchant.toLowerCase(), l]));
  const verdicts = inputs.map((inp, i) => {
    const lab = byName.get(inp.name.toLowerCase());
    if (!lab) return rules[i];
    return {
      name: inp.name,
      nature: lab.nature,
      pole: lab.pole ?? "Autre",
      isSubscription: lab.isSubscription,
      action: lab.action,
      alternative: lab.alternative,
      motif: lab.motif,
      risk: lab.risk,
    } as MerchantVerdict;
  });
  return { verdicts, categorized: "claude" };
}

export type EngineAnalyzeResult = AnalyzeResult & { engineVersion: string };

export function analyzeFromBody(input: AnalyzeInput): EngineAnalyzeResult {
  const txs = toTxs(input);
  const { verdicts, categorized } = buildVerdicts(txs, input);
  const result = build({
    account: input.account,
    windowLabel: windowLabel(input.windowDays),
    txs,
    verdicts,
    windowDays: input.windowDays,
    source: "qonto",
    categorized,
  });
  return { ...result, engineVersion: ENGINE_VERSION };
}

export interface SimulateResult {
  engineVersion: string;
  monthly: number;
  annual: number;
  count: number;
  levers: Array<{ id: string; label: string; saving: number; motif?: string; active: boolean }>;
}

/**
 * Projette l'impact de DÉCISIONS (activer / désactiver des leviers) sur le total.
 * Déterministe : on part de l'analyse, on applique les surcharges d'activation,
 * on somme. Aucun euro n'est inventé — on ne fait que sélectionner des leviers
 * déjà calculés par le moteur.
 */
export function simulateFromBody(input: SimulateInput): SimulateResult {
  const analysis = analyzeFromBody(input);
  const override = new Map(input.decisions.map((d) => [d.leverId, d.active]));
  const levers = analysis.levers.map((l) => ({
    id: l.id,
    label: l.label,
    saving: l.saving,
    motif: l.motif,
    active: override.has(l.id) ? override.get(l.id)! : l.active,
  }));
  const active = levers.filter((l) => l.active);
  const monthly = active.reduce((s, l) => s + l.saving, 0);
  return { engineVersion: ENGINE_VERSION, monthly, annual: monthly * 12, count: active.length, levers };
}

// --- Authentification par jeton Bearer -------------------------------------

/** Jetons acceptés, lus à chaud (permet la rotation sans redéploiement à froid). */
export function engineTokens(): string[] {
  return (process.env.ENGINE_API_TOKENS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Comparaison en temps constant (longueur d'abord — inévitable et sans danger ici). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export type AuthOk = { ok: true; token: string };
export type AuthErr = { ok: false; status: number; code: string };

/**
 * Authentifie une requête sur l'API moteur.
 *  - Aucun jeton configuré → 503 (l'API est fermée tant qu'on ne l'a pas armée).
 *  - Pas de Bearer → 401.
 *  - Bearer inconnu → 401.
 * On teste TOUS les jetons sans court-circuit pour ne pas fuiter par le timing
 * lequel a matché.
 */
export function authenticateEngine(req: Request): AuthOk | AuthErr {
  const tokens = engineTokens();
  if (tokens.length === 0) return { ok: false, status: 503, code: "engine_api_not_configured" };

  const presented = bearerToken(req);
  if (!presented) return { ok: false, status: 401, code: "missing_bearer" };

  let matched = false;
  for (const t of tokens) if (timingSafeEqual(t, presented)) matched = true;
  return matched ? { ok: true, token: presented } : { ok: false, status: 401, code: "invalid_token" };
}
