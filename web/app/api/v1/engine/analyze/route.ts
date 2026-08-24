// ---------------------------------------------------------------------------
// POST /api/v1/engine/analyze — l'API moteur publique.
//
// Audite des transactions (avec ou sans étiquettes déjà posées) et renvoie
// l'AnalyzeResult déterministe + `engineVersion`. Aucun appel LLM, aucun appel
// réseau, aucune écriture : l'API ne fait que CALCULER. Bearer requis.
// ---------------------------------------------------------------------------

import { AnalyzeBody, analyzeFromBody } from "@/lib/engine/api";
import { handleEngine } from "@/lib/engine/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleEngine(req, AnalyzeBody, analyzeFromBody);
}
