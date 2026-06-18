// ---------------------------------------------------------------------------
// Génération des lettres / emails de résiliation & renégociation (PRD §5.8).
//
// Argentier PRÉPARE le courrier ; l'utilisateur l'envoie lui-même. Aucune action
// bancaire, aucun envoi automatique. Les infos personnelles restent des
// [crochets] à compléter — on n'invente pas les coordonnées de l'utilisateur.
//
// Bilingue : Claude rédige dans la langue demandée ; gabarit de secours FR/EN.
// ---------------------------------------------------------------------------

import Anthropic from "@anthropic-ai/sdk";
import type { Lang, LeverAction } from "./types";

const MODEL = process.env.ARGENTIER_MODEL || "claude-sonnet-5";

export interface LetterSource {
  name: string;
  price: string; // « 21 €/utilisateur/mois »
  date: string;
  url: string;
}

export interface LetterRequest {
  merchant: string;
  action: LeverAction;
  alternative: string;
  savingMonthly: number;
  savingAnnual: number;
  lang?: Lang;
  /** Prix concurrents sourcés + datés (issus de /api/benchmark), optionnels. */
  sources?: LetterSource[];
}

const ACTION_INTENT: Record<Lang, Record<LeverAction, string>> = {
  fr: {
    cancel: "résilier l'abonnement",
    downgrade: "passer à une formule moins chère mieux dimensionnée",
    switch: "migrer vers une alternative moins coûteuse à usage égal",
    consolidate: "regrouper des lignes en doublon en un seul contrat",
    renegotiate: "renégocier le tarif à la baisse",
    keep: "faire le point sur le contrat",
  },
  en: {
    cancel: "cancel the subscription",
    downgrade: "move to a cheaper, better-sized plan",
    switch: "switch to a cheaper alternative at equal usage",
    consolidate: "merge duplicate lines into a single contract",
    renegotiate: "renegotiate the price down",
    keep: "review the contract",
  },
};

const SYSTEM: Record<Lang, string> = {
  fr: `Tu rédiges, en français, des courriers ou emails PRÊTS À ENVOYER pour un
dirigeant de TPE / entreprise individuelle. Ton professionnel, courtois, direct.

Règles impératives :
- L'utilisateur enverra lui-même : n'écris jamais « envoyé par Argentier ».
- Ne fabrique aucune donnée personnelle : mets des [crochets] pour tout ce que
  l'utilisateur doit compléter ([Nom], [n° de client], [email], [date]).
- Reste factuel et réaliste : pas de menace, pas de chiffre inventé. Tu peux
  mentionner que l'utilisateur compare les offres du marché.
- Structure : objet, corps clair (2 à 4 paragraphes), formule de politesse.
- Renvoie UNIQUEMENT le texte du courrier (objet inclus), sans commentaire.`,
  en: `You write ready-to-send letters or emails, in English, for a small-business
owner / sole trader. Professional, courteous, direct tone.

Hard rules:
- The user sends it themselves: never write "sent by Argentier".
- Fabricate no personal data: use [brackets] for everything the user must fill in
  ([Name], [account number], [email], [date]).
- Stay factual and realistic: no threats, no invented figures. You may mention that
  the user is comparing market offers.
- Structure: subject line, clear body (2–4 paragraphs), sign-off.
- Return ONLY the letter text (subject included), with no commentary.`,
};

