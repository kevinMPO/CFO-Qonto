// ---------------------------------------------------------------------------
// i18n légère (FR / EN), sans dépendance. Le dictionnaire de l'UI statique +
// des helpers de formatage. Les textes produits par engine.ts / Claude sont,
// eux, renvoyés bilingues (type Localized) ou générés dans la langue demandée.
// ---------------------------------------------------------------------------

import type { Lang, Nature, Risk } from "./types";

export const LANGS: Lang[] = ["fr", "en"];

export function detectLang(input?: string | null): Lang {
  if (input && input.toLowerCase().startsWith("en")) return "en";
  return "fr";
}

// Formatage monétaire selon la langue (nombre localisé, « € » suffixe).
export function eur(n: number, lang: Lang): string {
  const locale = lang === "en" ? "en-US" : "fr-FR";
  return Math.round(n).toLocaleString(locale) + " €";
}

const NATURE: Record<Lang, Record<Nature, string>> = {
  fr: { pilotable: "Pilotable", structurel: "Structurel", ponctuel: "Ponctuel", perso: "Perso" },
  en: { pilotable: "Controllable", structurel: "Structural", ponctuel: "One-off", perso: "Personal" },
};
export const natureLabel = (k: Nature, lang: Lang) => NATURE[lang][k];

const RISK: Record<Lang, Record<Risk, string>> = {
  fr: { safe: "sans risque", med: "à valider", hard: "projet" },
  en: { safe: "risk-free", med: "to review", hard: "project" },
};
export const riskLabel = (r: Risk, lang: Lang) => RISK[lang][r];

