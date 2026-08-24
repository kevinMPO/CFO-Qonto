// ---------------------------------------------------------------------------
// Historique des analyses — mémoire de l'entreprise.
//
// Persiste chaque score dans LibSQL (même base que la mémoire Mastra) : permet
// "cette société avait 15.8 lors de la dernière analyse" (§16) et pose le socle
// de la surveillance périodique (§17).
//
// Robustesse serverless : @libsql/client (binaire natif) est importé
// DYNAMIQUEMENT ; si indisponible, l'historique devient un no-op silencieux
// (l'analyse fonctionne quand même, sans persistance cross-requête).
// ---------------------------------------------------------------------------

import path from "node:path";
import fs from "node:fs";
import type { RiskScore } from "./types";

function dbUrl(): string {
  if (process.env.RISK_DB_URL) return process.env.RISK_DB_URL;
  const base = process.env.VERCEL ? "/tmp" : path.join(process.cwd(), ".data");
  try {
    fs.mkdirSync(base, { recursive: true });
  } catch {
    /* déjà présent */
  }
  return `file:${path.join(base, "risk.db")}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any;

let _clientPromise: Promise<Client | null> | null = null;
async function client(): Promise<Client | null> {
  if (!_clientPromise) {
    _clientPromise = (async () => {
      try {
        const { createClient } = await import("@libsql/client");
        const authToken = process.env.RISK_DB_AUTH_TOKEN;
        const c = createClient({ url: dbUrl(), ...(authToken ? { authToken } : {}) });
        await c.execute(
          `CREATE TABLE IF NOT EXISTS risk_history (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             siren TEXT NOT NULL,
             combined_score REAL,
             financial_score REAL,
             external_score REAL,
             band TEXT,
             critical INTEGER DEFAULT 0,
             created_at TEXT NOT NULL
           )`,
        );
        return c;
      } catch (err) {
        console.error("Historique LibSQL indisponible — persistance désactivée", err);
        return null;
      }
    })();
  }
  return _clientPromise;
}

export interface HistoryEntry {
  siren: string;
  combinedScore: number | null;
  financialScore: number | null;
  externalScore: number;
  band: string;
  critical: boolean;
  createdAt: string;
}

export async function saveAnalysis(siren: string, score: RiskScore, nowIso?: string): Promise<void> {
  const c = await client();
  if (!c) return;
  await c.execute({
    sql: `INSERT INTO risk_history
      (siren, combined_score, financial_score, external_score, band, critical, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      siren,
      score.combinedScore,
      score.financialScore,
      score.externalSignalsScore,
      score.band,
      score.criticalEvent ? 1 : 0,
      nowIso ?? new Date().toISOString(),
    ],
  });
}

/** Analyse précédente (la plus récente déjà en base) pour ce SIREN, ou null. */
export async function getPreviousAnalysis(
  siren: string,
): Promise<{ combinedScore: number | null; date: string } | null> {
  const c = await client();
  if (!c) return null;
  const res = await c.execute({
    sql: `SELECT combined_score, external_score, created_at
          FROM risk_history WHERE siren = ? ORDER BY created_at DESC LIMIT 1`,
    args: [siren],
  });
  const row = res.rows[0];
  if (!row) return null;
  const combined = row.combined_score as number | null;
  return {
    combinedScore: combined ?? (row.external_score as number | null) ?? null,
    date: String(row.created_at),
  };
}

/** Série historique (pour la surveillance future §17). */
export async function getHistory(siren: string, limit = 24): Promise<HistoryEntry[]> {
  const c = await client();
  if (!c) return [];
  const res = await c.execute({
    sql: `SELECT * FROM risk_history WHERE siren = ? ORDER BY created_at DESC LIMIT ?`,
    args: [siren, limit],
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return res.rows.map((r: any) => ({
    siren: String(r.siren),
    combinedScore: (r.combined_score as number | null) ?? null,
    financialScore: (r.financial_score as number | null) ?? null,
    externalScore: (r.external_score as number) ?? 0,
    band: String(r.band ?? ""),
    critical: !!r.critical,
    createdAt: String(r.created_at),
  }));
}
