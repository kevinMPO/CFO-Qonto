// ---------------------------------------------------------------------------
// POST /api/risk — CompanyRiskAgent : SIREN → score de risque /20 + explication.
//
//   Mastra orchestre · Linkup MCP cherche · engine.ts score · Claude explique.
//
// READ-ONLY : aucune action externe, aucune écriture. Le score vient
// EXCLUSIVEMENT de `computeRisk` (le LLM ne calcule rien). Sans clés
// Anthropic/Linkup, l'analyse tourne quand même sur identité + finances + BODACC.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";
import {
  messageTropDeRequetes,
  reponseTropDeRequetes,
  verifierDebit,
} from "@/lib/api/rate-limit";
import { analyzeCompany } from "@/lib/risk/orchestrator";

// Mastra + LibSQL sont natifs Node : cette route ne tourne pas sur l'edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // plusieurs recherches web possibles

export async function POST(request: Request) {
  const debit = await verifierDebit(request, "risk");
  if (!debit.autorise) {
    return reponseTropDeRequetes(debit, { error: messageTropDeRequetes(debit) });
  }

  let body: { siren?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Corps JSON invalide" }, { status: 400 });
  }

  const siren = String(body.siren ?? "").replace(/\D/g, "");
  if (siren.length !== 9) {
    return NextResponse.json(
      { error: "SIREN invalide — 9 chiffres attendus." },
      { status: 400 },
    );
  }

  try {
    const result = await analyzeCompany(siren, { orgId: "demo" });
    return NextResponse.json(result);
  } catch (err) {
    console.error("/api/risk a échoué", err);
    const message = err instanceof Error ? err.message : "Erreur inconnue";
    // Un SIREN inexistant remonte ici comme message clair.
    const status = /introuvable|Aucune entreprise/.test(message) ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
