// ---------------------------------------------------------------------------
// POST /api/letter — prépare un courrier de résiliation / renégociation prêt à
// envoyer pour un levier donné. Argentier prépare, l'utilisateur envoie.
//
// ACCÈS : ouvert, mais PLAFONNÉ par IP (cf. lib/api/rate-limit.ts). La
// rédaction passe par Anthropic, donc chaque appel coûte. Une authentification
// stricte casserait /demo, qui prépare des lettres pour un visiteur non
// connecté (app/Argentier.tsx, `openLetter`) : le plafond par IP est le
// compromis qui garde la démo vivante sans laisser brûler les crédits.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";
import { generateLetter, type LetterRequest } from "@/lib/letters";
import {
  messageTropDeRequetes,
  reponseTropDeRequetes,
  verifierDebit,
} from "@/lib/api/rate-limit";
import type { Lang, LeverAction } from "@/lib/types";

export const dynamic = "force-dynamic";

const ACTIONS: LeverAction[] = [
  "keep",
  "cancel",
  "downgrade",
  "switch",
  "consolidate",
  "renegotiate",
];

const LANGS: Lang[] = ["fr", "en", "de", "es", "it"];

export async function POST(request: Request) {
  // Avant TOUT travail payant : le contrôle de débit. `letter` est repris dans
  // le corps du 429 parce que l'écran de la démo affiche ce champ tel quel.
  const debit = await verifierDebit(request, "letter");
  if (!debit.autorise) {
    return reponseTropDeRequetes(debit, { letter: messageTropDeRequetes(debit) });
  }

  let body: Partial<LetterRequest> & { action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps JSON invalide" }, { status: 400 });
  }

  const merchant = String(body.merchant ?? "").trim();
  if (!merchant) {
    return NextResponse.json({ error: "Champ 'merchant' requis" }, { status: 400 });
  }
  const action: LeverAction = ACTIONS.includes(body.action as LeverAction)
    ? (body.action as LeverAction)
    : "renegotiate";

  const req: LetterRequest = {
    merchant,
    action,
    alternative: String(body.alternative ?? ""),
    savingMonthly: Number(body.savingMonthly ?? 0),
    savingAnnual: Number(body.savingAnnual ?? (Number(body.savingMonthly ?? 0) * 12)),
    lang: body.lang && LANGS.includes(body.lang) ? body.lang : "fr",
    sources: Array.isArray(body.sources) ? body.sources : undefined,
  };

  const letter = await generateLetter(req);
  return NextResponse.json({ letter });
}
