"use client";

import { useState } from "react";

// ---------------------------------------------------------------------------
// /risk — carte ARGENTIER RISK (PRD §15). Une entrée SIREN → une carte lisible.
// Le LLM n'a rien calculé : tous les /20 viennent du moteur déterministe.
// ---------------------------------------------------------------------------

type Dim = { key: string; label: string; note: number | null; applied: boolean };
type Signal = { type: string; title: string; sentiment: string; confidence: string; sourceUrl: string; sourceName: string | null; date: string | null };
type Critical = { kind: string; title: string; date: string | null; sourceUrl: string; sourceName: string | null } | null;
type Result = {
  identity: { siren: string; raisonSociale: string | null; naf: string | null; ville: string | null; dirigeant: string | null };
  score: {
    financialScore: number | null;
    externalSignalsScore: number;
    combinedScore: number | null;
    band: string;
    criticalEvent: Critical;
    dimensions: Dim[];
    dataQuality: { hasFinancials: boolean };
  };
  signals: Signal[];
  explanation: { strengths: string[]; watchpoints: string[]; analysis: string };
  sources: { name: string; url: string | null; date: string | null }[];
  previous: { combinedScore: number | null; date: string } | null;
  meta: { usedAgent: boolean; searchesRun: number };
};

const BAND_LABEL: Record<string, string> = {
  TRES_FAIBLE: "Risque très faible",
  FAIBLE: "Risque faible",
  MODERE: "Risque modéré",
  ELEVE: "Risque élevé",
  TRES_ELEVE: "Risque très élevé",
  CRITIQUE: "Risque critique",
};
const BAND_COLOR: Record<string, string> = {
  TRES_FAIBLE: "#0a7d34",
  FAIBLE: "#2f9e44",
  MODERE: "#b8860b",
  ELEVE: "#e8590c",
  TRES_ELEVE: "#c92a2a",
  CRITIQUE: "#c92a2a",
};

const CSS = `
.rk-wrap{max-width:640px;margin:0 auto;padding:40px 20px;font-family:'Inter',system-ui,sans-serif;color:#111110;}
.rk-h{font-family:'Space Grotesk','Inter',sans-serif;font-weight:700;letter-spacing:-.02em;font-size:15px;text-transform:uppercase;color:#111110;}
.rk-sub{color:#6b6b66;font-size:13px;margin:4px 0 22px;}
.rk-form{display:flex;gap:8px;margin-bottom:24px;}
.rk-in{flex:1;padding:12px 14px;border:1.5px solid #e3e3dd;border-radius:10px;font-size:15px;font-variant-numeric:tabular-nums;outline:none;}
.rk-in:focus{border-color:#111110;}
.rk-btn{padding:12px 20px;background:#111110;color:#F5D312;border:none;border-radius:10px;font-weight:600;font-size:14px;cursor:pointer;}
.rk-btn:disabled{opacity:.5;cursor:default;}
.rk-err{color:#c92a2a;font-size:14px;padding:10px 0;}
.rk-card{border:1.5px solid #e3e3dd;border-radius:16px;padding:24px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.04);}
.rk-name{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:20px;}
.rk-meta{color:#6b6b66;font-size:12.5px;font-variant-numeric:tabular-nums;margin-top:2px;}
.rk-score{text-align:center;margin:18px 0 6px;}
.rk-score b{font-family:'Space Grotesk',sans-serif;font-size:56px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;}
.rk-score span{color:#6b6b66;font-size:20px;}
.rk-band{text-align:center;font-weight:700;font-size:14px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:16px;}
.rk-subs{display:flex;gap:10px;margin:16px 0;}
.rk-subcell{flex:1;border:1px solid #eee;border-radius:10px;padding:10px 12px;}
.rk-subcell .l{font-size:11.5px;color:#6b6b66;text-transform:uppercase;letter-spacing:.03em;}
.rk-subcell .v{font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:18px;font-variant-numeric:tabular-nums;}
.rk-crit{background:#fff0f0;border:1.5px solid #ffc9c9;border-radius:12px;padding:14px 16px;margin:16px 0;}
.rk-crit .t{color:#c92a2a;font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.03em;}
.rk-list{list-style:none;padding:0;margin:8px 0;}
.rk-list li{font-size:14px;padding:3px 0;}
.rk-analysis{font-size:14px;line-height:1.6;color:#33332f;margin:14px 0;white-space:pre-wrap;}
.rk-sec{font-size:11.5px;color:#6b6b66;text-transform:uppercase;letter-spacing:.04em;margin:18px 0 6px;font-weight:600;}
.rk-src a{color:#111110;font-size:13px;text-decoration:none;border-bottom:1px solid #ddd;}
.rk-src a:hover{border-color:#111110;}
.rk-prev{font-size:12.5px;color:#6b6b66;margin-top:14px;font-variant-numeric:tabular-nums;}
.rk-note{font-size:11.5px;color:#8a8a84;margin-top:18px;line-height:1.5;}
`;

