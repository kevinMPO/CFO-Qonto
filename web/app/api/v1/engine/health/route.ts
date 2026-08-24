// ---------------------------------------------------------------------------
// GET /api/v1/engine/health — sonde de disponibilité de l'API moteur.
//
// Non authentifiée (les sondes d'uptime n'ont pas de jeton), ne renvoie AUCUNE
// donnée : juste l'état et la version du moteur, pour qu'un client détecte un
// changement de contrat.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";

import { ENGINE_VERSION } from "@/lib/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const res = NextResponse.json({ ok: true, engineVersion: ENGINE_VERSION, ts: new Date().toISOString() });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
