// ---------------------------------------------------------------------------
// CompanyRisk — types partages (identite, finances, signaux, score).
//
// Principe Argentier : le LLM identifie/classe/explique ; le MOTEUR calcule.
// Ces types sont l'unique contrat entre l'agent (qui remplit) et le moteur
// deterministe (qui note). Aucune donnee manquante n'est mise a 0 par defaut :
// une valeur inconnue reste `null` et sort du calcul.
// ---------------------------------------------------------------------------

export type Confidence = "high" | "medium" | "low";

/** Identite normalisee d'une entreprise (recoupement anti-homonyme). */
export interface CompanyIdentity {
  siren: string;
  raisonSociale: string | null;
  naf: string | null; // code APE/NAF
  activite: string | null; // libelle
  ville: string | null;
  adresse: string | null;
  dirigeant: string | null;
  dateCreation: string | null; // AAAA-MM-JJ
  etatAdministratif: "actif" | "cesse" | null;
  siteOfficiel: string | null;
}

/**
 * Etats financiers d'un exercice. TOUT champ inconnu = `null` (jamais 0).
 * Montants en euros. On conserve N et N-1 quand disponibles (voir Financials).
 */
export interface FinancialYear {
  exercice: string | null; // ex. "2025" ou "2025-12-31"
  chiffreAffaires: number | null;
  ebe: number | null; // excedent brut d'exploitation
  resultatNet: number | null;
  capitauxPropres: number | null;
  dettesFinancieres: number | null;
  tresorerie: number | null;
  chargesFinancieres: number | null;
  creancesClients: number | null;
  dettesFournisseurs: number | null;
}

export interface Financials {
  source: "RNE" | "INPI" | "manual" | null;
  n: FinancialYear | null; // exercice le plus recent
  nMinus1: FinancialYear | null;
}

export type SignalType =
  | "procedure"
  | "litigation"
  | "growth"
  | "fundraising"
  | "management"
  | "reputation"
  | "news";

export type Sentiment = "positive" | "neutral" | "negative";

/** Un signal externe SOURCE. Pas de source → pas de signal (regle stricte). */
export interface CompanySignal {
  type: SignalType;
  title: string;
  summary: string;
  sentiment: Sentiment;
  date: string | null;
  sourceUrl: string;
  sourceName: string | null;
  confidence: Confidence;
  /** Sous-type de procedure collective (si type === "procedure"). */
  procedureKind?: "sauvegarde" | "redressement" | "liquidation";
}

// --- Sorties du moteur -----------------------------------------------------

export interface DimensionScore {
  key:
    | "capitalisation"
    | "levier"
    | "capaciteRemboursement"
    | "couvertureChargesFinancieres"
    | "tresorerie"
    | "margeExploitation";
  label: string;
  /** Note /20, ou null si les donnees necessaires manquent. */
  note: number | null;
  /** Valeur du ratio brut (pour affichage/debug), ou null. */
  ratio: number | null;
  /** Contribue-t-elle au score financier agrege ? */
  applied: boolean;
}

export interface CriticalEvent {
  kind: "sauvegarde" | "redressement" | "liquidation";
  title: string;
  date: string | null;
  sourceUrl: string;
  sourceName: string | null;
}

export interface AppliedSignal {
  signal: CompanySignal;
  points: number;
  applied: boolean;
  reason: string; // pourquoi applique ou ignore
}

export interface RiskConfig {
  /** Poids du score financier dans le score combine (defaut 0.8). */
  financialWeight: number;
  /** Poids des signaux externes (defaut 0.2). */
  externalWeight: number;
  /** Nombre min de dimensions financieres pour publier un score financier. */
  minFinancialDimensions: number;
  /** Confiance minimale pour qu'un signal modifie le score. */
  minConfidenceForScore: Confidence;
  /** Confiance minimale pour qu'une procedure devienne CRITICAL_EVENT. */
  minConfidenceForCritical: Confidence;
}

export type RiskBand =
  | "TRES_FAIBLE"
  | "FAIBLE"
  | "MODERE"
  | "ELEVE"
  | "TRES_ELEVE"
  | "CRITIQUE";

export interface RiskScore {
  siren: string;
  dimensions: DimensionScore[];
  /** /20 ou null si trop peu de donnees financieres. */
  financialScore: number | null;
  /** /20, base 10 +/- points sourcés, clampe 0-20. */
  externalSignalsScore: number;
  /** /20 ou null si combinaison impossible (finances manquantes). */
  combinedScore: number | null;
  band: RiskBand;
  criticalEvent: CriticalEvent | null;
  appliedSignals: AppliedSignal[];
  /** Qualite/couverture des donnees, pour honnetete. */
  dataQuality: {
    financialDimensionsAvailable: number;
    signalsConsidered: number;
    signalsApplied: number;
    hasFinancials: boolean;
  };
  weights: { financial: number; external: number };
  warnings: string[];
}