export default function RiskPage() {
  const [siren, setSiren] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<Result | null>(null);

  const run = async () => {
    const s = siren.replace(/\D/g, "");
    if (s.length !== 9) {
      setError("Entre un SIREN de 9 chiffres.");
      return;
    }
    setLoading(true);
    setError(null);
    setRes(null);
    try {
      const r = await fetch("/api/risk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siren: s }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Analyse impossible.");
      setRes(data as Result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur réseau.");
    } finally {
      setLoading(false);
    }
  };

  const headline = res ? res.score.combinedScore ?? res.score.externalSignalsScore : null;

  return (
    <>
      <style>{CSS}</style>
      <div className="rk-wrap">
        <div className="rk-h">Argentier Risk</div>
        <div className="rk-sub">Analyse de risque d’une entreprise française à partir de son SIREN. Le moteur calcule, l’agent explique.</div>

        <div className="rk-form">
          <input
            className="rk-in"
            placeholder="SIREN (9 chiffres) — ex. 819489626"
            value={siren}
            onChange={(e) => setSiren(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
            inputMode="numeric"
          />
          <button className="rk-btn" onClick={run} disabled={loading}>
            {loading ? "Analyse…" : "Analyser"}
          </button>
        </div>

        {error && <div className="rk-err">{error}</div>}

        {res && (
          <div className="rk-card">
            <div className="rk-name">{res.identity.raisonSociale ?? "Entreprise"}</div>
            <div className="rk-meta">
              SIREN {res.identity.siren}
              {res.identity.naf ? ` · ${res.identity.naf}` : ""}
              {res.identity.ville ? ` · ${res.identity.ville}` : ""}
              {res.identity.dirigeant ? ` · ${res.identity.dirigeant}` : ""}
            </div>

            <div className="rk-score">
              <b>{headline ?? "—"}</b>
              <span> /20</span>
            </div>
            <div className="rk-band" style={{ color: BAND_COLOR[res.score.band] ?? "#111" }}>
              {BAND_LABEL[res.score.band] ?? res.score.band}
            </div>

            <div className="rk-subs">
              <div className="rk-subcell">
                <div className="l">Financier</div>
                <div className="v">{res.score.financialScore ?? "n.d."}{res.score.financialScore !== null ? " /20" : ""}</div>
              </div>
              <div className="rk-subcell">
                <div className="l">Signaux externes</div>
                <div className="v">{res.score.externalSignalsScore} /20</div>
              </div>
            </div>

            {res.score.criticalEvent && (
              <div className="rk-crit">
                <div className="t">⚠ Procédure collective détectée</div>
                <div style={{ marginTop: 4, fontSize: 14 }}>
                  {res.score.criticalEvent.kind} — {res.score.criticalEvent.title}
                  {res.score.criticalEvent.date ? ` (${res.score.criticalEvent.date})` : ""}
                </div>
                <div className="rk-src" style={{ marginTop: 4 }}>
                  <a href={res.score.criticalEvent.sourceUrl} target="_blank" rel="noopener noreferrer">
                    {res.score.criticalEvent.sourceName ?? "Source"}
                  </a>
                </div>
              </div>
            )}

            {res.explanation.strengths.length > 0 && (
              <>
                <div className="rk-sec">Points forts</div>
                <ul className="rk-list">
                  {res.explanation.strengths.map((x, i) => (
                    <li key={i}>✓ {x}</li>
                  ))}
                </ul>
              </>
            )}
            {res.explanation.watchpoints.length > 0 && (
              <>
                <div className="rk-sec">Points de vigilance</div>
                <ul className="rk-list">
                  {res.explanation.watchpoints.map((x, i) => (
                    <li key={i}>⚠ {x}</li>
                  ))}
                </ul>
              </>
            )}

            {res.explanation.analysis && (
              <>
                <div className="rk-sec">Analyse Argentier</div>
                <div className="rk-analysis">{res.explanation.analysis}</div>
              </>
            )}

            {res.sources.length > 0 && (
              <>
                <div className="rk-sec">{res.sources.length} source(s) — cliquables</div>
                <ul className="rk-list rk-src">
                  {res.sources.map((s, i) => (
                    <li key={i}>
                      → {s.url ? (
                        <a href={s.url} target="_blank" rel="noopener noreferrer">{s.name}{s.date ? ` — ${s.date}` : ""}</a>
                      ) : (
                        <span>{s.name}{s.date ? ` — ${s.date}` : ""}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}

            {res.previous && (
              <div className="rk-prev">
                Analyse précédente : {res.previous.combinedScore ?? "—"}/20 le {new Date(res.previous.date).toLocaleDateString("fr-FR")}.
              </div>
            )}

            <div className="rk-note">
              {res.score.dataQuality.hasFinancials
                ? "Score financier calculé sur les comptes disponibles (RNE)."
                : "Comptes financiers non divulgués publiquement — score porté par les signaux externes sourcés."}{" "}
              Read-only · le moteur calcule chaque note, l’agent n’explique que des chiffres déjà calculés.
            </div>
          </div>
        )}
      </div>
    </>
  );
}