export function hasAnthropicKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export async function generateLetter(req: LetterRequest): Promise<string> {
  const lang: Lang = req.lang === "en" ? "en" : "fr";
  if (!hasAnthropicKey()) return templateLetter(req, lang);
  try {
    const client = new Anthropic();
    const intent = ACTION_INTENT[lang][req.action] ?? ACTION_INTENT[lang].renegotiate;
    const sourcesBlock = buildSourcesBlock(req, lang);
    const prompt =
      lang === "en"
        ? `Write the letter for this case:
- Provider / service: ${req.merchant}
- Goal: ${intent}${req.alternative ? ` (option considered: ${req.alternative})` : ""}
- Target saving (indicative, not to be framed as a demand): about €${Math.round(
            req.savingMonthly,
          )}/month, i.e. €${Math.round(req.savingAnnual)}/year.${sourcesBlock}

Adapt the tone: a cancellation is firm but courteous; a renegotiation or
consolidation opens a dialogue and asks for a proposal. If market prices are
provided, cite them factually (name + price + date) without aggressiveness.`
        : `Rédige le courrier pour ce cas :
- Fournisseur / service : ${req.merchant}
- Objectif : ${intent}${req.alternative ? ` (piste envisagée : ${req.alternative})` : ""}
- Économie visée (indicative, à ne pas présenter comme une exigence) : environ ${Math.round(
            req.savingMonthly,
          )} €/mois, soit ${Math.round(req.savingAnnual)} €/an.${sourcesBlock}

Adapte le ton : une résiliation est ferme mais courtoise ; une renégociation ou
consolidation ouvre le dialogue et demande une proposition. Si des prix du marché
sont fournis, cite-les factuellement (nom + tarif + date) sans agressivité.`;

    const response = (await client.messages.create({
      model: MODEL,
      max_tokens: 1200,
      system: [{ type: "text", text: SYSTEM[lang], cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: prompt }],
    })) as Anthropic.Message;

    const text = response.content.find((b) => b.type === "text");
    if (text && text.type === "text" && text.text.trim()) return text.text.trim();
    return templateLetter(req, lang);
  } catch (err) {
    console.error("Génération lettre Claude échouée, fallback gabarit :", err);
    return templateLetter(req, lang);
  }
}

function buildSourcesBlock(req: LetterRequest, lang: Lang): string {
  if (!req.sources || req.sources.length === 0) return "";
  const rows = req.sources
    .map((s) =>
      lang === "en"
        ? `- ${s.name}: ${s.price}${s.date ? ` (checked ${s.date})` : ""}`
        : `- ${s.name} : ${s.price}${s.date ? ` (relevé ${s.date})` : ""}`,
    )
    .join("\n");
  return lang === "en"
    ? `\n\nSourced market prices (cite factually to support the request, with the date):\n${rows}`
    : `\n\nPrix du marché sourcés (à citer factuellement pour appuyer la demande, avec la date) :\n${rows}`;
}

// --- Gabarit déterministe (sans clé Anthropic) -----------------------------
function templateLetter(req: LetterRequest, lang: Lang): string {
  const isCancel = req.action === "cancel";
  if (lang === "en") {
    const subject = isCancel
      ? `Cancellation of my ${req.merchant} subscription`
      : `Review of my ${req.merchant} contract`;
    const body = isCancel
      ? `I am writing to cancel my ${req.merchant} subscription, tied to account [account number / email].

Please process this cancellation at the earliest possible term, and confirm the effective date as well as the absence of any further charges.`
      : `As a ${req.merchant} customer under account [account number / email], I am reviewing my tools and would like to ${
          ACTION_INTENT.en[req.action] ?? "review my contract"
        }.${req.alternative ? `\n\nOption I am considering: ${req.alternative}.` : ""}

I am comparing market offers at equal usage. Before renewing, could you send me a pricing proposal aligned with your best current offer, detailing what is included?`;
    return `Subject: ${subject}

Hello,

${body}

Looking forward to your reply, best regards.

[First name LAST NAME]
[Company] — [Company ID]
[Email] · [Phone]

— Draft prepared by Argentier. Review it, fill in the [brackets], then send it yourself.`;
  }

  const objet = isCancel
    ? `Résiliation de mon abonnement ${req.merchant}`
    : `Révision de mon contrat ${req.merchant}`;
  const corps = isCancel
    ? `Je vous informe de ma décision de résilier mon abonnement ${req.merchant}, associé au compte [n° de client / email].

Je vous remercie de bien vouloir prendre en compte cette résiliation à la première échéance possible, et de me confirmer la date effective ainsi que l'absence de tout prélèvement ultérieur.`
    : `Client ${req.merchant} sous le compte [n° de client / email], je fais actuellement le point sur mes outils et souhaite ${
        ACTION_INTENT.fr[req.action] ?? "revoir mon contrat"
      }.${req.alternative ? `\n\nPiste envisagée de mon côté : ${req.alternative}.` : ""}

Je compare les offres du marché à usage équivalent. Avant de renouveler, pouvez-vous me faire une proposition tarifaire alignée sur votre meilleure offre actuelle, avec le détail de ce qui est inclus ?`;

  return `Objet : ${objet}

Bonjour,

${corps}

Dans l'attente de votre retour, je vous prie d'agréer mes salutations distinguées.

[Prénom NOM]
[Raison sociale] — [SIRET]
[Email] · [Téléphone]

— Brouillon préparé par Argentier. Relis, complète les [crochets], puis envoie-le toi-même.`;
}
