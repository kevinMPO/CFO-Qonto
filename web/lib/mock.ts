// ---------------------------------------------------------------------------
// Jeu de démonstration — servi par /api/analyze quand ni Qonto ni Anthropic ne
// sont configurés, et donc EXPOSÉ PUBLIQUEMENT, sans authentification.
//
// À ce titre : société FICTIVE, montants FICTIFS. Aucune donnée d'un compte
// bancaire réel n'a sa place ici — ni raison sociale, ni solde, ni ligne
// « perso ». Le profil imité est celui d'une petite structure de conseil
// (compte EI : pro et perso mélangés), au format `AnalyzeResult` exact.
//
// La démo vend la rigueur des chiffres : elle doit donc être ARITHMÉTIQUEMENT
// JUSTE. Quatre invariants, verrouillés par `lib/__tests__/mock.test.ts` et
// repris de `lib/engine.ts` :
//   1. totals.out = Σ natures            (la cascade du relevé au pilotable) ;
//   2. totals.runRate = nature pilotable (le run-rate, c'est le pilotable) ;
//   3. Σ poles = totals.runRate          (les pôles découpent le run-rate) ;
//   4. tvaRecuperableEur = baseTtcEur × 20/120 (taux France standard).
//
// Runway : le résultat n'expose pas les encaissements, donc le calcul est posé
// ici. Burn hors ponctuel = 16 137 − 3 468 = 12 669 € ; encaissements du mois
// = 10 932 € ; burn net = 1 737 € ; 9 380 / 1 737 = 5,4 mois.
// ---------------------------------------------------------------------------

import type { AnalyzeResult } from "./types";

export const MOCK: AnalyzeResult = {
  account: { name: "ACME Conseil (démo)", bank: "Qonto", balance: 9380 },
  window: { label: { fr: "20 mai – 19 juin 2026", en: "May 20 – June 19, 2026" } },
  totals: { out: 16137, runRate: 1627 },
  natures: [
    { key: "structurel", label: "Structurel", amount: 9240 },
    { key: "ponctuel", label: "Ponctuel", amount: 3468 },
    { key: "perso", label: "Perso", amount: 1802 },
    { key: "pilotable", label: "Pilotable", amount: 1627 },
  ],
  poles: [
    { label: "Outbound / Sales", amount: 664 },
    { label: "IA & Dev", amount: 358 },
    { label: "Marketing Ads", amount: 291 },
    { label: "Bureau / Telco / Banque", amount: 173 },
    { label: "Infra / Prod", amount: 141 },
  ],
  score: {
    value: 72,
    drivers: [
      { fr: "Doublons fonctionnels (2 LLM) −8", en: "Functional duplicates (2 LLMs) −8" },
      { fr: "Justificatifs TVA manquants −8", en: "Missing VAT receipts −8" },
      { fr: "Part optimisable du run-rate −12", en: "Optimizable share of run-rate −12" },
    ],
  },
  runway: { months: 5.4, note: { fr: "hors exceptionnel", en: "excl. one-offs" } },
  levers: [
    { id: "inst", label: "Instantly", to: "1 seul workspace", saving: 86, risk: "med", active: true, action: "consolidate" },
    { id: "gpt", label: "ChatGPT", to: "Claude seul", saving: 84, risk: "safe", active: true, action: "cancel" },
    { id: "waa", label: "Waalaxy", to: "Apollo + Instantly", saving: 51, risk: "safe", active: true, action: "switch" },
    { id: "fx", label: "Frais FX / ATM", to: "carte Wise / Revolut", saving: 43, risk: "safe", active: true, action: "switch" },
    { id: "nesp", label: "Nespresso abo", to: "achat ponctuel", saving: 42, risk: "safe", active: true, action: "cancel" },
    { id: "figma", label: "Figma", to: "revenir au tarif / renégo", saving: 6, risk: "safe", active: true, action: "renegotiate", monthly: 48, hausse: { pct: 14.3, avantEur: 42, apresEur: 48 } },
    { id: "gw", label: "Google Workspace ×2", to: "1 compte", saving: 29, risk: "safe", active: true, action: "consolidate" },
    { id: "repl", label: "Replit", to: "Claude Code + Cursor", saving: 30, risk: "med", active: true, action: "switch" },
    { id: "hey", label: "HeyGen", to: "pause / annuel", saving: 28, risk: "safe", active: true, action: "downgrade" },
    { id: "loom", label: "Loom", to: "capture native", saving: 23, risk: "safe", active: true, action: "cancel" },
    { id: "uber", label: "Uber One", to: "couper", saving: 7, risk: "safe", active: true, action: "cancel" },
    { id: "make", label: "Make", to: "n8n self-hosted", saving: 10, risk: "med", active: false, action: "switch" },
    { id: "ring", label: "Ringover", to: "renégo forfait", saving: 65, risk: "hard", active: false, action: "renegotiate" },
    { id: "hub", label: "HubSpot", to: "Pipedrive / Folk", saving: 54, risk: "hard", active: false, action: "switch" },
  ],
  flux: [
    {
      kind: "new",
      // Montant aligné sur le levier « hey » : c'est le même abonnement.
      label: { fr: "HeyGen · nouvel abonnement", en: "HeyGen · new subscription" },
      value: { fr: "28 €/mois", en: "€28/mo" },
      tone: "amber",
    },
    {
      kind: "check",
      label: { fr: "Virement région IDF · à vérifier", en: "IDF region transfer · to review" },
      value: { fr: "268 €", en: "€268" },
      tone: "neutral",
    },
    {
      kind: "dup",
      // Montant aligné sur le levier « gpt » : c'est le doublon qu'on coupe.
      label: {
        fr: "Doublon : 2 LLM payants (Claude + ChatGPT)",
        en: "Duplicate: 2 paid LLMs (Claude + ChatGPT)",
      },
      value: { fr: "−84 €/mois", en: "−€84/mo" },
      tone: "danger",
    },
    {
      kind: "ghost",
      label: { fr: "CapCut · abo dormant, plus prélevé", en: "CapCut · dormant subscription, no longer charged" },
      value: { fr: "à confirmer", en: "to confirm" },
      tone: "neutral",
    },
  ],
  tvaPerdue: { transactions: 3, baseTtcEur: 414, tvaRecuperableEur: 69 },
  meta: { source: "mock", categorized: "rules", txCount: 0 },
};
