// ---------------------------------------------------------------------------
// CompanyRisk — MOTEUR DE SCORING DETERMINISTE.
//
// Pur, testable, SANS dependance a Mastra ni au LLM. Il ne recoit que des
// donnees structurees (Financials + CompanySignal[]) et rend des notes /20.
//
// Regles Argentier :
//   • Le LLM ne calcule JAMAIS un score ici — il fournit seulement les donnees.
//   • Donnee manquante = null → la dimension SORT du calcul (jamais 0 par defaut).
//   • Un signal externe ne modifie le score que s'il a une SOURCE et une
//     confiance suffisante (le doute ne compte pas).
//   • Une procedure collective confirmee = CRITICAL_EVENT, jamais noyee.
// ---------------------------------------------------------------------------

import type {
  AppliedSignal,
  CompanySignal,
  Confidence,
  CriticalEvent,
  DimensionScore,
  Financials,
  FinancialYear,
  RiskBand,
  RiskConfig,
  RiskScore,
  SignalType,
} from "./types";

export const DEFAULT_CONFIG: RiskConfig = {
  financialWeight: 0.8,
  externalWeight: 0.2,
  minFinancialDimensions: 3,
  minConfidenceForScore: "medium",
  minConfidenceForCritical: "high",
};

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

function meetsConfidence(c: Confidence, min: Confidence): boolean {
  return CONFIDENCE_RANK[c] >= CONFIDENCE_RANK[min];
}

