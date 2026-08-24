// Fixtures deterministes pour tester le moteur de risque (aucune donnee reelle).
import type { CompanySignal, Financials } from "./types";

/** Societe solide : marges correctes, faible levier, tresorerie confortable. */
export const SOLIDE: Financials = {
  source: "RNE",
  n: {
    exercice: "2025",
    chiffreAffaires: 5_000_000,
    ebe: 600_000,
    resultatNet: 300_000,
    capitauxPropres: 2_000_000,
    dettesFinancieres: 800_000,
    tresorerie: 500_000,
    chargesFinancieres: 40_000,
    creancesClients: 400_000,
    dettesFournisseurs: 300_000,
  },
  nMinus1: {
    exercice: "2024",
    chiffreAffaires: 4_600_000,
    ebe: 520_000,
    resultatNet: 250_000,
    capitauxPropres: 1_800_000,
    dettesFinancieres: 700_000,
    tresorerie: 420_000,
    chargesFinancieres: 38_000,
    creancesClients: 380_000,
    dettesFournisseurs: 290_000,
  },
};

/** Societe fragile : marge faible, fort levier, EBE ne couvre pas la dette. */
export const FRAGILE: Financials = {
  source: "RNE",
  n: {
    exercice: "2025",
    chiffreAffaires: 2_000_000,
    ebe: 40_000,
    resultatNet: -60_000,
    capitauxPropres: 150_000,
    dettesFinancieres: 900_000,
    tresorerie: 15_000,
    chargesFinancieres: 70_000,
    creancesClients: 300_000,
    dettesFournisseurs: 500_000,
  },
  nMinus1: null,
};

/** Donnees financieres quasi absentes → score financier non publiable. */
export const FINANCES_MANQUANTES: Financials = {
  source: null,
  n: {
    exercice: "2025",
    chiffreAffaires: 1_000_000,
    ebe: null,
    resultatNet: null,
    capitauxPropres: null,
    dettesFinancieres: null,
    tresorerie: null,
    chargesFinancieres: null,
    creancesClients: null,
    dettesFournisseurs: null,
  },
  nMinus1: null,
};

export const SIGNAL_LEVEE: CompanySignal = {
  type: "fundraising",
  title: "Série A de 5 M€",
  summary: "Levée de fonds annoncée.",
  sentiment: "positive",
  date: "2026-05-12",
  sourceUrl: "https://example.com/levee",
  sourceName: "Les Echos",
  confidence: "high",
};

export const SIGNAL_PROCEDURE: CompanySignal = {
  type: "procedure",
  title: "Ouverture d'un redressement judiciaire",
  summary: "Jugement du tribunal de commerce.",
  sentiment: "negative",
  date: "2026-06-14",
  sourceUrl: "https://bodacc.fr/annonce/123",
  sourceName: "BODACC",
  confidence: "high",
  procedureKind: "redressement",
};

export const SIGNAL_NEWS_NEG: CompanySignal = {
  type: "news",
  title: "Plan social",
  summary: "Licenciements annoncés.",
  sentiment: "negative",
  date: "2026-04-03",
  sourceUrl: "https://example.com/news",
  sourceName: "Le Monde",
  confidence: "medium",
};
