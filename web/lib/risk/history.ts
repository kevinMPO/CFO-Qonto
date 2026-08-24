// ---------------------------------------------------------------------------
// Historique des analyses — mémoire de l'entreprise.
//
// Persiste chaque score dans LibSQL (même base que la mémoire Mastra). Permet
// "cette société avait 15.8 lors de la dernière analyse" (§16) et pose le socle
// de la surveillance périodique (§17 : détecter une variation > seuil).
//
// Léger : dépend seulement de @libsql/client (pas de tout le harnais Mastra),
// pour rester utilisable côté serveur sans coût.
// ---------------------------------------------------------------------------

import path from "node:path";
import fs from "node:fs";
import { createClient, type Client } from "@libsql/client";
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

let _client: Client | null = null;
let _ready: Promise<void> | null = null;

function client(): Client {
  if (!_client) {
    const authToken = process.env.RISK_DB_AUTH_TOKEN;
    _client = createClient({ url: dbUrl(), ...(authToken ? { authToken } : {}) });
  }
  return _client;
}

async function ready(): Promise<void> {
  if (!_ready) {
    _ready = client()
      .execute(
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
      )
      .then(() => {});
  }
  return _ready;
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
  await ready();
  await client().execute({
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

/** Renvoie l'analyse précédente (la plus récente déjà en base) pour ce SIREN. */
export async function getPreviousAnalysis(
  siren: string,
): Promise<{ combinedScore: number | null; date: string } | null> {
  await ready();
  const res = await client().execute({
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
  await ready();
  const res = await client().execute({
    sql: `SELECT * FROM risk_history WHERE siren = ? ORDER BY created_at DESC LIMIT ?`,
    args: [siren, limit],
  });
  return res.rows.map((r) => ({
    siren: String(r.siren),
    combinedScore: (r.combined_score as number | null) ?? null,
    financialScore: (r.financial_score as number | null) ?? null,
    externalScore: (r.external_score as number) ?? 0,
    band: String(r.band ?? ""),
    critical: !!r.critical,
    createdAt: String(r.created_at),
  }));
}