// --- Dictionnaire de l'UI ---------------------------------------------------
export const UI = {
  fr: {
    tagline: "Analyse en lecture seule de ton compte Qonto, calcul déterministe, livrables préparés.",
    readonly: "Qonto lecture seule",
    heroEyebrow: "Ce que tu peux récupérer cette année",
    heroSub: (m: string) => `soit ${m}/mois, sans perdre une seule capacité`,
    cta: "Voir mon plan d'action",
    scoreCap: "santé financière",
    months: (n: string) => `${n} mois`,
    treso: (note: string) => `de trésorerie · ${note}`,
    ledgerTitle: "Ton vrai run-rate, pas ton relevé",
    thisMonth: (x: string) => `${x} ce mois`,
    natureAria: "Répartition par nature des sorties du mois",
    mRunrate: "Run-rate pilotable",
    mRunrateNote: (x: string) => `≈ ${x}/an`,
    mActive: "Économie active",
    mActiveNote: (x: string) => `→ ${x}/an`,
    mOptimized: "Run-rate optimisé",
    mOptimizedNote: (p: number) => `−${p}%`,
    polesTitle: "Détail du pilotable par pôle",
    simTitle: "Simulateur d'économies",
    simRecovered: (p: number) => `${p}% du pilotable récupéré`,
    perMonth: "/ mois",
    perYear: "/ an",
    cumul: (h: number) => `cumul sur ${h} mois`,
    optimizedRunrate: "run-rate optimisé",
    horizon: "Horizon",
    hMonths: (h: number) => `${h} mois`,
    quickWins: "Quick wins sans risque",
    enableAll: "Tout activer",
    disableAll: "Tout désactiver",
    printable: "Version imprimable (PDF)",
    exportCsv: "Exporter le plan (CSV)",
    leverHint: "✎ à côté d'un levier = Argentier te prépare le courrier prêt à envoyer. Tu relis, tu envoies.",
    anomTitle: "Flux nouveaux et anomalies",
    footMock: "Données de démonstration — configure Qonto + Anthropic dans .env pour brancher ton vrai compte. ",
    footReal: (n: number, claude: boolean) =>
      `Analyse sur ${n} transactions${claude ? " · catégorisation Claude" : ""}. `,
    footPrivacy: "Données traitées en Europe, jamais utilisées pour entraîner un modèle. Conseils fiscaux à valider avec ton comptable.",
    letterFor: (name: string) => `Préparer la lettre pour ${name}`,
    drawerEyebrow: "Prêt — à envoyer par toi",
    drawerLoading: "Argentier rédige ton courrier…",
    regenerate: "Régénérer",
    copy: "Copier le texte",
    copied: "Copié ✓",
    drawerNote: "Rien n'est envoyé. Complète les [crochets], relis, puis envoie-le toi-même.",
    benchTitle: "Prix du marché",
    benchSource: "Sourcer le prix (web)",
    benchRerun: "Relancer",
    benchSearching: "Linkup cherche des alternatives sourcées…",
    benchVia: (p: string) => `via ${p === "linkup" ? "Linkup" : "la recherche web de Claude"}`,
    benchBest: (s: number, alt: string) => `≈ ${s} €/mois d'écart avec ${alt} (calcul engine)`,
    benchSourceLink: (d: string) => `source${d ? ` · ${d}` : ""}`,
    benchInject: "Régénérer la lettre en citant ces prix",
    benchNone: "Non vérifié.",
    close: "Fermer",
    pitch: "Pitch",
    pitchKicker: "Elevator pitch",
    srcLive: "Qonto en direct",
    srcDemo: "Démo",
    byClaude: "catégorisé par Claude",
    trustReadonly: "Lecture seule",
    trustEngine: "Argentier calcule chaque euro",
    trustSourced: "Prix sourcés & datés (Linkup)",
    analyzing: "Analyse du compte…",
  },
  en: {
    tagline: "Read-only analysis of your Qonto account, deterministic maths, deliverables prepared.",
    readonly: "Qonto read-only",
    heroEyebrow: "What you can recover this year",
    heroSub: (m: string) => `that's ${m}/month, without losing a single capability`,
    cta: "See my action plan",
    scoreCap: "financial health",
    months: (n: string) => `${n} months`,
    treso: (note: string) => `of runway · ${note}`,
    ledgerTitle: "Your real run-rate, not your statement",
    thisMonth: (x: string) => `${x} this month`,
    natureAria: "Breakdown of the month's outflows by nature",
    mRunrate: "Controllable run-rate",
    mRunrateNote: (x: string) => `≈ ${x}/yr`,
    mActive: "Active savings",
    mActiveNote: (x: string) => `→ ${x}/yr`,
    mOptimized: "Optimized run-rate",
    mOptimizedNote: (p: number) => `−${p}%`,
    polesTitle: "Controllable breakdown by area",
    simTitle: "Savings simulator",
    simRecovered: (p: number) => `${p}% of controllable recovered`,
    perMonth: "/ month",
    perYear: "/ year",
    cumul: (h: number) => `${h}-month total`,
    optimizedRunrate: "optimized run-rate",
    horizon: "Horizon",
    hMonths: (h: number) => `${h} months`,
    quickWins: "Risk-free quick wins",
    enableAll: "Enable all",
    disableAll: "Disable all",
    printable: "Printable version (PDF)",
    exportCsv: "Export plan (CSV)",
    leverHint: "✎ next to a lever = Argentier drafts the ready-to-send letter. You review, you send.",
    anomTitle: "New flows & anomalies",
    footMock: "Demo data — set up Qonto + Anthropic in .env to connect your real account. ",
    footReal: (n: number, claude: boolean) =>
      `Analysis over ${n} transactions${claude ? " · Claude categorization" : ""}. `,
    footPrivacy: "Data processed in Europe, never used to train a model. Tax advice to be confirmed with your accountant.",
    letterFor: (name: string) => `Prepare the letter for ${name}`,
    drawerEyebrow: "Ready — for you to send",
    drawerLoading: "Argentier is drafting your letter…",
    regenerate: "Regenerate",
    copy: "Copy text",
    copied: "Copied ✓",
    drawerNote: "Nothing is sent. Fill in the [brackets], review, then send it yourself.",
    benchTitle: "Market price",
    benchSource: "Source the price (web)",
    benchRerun: "Rerun",
    benchSearching: "Linkup is searching for sourced alternatives…",
    benchVia: (p: string) => `via ${p === "linkup" ? "Linkup" : "Claude web search"}`,
    benchBest: (s: number, alt: string) => `≈ €${s}/mo gap vs ${alt} (engine maths)`,
    benchSourceLink: (d: string) => `source${d ? ` · ${d}` : ""}`,
    benchInject: "Regenerate the letter citing these prices",
    benchNone: "Not verified.",
    close: "Close",
    pitch: "Pitch",
    pitchKicker: "Elevator pitch",
    srcLive: "Qonto live",
    srcDemo: "Demo",
    byClaude: "categorized by Claude",
    trustReadonly: "Read-only",
    trustEngine: "Argentier computes every euro",
    trustSourced: "Sourced & dated prices (Linkup)",
    analyzing: "Analyzing account…",
  },
} as const;

