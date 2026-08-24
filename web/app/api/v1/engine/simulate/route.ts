// ---------------------------------------------------------------------------
// POST /api/v1/engine/simulate — projette l'impact de décisions.
//
// Même charge que /analyze + un tableau `decisions` (activer/désactiver des
// leviers par id). Renvoie le total mensuel/annuel des leviers actifs, calculé
// par le moteur. Déterministe. Bearer requis.
// ---------------------------------------------------------------------------

import { SimulateBody, simulateFromBody } from "@/lib/engine/api";
import { handleEngine } from "@/lib/engine/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return handleEngine(req, SimulateBody, simulateFromBody);
}
