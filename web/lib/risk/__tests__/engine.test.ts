import { describe, it, expect } from "vitest";
import {
  aggregateFinancial,
  computeRisk,
  DEFAULT_CONFIG,
  riskBand,
  scoreDimensions,
  scoreExternalSignals,
} from "../engine";
import type { CompanySignal } from "../types";
import {
  FINANCES_MANQUANTES,
  FRAGILE,
  SIGNAL_LEVEE,
  SIGNAL_NEWS_NEG,
  SIGNAL_PROCEDURE,
  SOLIDE,
} from "../fixtures";

const src = (over: Partial<CompanySignal> = {}): CompanySignal => ({
  type: "news",
  title: "t",
  summary: "s",
  sentiment: "negative",
  date: null,
  sourceUrl: "https://example.com/x",
  sourceName: "X",
  confidence: "high",
  ...over,
});

describe("dimensions financieres", () => {
  it("note les 6 dimensions d'une societe solide (toutes /20)", () => {
    const dims = scoreDimensions(SOLIDE.n);
    expect(dims).toHaveLength(6);
    for (const d of dims) {
      expect(d.applied).toBe(true);
      expect(d.note).not.toBeNull();
      expect(d.note as number).toBeGreaterThanOrEqual(0);
      expect(d.note as number).toBeLessThanOrEqual(20);
    }
    const { financialScore } = aggregateFinancial(dims, 3);
    expect(financialScore).not.toBeNull();
    expect(financialScore as number).toBeGreaterThan(14); // solide
  });

  it("penalise une societe fragile (levier, remboursement, marge)", () => {
    const dims = scoreDimensions(FRAGILE.n);
    const { financialScore } = aggregateFinancial(dims, 3);
    expect(financialScore as number).toBeLessThan(9); // fragile
    const capacite = dims.find((d) => d.key === "capaciteRemboursement")!;
    expect(capacite.note).toBe(0); // EBE << dettes → 0 (mais EBE>0)
  });

  it("EBE negatif → capacite de remboursement = 0", () => {
    const dims = scoreDimensions({ ...FRAGILE.n!, ebe: -50_000, dettesFinancieres: 500_000 });
    expect(dims.find((d) => d.key === "capaciteRemboursement")!.note).toBe(0);
  });

  it("capitaux propres negatifs → levier & capitalisation = 0", () => {
    const dims = scoreDimensions({ ...SOLIDE.n!, capitauxPropres: -100_000 });
    expect(dims.find((d) => d.key === "levier")!.note).toBe(0);
    expect(dims.find((d) => d.key === "capitalisation")!.note).toBe(0);
  });
});

describe("donnees manquantes = null (jamais 0)", () => {
  it("une valeur absente sort du calcul, elle n'est pas mise a 0", () => {
    const dims = scoreDimensions(FINANCES_MANQUANTES.n);
    const marge = dims.find((d) => d.key === "margeExploitation")!;
    // EBE null → marge non calculable → note null, PAS 0
    expect(marge.note).toBeNull();
    expect(marge.applied).toBe(false);
  });

  it("trop peu de dimensions → financialScore = null", () => {
    const dims = scoreDimensions(FINANCES_MANQUANTES.n);
    const { financialScore, available } = aggregateFinancial(dims, 3);
    expect(available).toBeLessThan(3);
    expect(financialScore).toBeNull();
  });

  it("financials absents → combinedScore null, mais externalScore reste affiché", () => {
    const r = computeRisk("123456789", FINANCES_MANQUANTES, [SIGNAL_LEVEE]);
    expect(r.financialScore).toBeNull();
    expect(r.combinedScore).toBeNull();
    expect(r.externalSignalsScore).toBe(12); // 10 + 2 (levée)
    expect(r.warnings.some((w) => w.includes("séparément"))).toBe(true);
  });
});