function clamp(v: number, lo = 0, hi = 20): number {
  return Math.max(lo, Math.min(hi, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Interpolation lineaire par paliers. `points` = liste croissante en x de
 * paires [valeurX, noteY]. En-dehors des bornes → note de la borne.
 * Sert a mapper un ratio brut vers une note /20 de facon deterministe.
 */
function band(value: number, points: Array<[number, number]>): number {
  if (value <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (value >= last[0]) return last[1];
  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    if (value >= x0 && value <= x1) {
      const t = (value - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return last[1];
}

// --- Baremes des dimensions financieres (configurables via constantes) -----
// Chaque bareme mappe un ratio -> note /20. Documentes : seuils PME FR usuels.

const BAREME = {
  // Marge d'exploitation = EBE / CA. Plus haut = mieux.
  margeExploitation: [
    [0, 0],
    [0.05, 8],
    [0.1, 13],
    [0.2, 18],
    [0.3, 20],
  ] as Array<[number, number]>,
  // Levier = dettes financieres / capitaux propres. Plus bas = mieux.
  levier: [
    [0, 20],
    [0.5, 17],
    [1, 13],
    [2, 8],
    [4, 3],
    [6, 0],
  ] as Array<[number, number]>,
  // Capacite de remboursement = dettes financieres / EBE (annees). Plus bas = mieux.
  capaciteRemboursement: [
    [0, 20],
    [1, 18],
    [3, 12],
    [5, 6],
    [7, 0],
  ] as Array<[number, number]>,
  // Couverture des charges financieres = EBE / charges financieres. Plus haut = mieux.
  couvertureChargesFinancieres: [
    [1, 0],
    [1.5, 8],
    [3, 13],
    [5, 17],
    [10, 20],
  ] as Array<[number, number]>,
  // Capitalisation = capitaux propres / (capitaux propres + dettes fin). Plus haut = mieux.
  capitalisation: [
    [0, 0],
    [0.2, 7],
    [0.4, 13],
    [0.6, 17],
    [0.8, 20],
  ] as Array<[number, number]>,
  // Tresorerie = tresorerie / CA. Plus haut = mieux.
  tresorerie: [
    [0, 0],
    [0.02, 6],
    [0.05, 10],
    [0.1, 14],
    [0.2, 18],
    [0.3, 20],
  ] as Array<[number, number]>,
};

const DIM_LABELS: Record<DimensionScore["key"], string> = {
  capitalisation: "Capitalisation",
  levier: "Levier",
  capaciteRemboursement: "Capacité de remboursement",
  couvertureChargesFinancieres: "Couverture des charges financières",
  tresorerie: "Trésorerie",
  margeExploitation: "Marge d'exploitation",
};

function num(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Calcule les 6 dimensions financieres depuis l'exercice N. */
export function scoreDimensions(fy: FinancialYear | null): DimensionScore[] {
  const dims: DimensionScore[] = [];
  const push = (
    key: DimensionScore["key"],
    ratio: number | null,
    note: number | null,
  ) =>
    dims.push({
      key,
      label: DIM_LABELS[key],
      ratio: ratio === null ? null : round1(ratio),
      note: note === null ? null : round1(note),
      applied: note !== null,
    });

  if (!fy) {
    (Object.keys(DIM_LABELS) as DimensionScore["key"][]).forEach((k) =>
      push(k, null, null),
    );
    return dims;
  }

  // Marge d'exploitation
  if (num(fy.ebe) && num(fy.chiffreAffaires) && fy.chiffreAffaires > 0) {
    const r = fy.ebe / fy.chiffreAffaires;
    push("margeExploitation", r, clamp(band(r, BAREME.margeExploitation)));
  } else push("margeExploitation", null, null);

  // Levier
  if (num(fy.dettesFinancieres) && num(fy.capitauxPropres)) {
    if (fy.capitauxPropres <= 0) push("levier", null, 0); // fonds propres negatifs = pire
    else {
      const r = fy.dettesFinancieres / fy.capitauxPropres;
      push("levier", r, clamp(band(r, BAREME.levier)));
    }
  } else push("levier", null, null);

  // Capacite de remboursement
  if (num(fy.dettesFinancieres) && num(fy.ebe)) {
    if (fy.dettesFinancieres <= 0) push("capaciteRemboursement", 0, 20);
    else if (fy.ebe <= 0) push("capaciteRemboursement", null, 0); // EBE negatif = ne peut pas rembourser
    else {
      const r = fy.dettesFinancieres / fy.ebe;
      push("capaciteRemboursement", r, clamp(band(r, BAREME.capaciteRemboursement)));
    }
  } else push("capaciteRemboursement", null, null);

  // Couverture des charges financieres
  if (num(fy.ebe) && num(fy.chargesFinancieres)) {
    if (fy.chargesFinancieres <= 0)
      push("couvertureChargesFinancieres", null, fy.ebe > 0 ? 20 : 0);
    else {
      const r = fy.ebe / fy.chargesFinancieres;
      push("couvertureChargesFinancieres", r, clamp(band(r, BAREME.couvertureChargesFinancieres)));
    }
  } else push("couvertureChargesFinancieres", null, null);

  // Capitalisation
  if (num(fy.capitauxPropres) && num(fy.dettesFinancieres)) {
    const denom = fy.capitauxPropres + fy.dettesFinancieres;
    if (fy.capitauxPropres <= 0) push("capitalisation", null, 0);
    else if (denom <= 0) push("capitalisation", null, null);
    else {
      const r = fy.capitauxPropres / denom;
      push("capitalisation", r, clamp(band(r, BAREME.capitalisation)));
    }
  } else push("capitalisation", null, null);

  // Tresorerie
  if (num(fy.tresorerie) && num(fy.chiffreAffaires) && fy.chiffreAffaires > 0) {
    const r = fy.tresorerie / fy.chiffreAffaires;
    push("tresorerie", r, clamp(band(r, BAREME.tresorerie)));
  } else push("tresorerie", null, null);

  return dims;
}

/** Moyenne /20 des dimensions applicables, ou null si trop peu de donnees. */
export function aggregateFinancial(
  dims: DimensionScore[],
  minDims: number,
): { financialScore: number | null; available: number } {
  const applied = dims.filter((d) => d.applied && d.note !== null);
  if (applied.length < minDims) {
    return { financialScore: null, available: applied.length };
  }
  const avg = applied.reduce((s, d) => s + (d.note as number), 0) / applied.length;
  return { financialScore: round1(clamp(avg)), available: applied.length };
}

// --- Signaux externes ------------------------------------------------------
// Base 10, points DETERMINISTES par (type, sentiment). Seuls les signaux
// sources + suffisamment confiants comptent.

const POINTS: Record<SignalType, Partial<Record<"positive" | "neutral" | "negative", number>>> = {
  procedure: { negative: -10 }, // gere a part (voir applyProcedure) — confiance haute requise
  litigation: { negative: -2 },
  management: { negative: -1, positive: 0 },
  news: { negative: -1, positive: 1 },
  growth: { positive: 1 },
  fundraising: { positive: 2 },
  reputation: { negative: -1, positive: 1 },
};

export function scoreExternalSignals(
  signals: CompanySignal[],
  cfg: RiskConfig,
): {
  externalSignalsScore: number;
  appliedSignals: AppliedSignal[];
  criticalEvent: CriticalEvent | null;
  warnings: string[];
} {
  let score = 10;
  const applied: AppliedSignal[] = [];
  const warnings: string[] = [];
  let criticalEvent: CriticalEvent | null = null;

  for (const s of signals) {
    // Regle stricte : pas de source → pas de signal.
    if (!s.sourceUrl) {
      applied.push({ signal: s, points: 0, applied: false, reason: "aucune source" });
      continue;
    }

    // Procedure collective : cas critique, exige une confiance haute.
    if (s.type === "procedure") {
      const kind = s.procedureKind ?? "redressement";
      // Une procedure ne pese QUE si elle est reellement EN COURS (sentiment
      // negatif). Un signal "procedure" positif/neutre = ABSENCE de procedure :
      // il ne doit jamais declencher de CRITICAL_EVENT ni retirer de points.
      if (s.sentiment !== "negative") {
        applied.push({ signal: s, points: 0, applied: false, reason: "absence de procédure collective (non pénalisant)" });
        continue;
      }
      if (meetsConfidence(s.confidence, cfg.minConfidenceForCritical)) {
        const pts = POINTS.procedure.negative ?? -10;
        score += pts;
        applied.push({ signal: s, points: pts, applied: true, reason: "procédure collective confirmée" });
        if (!criticalEvent) {
          criticalEvent = {
            kind,
            title: s.title,
            date: s.date,
            sourceUrl: s.sourceUrl,
            sourceName: s.sourceName,
          };
        }
      } else {
        applied.push({ signal: s, points: 0, applied: false, reason: "procédure non confirmée (confiance insuffisante)" });
        warnings.push(`Procédure collective possible mais NON confirmée (confiance ${s.confidence}) — non comptée dans le score.`);
      }
      continue;
    }

    // Autres signaux : confiance minimale requise.
    if (!meetsConfidence(s.confidence, cfg.minConfidenceForScore)) {
      applied.push({ signal: s, points: 0, applied: false, reason: `confiance ${s.confidence} < minimum` });
      continue;
    }
    const pts = POINTS[s.type]?.[s.sentiment] ?? 0;
    if (pts === 0) {
      applied.push({ signal: s, points: 0, applied: false, reason: "type/sentiment sans impact" });
      continue;
    }
    score += pts;
    applied.push({ signal: s, points: pts, applied: true, reason: `${s.type}/${s.sentiment}` });
  }

  return {
    externalSignalsScore: round1(clamp(score)),
    appliedSignals: applied,
    criticalEvent,
    warnings,
  };
}

// --- Bande de risque -------------------------------------------------------

export function riskBand(score: number | null, hasCritical: boolean): RiskBand {
  if (hasCritical) return "CRITIQUE";
  if (score === null) return "MODERE"; // inconnu → prudence mediane
  if (score >= 16) return "TRES_FAIBLE";
  if (score >= 13) return "FAIBLE";
  if (score >= 10) return "MODERE";
  if (score >= 6) return "ELEVE";
  return "TRES_ELEVE";
}

// --- Score global ----------------------------------------------------------

export function computeRisk(
  siren: string,
  financials: Financials | null,
  signals: CompanySignal[],
  config: Partial<RiskConfig> = {},
): RiskScore {
  const cfg: RiskConfig = { ...DEFAULT_CONFIG, ...config };
  const warnings: string[] = [];

  const dims = scoreDimensions(financials?.n ?? null);
  const { financialScore, available } = aggregateFinancial(dims, cfg.minFinancialDimensions);
  if (financialScore === null) {
    warnings.push(
      `Score financier non publié : ${available} dimension(s) disponible(s) < ${cfg.minFinancialDimensions} requis (données RNE/INPI insuffisantes).`,
    );
  }

  const ext = scoreExternalSignals(signals, cfg);
  warnings.push(...ext.warnings);

  // Score combine : seulement si les finances sont exploitables.
  let combined: number | null = null;
  if (financialScore !== null) {
    const wf = cfg.financialWeight;
    const we = cfg.externalWeight;
    const total = wf + we || 1;
    combined = round1(clamp((financialScore * wf + ext.externalSignalsScore * we) / total));
  } else {
    warnings.push("Score combiné non calculé — les deux scores sources restent affichés séparément.");
  }

  // Un CRITICAL_EVENT prime sur toute moyenne. Sans finances, on classe sur le
  // score externe plutot que de retomber sur "MODERE" par defaut.
  const bandFrom = combined ?? financialScore ?? ext.externalSignalsScore;
  const band = riskBand(bandFrom, ext.criticalEvent !== null);

  return {
    siren,
    dimensions: dims,
    financialScore,
    externalSignalsScore: ext.externalSignalsScore,
    combinedScore: combined,
    band,
    criticalEvent: ext.criticalEvent,
    appliedSignals: ext.appliedSignals,
    dataQuality: {
      financialDimensionsAvailable: available,
      signalsConsidered: signals.length,
      signalsApplied: ext.appliedSignals.filter((a) => a.applied).length,
      hasFinancials: !!financials?.n,
    },
    weights: { financial: cfg.financialWeight, external: cfg.externalWeight },
    warnings,
  };
}