export function tr(lang: Lang) {
  return UI[lang];
}

// --- Elevator pitch (texte verbatim, ** = emphase) --------------------------
export interface Pitch {
  hookNum: string;
  hookCap: string;
  paras: string[];
  tagline: string;
}

export const PITCH: Record<Lang, Pitch> = {
  fr: {
    hookNum: "90%",
    hookCap: "des TPE et PME n'auront jamais de DAF",
    paras: [
      "Quatre-vingt-dix pour cent des TPE et PME n'auront jamais de DAF. Alors celui qui lit les finances, c'est le dirigeant, à minuit, entre deux rendez-vous clients, face à **un relevé Qonto qui ment** : il mélange outils récurrents, charges structurelles et dépenses ponctuelles dans un seul chiffre. Il paie des doublons, se fait grignoter par les frais de change, et perd sans le voir de la TVA déductible.",
      "Argentier, c'est le DAF que ces quatre-vingt-dix pour cent n'auront jamais. Un agent en lecture seule sur le MCP Qonto qui sépare les flux par nature, révèle le vrai run-rate pilotable, et repère chaque doublon, abonnement fantôme et frais caché. **Le modèle se contente d'étiqueter ; un code déterministe fait chaque euro de calcul**, rien n'est halluciné et tout est auditable. **Il n'agit sur rien que tu n'aies approuvé** : un simulateur d'économies cliquable, des lettres de résiliation prêtes à envoyer, puis une boucle à trente jours qui prouve que l'argent a bien atterri.",
      "Plusieurs milliers d'euros récupérés par entreprise et par an, sans perdre une seule capacité. Et le marché, c'est **24 millions de PME en Europe** qui n'embaucheront jamais la finance mais auront toujours une banque. Pour Qonto, c'est l'agent manquant : **Operator agit, Analyst explique, Argentier optimise.**",
      "Le modèle : **agent gratuit, 5% de commission au succès sur les économies prouvées** sur l'année. **Pas d'économie, pas de coût.** Un DAF dans chaque compte, et la donnée dormante devient des clients fidèles.",
    ],
    tagline: "Le DAF que ton entreprise n'embauchera jamais.",
  },
  en: {
    hookNum: "90%",
    hookCap: "will never hire a CFO",
    paras: [
      "Ninety percent of small businesses will never hire a CFO. So the person reading the finances is the founder, at midnight, between two client calls, staring at **a Qonto statement that lies**: it blends recurring tools, structural costs, and one-off spend into one number. They overpay for duplicate tools, bleed FX fees, and lose deductible VAT without ever seeing it.",
      "Argentier is the CFO the ninety percent will never hire. A read-only agent on the Qonto MCP that splits flows by nature, reveals the true controllable run-rate, and flags every duplicate, ghost subscription, and hidden fee. **The model only labels; deterministic code does every euro of the math**, so nothing is hallucinated and everything is auditable. **It acts on nothing you don't approve**: a clickable savings simulator, ready-to-send cancellation letters, then a thirty-day loop that proves the money landed.",
      "Several thousand euros recovered per business, per year, zero capability lost. And the market is **24 million SMBs across Europe** who will never hire finance but will always have a bank. For Qonto, it's the missing agent: **Operator acts, Analyst explains, Argentier optimizes.**",
      "The model: **free agent, 5% success fee on the savings we prove** over the year. **No savings, no cost.** Put a CFO in every account, and dormant data becomes loyal customers.",
    ],
    tagline: "The CFO your business will never hire.",
  },
};