describe("signaux externes — base 10, points deterministes, sources obligatoires", () => {
  it("part de 10 sans signal", () => {
    expect(scoreExternalSignals([], DEFAULT_CONFIG).externalSignalsScore).toBe(10);
  });

  it("levée +2, croissance +1, news+ +1, news- -1, litige -2", () => {
    const cases: Array<[CompanySignal, number]> = [
      [SIGNAL_LEVEE, 12],
      [src({ type: "growth", sentiment: "positive" }), 11],
      [src({ type: "news", sentiment: "positive" }), 11],
      [src({ type: "news", sentiment: "negative" }), 9],
      [src({ type: "litigation", sentiment: "negative" }), 8],
      [src({ type: "management", sentiment: "negative" }), 9],
    ];
    for (const [sig, expected] of cases) {
      expect(scoreExternalSignals([sig], DEFAULT_CONFIG).externalSignalsScore).toBe(expected);
    }
  });

  it("un signal SANS source ne compte jamais", () => {
    const r = scoreExternalSignals([src({ sourceUrl: "" })], DEFAULT_CONFIG);
    expect(r.externalSignalsScore).toBe(10);
    expect(r.appliedSignals[0].applied).toBe(false);
    expect(r.appliedSignals[0].reason).toBe("aucune source");
  });

  it("un signal de confiance 'low' ne modifie pas le score (le doute ne compte pas)", () => {
    const r = scoreExternalSignals([src({ type: "litigation", confidence: "low" })], DEFAULT_CONFIG);
    expect(r.externalSignalsScore).toBe(10);
    expect(r.appliedSignals[0].applied).toBe(false);
  });

  it("clamp bas a 0 : plusieurs signaux tres negatifs", () => {
    const many = Array.from({ length: 8 }, () => src({ type: "litigation", sentiment: "negative" }));
    expect(scoreExternalSignals(many, DEFAULT_CONFIG).externalSignalsScore).toBe(0);
  });
});

describe("procedure collective = CRITICAL_EVENT", () => {
  it("procedure confirmee (confiance haute) → -10 + criticalEvent", () => {
    const r = scoreExternalSignals([SIGNAL_PROCEDURE], DEFAULT_CONFIG);
    expect(r.externalSignalsScore).toBe(0); // 10 - 10
    expect(r.criticalEvent).not.toBeNull();
    expect(r.criticalEvent!.kind).toBe("redressement");
  });

  it("un signal 'procedure' POSITIF (absence de procédure) ne déclenche jamais de critical", () => {
    const absence = src({ type: "procedure", sentiment: "positive", title: "Aucune procédure en cours", confidence: "high" });
    const r = scoreExternalSignals([absence], DEFAULT_CONFIG);
    expect(r.criticalEvent).toBeNull();
    expect(r.externalSignalsScore).toBe(10); // aucun point retiré
    expect(r.appliedSignals[0].applied).toBe(false);
  });

  it("procedure non confirmee (confiance medium) → ignorée + warning, PAS de criticalEvent", () => {
    const r = scoreExternalSignals([{ ...SIGNAL_PROCEDURE, confidence: "medium" }], DEFAULT_CONFIG);
    expect(r.externalSignalsScore).toBe(10);
    expect(r.criticalEvent).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("computeRisk : un criticalEvent force la bande CRITIQUE meme avec de bonnes finances", () => {
    const r = computeRisk("123456789", SOLIDE, [SIGNAL_PROCEDURE]);
    expect(r.criticalEvent).not.toBeNull();
    expect(r.band).toBe("CRITIQUE");
  });
});

describe("score combine & bande", () => {
  it("combine 80/20 par defaut et n'ecrase pas les deux sources", () => {
    const r = computeRisk("123456789", SOLIDE, [SIGNAL_NEWS_NEG]);
    expect(r.financialScore).not.toBeNull();
    expect(typeof r.externalSignalsScore).toBe("number");
    const expected = Math.round((r.financialScore! * 0.8 + r.externalSignalsScore * 0.2) * 10) / 10;
    expect(r.combinedScore).toBe(expected);
    expect(r.weights).toEqual({ financial: 0.8, external: 0.2 });
  });

  it("ponderation configurable", () => {
    const a = computeRisk("1", SOLIDE, [], { financialWeight: 0.5, externalWeight: 0.5 });
    const b = computeRisk("1", SOLIDE, [], { financialWeight: 1, externalWeight: 0 });
    expect(a.combinedScore).not.toBe(b.combinedScore);
    expect(b.combinedScore).toBe(b.financialScore);
  });

  it("bandes de risque", () => {
    expect(riskBand(17, false)).toBe("TRES_FAIBLE");
    expect(riskBand(14, false)).toBe("FAIBLE");
    expect(riskBand(11, false)).toBe("MODERE");
    expect(riskBand(7, false)).toBe("ELEVE");
    expect(riskBand(3, false)).toBe("TRES_ELEVE");
    expect(riskBand(18, true)).toBe("CRITIQUE"); // critical prime
  });
});
