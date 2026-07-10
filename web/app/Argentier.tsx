"use client";

/**
 * Argentier — front d'entrée, bilingue FR / EN.
 * Au montage, il fetch /api/analyze (Qonto → Claude → engine.ts). Tant que la
 * réponse n'arrive pas — ou si l'API échoue — il affiche les données mock.
 * La langue est persistée (localStorage) et transmise à Claude (lettres, benchmark).
 */

import React, { useEffect, useMemo, useState } from "react";
import type { AnalyzeResult, Lang, Lever, Nature, Risk } from "@/lib/types";
import { buildPlanCsv, planFilename } from "@/lib/export";
import { MOCK } from "@/lib/mock";
import { detectLang, eur as eurFmt, natureLabel, PITCH, riskLabel, tr } from "@/lib/i18n";
import { EUROPE_PATHS, EUROPE_VIEWBOX, EU_CITY_XY } from "@/lib/europeMap";

// Rend un texte avec emphase **...** → <strong>.
function emph(text: string, keyBase: string): React.ReactNode[] {
  return text.split("**").map((seg, i) =>
    i % 2 === 1 ? <strong key={`${keyBase}-${i}`}>{seg}</strong> : <React.Fragment key={`${keyBase}-${i}`}>{seg}</React.Fragment>,
  );
}

const RISK_COLOR: Record<Risk, string> = {
  safe: "var(--c-vert)",
  med: "var(--c-amber)",
  hard: "var(--c-clay)",
};

const NATURE_COLOR: Record<Nature, string> = {
  structurel: "var(--c-ink2)",
  ponctuel: "var(--c-amber)",
  perso: "var(--c-line-strong)",
  pilotable: "var(--c-vert)",
};

// Entreprises flottant sur la carte d'Europe (hero du pitch).
// La position (x/y en % du viewBox) vient de EU_CITY_XY, reprojetée avec la
// carte. t = taille (1 petit … 3 grand) ; cfo = la rare entreprise (les 10%)
// qui a un DAF → bulle verte.
type EuCo = { city: string; t: 1 | 2 | 3; cfo?: boolean };
const EU_COMPANIES: EuCo[] = [
  { city: "London", t: 3 },
  { city: "Dublin", t: 1 },
  { city: "Paris", t: 3, cfo: true },
  { city: "Amsterdam", t: 2 },
  { city: "Bruxelles", t: 1 },
  { city: "Berlin", t: 3 },
  { city: "Warszawa", t: 2 },
  { city: "Praha", t: 1 },
  { city: "München", t: 2 },
  { city: "Wien", t: 2 },
  { city: "Zürich", t: 1 },
  { city: "Milano", t: 2 },
  { city: "Roma", t: 2 },
  { city: "Madrid", t: 2 },
  { city: "Barcelona", t: 1, cfo: true },
  { city: "Lisboa", t: 1 },
  { city: "Stockholm", t: 1 },
  { city: "København", t: 1 },
];

// Compteur animé, respecte prefers-reduced-motion. Se relance quand `trigger` change.
function useCountUp(target: number, trigger: unknown, ms = 900) {
  const [val, setVal] = useState(0);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setVal(target);
      setReady(true);
      return;
    }
    setReady(false);
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
      else setReady(true);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);
  return { val, ready };
}

export default function Argentier() {
  const [lang, setLang] = useState<Lang>("fr");
  const [data, setData] = useState<AnalyzeResult>(MOCK);
  const [levers, setLevers] = useState(MOCK.levers);
  const [horizon, setHorizon] = useState(12);
  const [loaded, setLoaded] = useState(false);

  const T = tr(lang);
  const eur = (n: number) => eurFmt(n, lang);

  useEffect(() => {
    const saved =
      typeof window !== "undefined" ? window.localStorage.getItem("argentier-lang") : null;
    setLang(saved === "en" || saved === "fr" ? saved : detectLang(navigator.language));
  }, []);

  const changeLang = (l: Lang) => {
    setLang(l);
    try {
      window.localStorage.setItem("argentier-lang", l);
    } catch {
      /* stockage indisponible — pas grave */
    }
  };

  // --- Présentation / elevator pitch ---------------------------------------
  const [pitchOpen, setPitchOpen] = useState(false);
  useEffect(() => {
    if (!pitchOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPitchOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pitchOpen]);

  useEffect(() => {
    let alive = true;
    fetch("/api/analyze")
      .then((r) => r.json())
      .then((d: AnalyzeResult) => {
        if (!alive) return;
        setData(d);
        setLevers(d.levers);
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  const monthly = useMemo(
    () => levers.filter((l) => l.active).reduce((s, l) => s + l.saving, 0),
    [levers],
  );
  const annual = monthly * 12;
  const optimized = data.totals.runRate - monthly;
  const pct = data.totals.runRate > 0 ? Math.round((monthly / data.totals.runRate) * 100) : 0;

  const { val: heroVal, ready } = useCountUp(annual, loaded);
  const shownAnnual = ready ? annual : heroVal;

  const toggle = (id: string) =>
    setLevers((ls) => ls.map((l) => (l.id === id ? { ...l, active: !l.active } : l)));
  const setAll = (fn: (l: (typeof levers)[number]) => boolean) =>
    setLevers((ls) => ls.map((l) => ({ ...l, active: fn(l) })));

  // --- Export du plan (CSV / Excel) ----------------------------------------
  const exportCsv = () => {
    const csv = buildPlanCsv({ ...data, levers }, levers);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = planFilename(data);
    a.click();
    URL.revokeObjectURL(url);
  };

  // --- Tiroir « lettre prête à envoyer » + benchmark web -------------------
  type LetterSource = { name: string; price: string; date: string; url: string };
  type BenchAlt = { name: string; monthlyPrice: number | null; unit: string; sourceUrl: string; sourceDate: string };
  type BenchResult = {
    verified: boolean;
    note?: string;
    alternatives: BenchAlt[];
    sources: { title: string; url: string; date: string }[];
    bestSaving: number;
    bestAlternative: string | null;
    provider?: "linkup" | "claude";
  };

  const [letterFor, setLetterFor] = useState<Lever | null>(null);
  const [letterText, setLetterText] = useState("");
  const [letterLoading, setLetterLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [bench, setBench] = useState<BenchResult | null>(null);
  const [benchLoading, setBenchLoading] = useState(false);

  const openLetter = async (l: Lever, sources?: LetterSource[]) => {
    setLetterFor(l);
    setLetterText("");
    setCopied(false);
    if (!sources) setBench(null);
    setLetterLoading(true);
    try {
      const res = await fetch("/api/letter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchant: l.label,
          action: l.action ?? "renegotiate",
          alternative: l.to,
          savingMonthly: l.saving,
          savingAnnual: l.saving * 12,
          lang,
          sources,
        }),
      });
      const json = await res.json();
      setLetterText(json.letter ?? "…");
    } catch {
      setLetterText(lang === "en" ? "Network error — try again." : "Erreur réseau — réessaie.");
    } finally {
      setLetterLoading(false);
    }
  };

  const runBenchmark = async (l: Lever) => {
    setBenchLoading(true);
    setBench(null);
    try {
      const res = await fetch("/api/benchmark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchant: l.label, category: l.to, monthly: l.monthly ?? 0, lang }),
      });
      setBench(await res.json());
    } catch {
      setBench({ verified: false, note: T.benchNone, alternatives: [], sources: [], bestSaving: 0, bestAlternative: null });
    } finally {
      setBenchLoading(false);
    }
  };

  const regenerateWithPrices = () => {
    if (!letterFor || !bench) return;
    const sources: LetterSource[] = bench.alternatives
      .filter((a) => a.monthlyPrice != null)
      .map((a) => ({
        name: a.name,
        price: `${a.monthlyPrice} €${a.unit || "/mois"}`,
        date: a.sourceDate,
        url: a.sourceUrl,
      }));
    openLetter(letterFor, sources);
  };

  const copyLetter = async () => {
    try {
      await navigator.clipboard.writeText(letterText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard indisponible */
    }
  };

  const natureTotal = data.natures.reduce((s, n) => s + n.amount, 0) || 1;
  const maxPole = Math.max(1, ...data.poles.map((p) => p.amount));
  const scoreDash = `${data.score.value} ${100 - data.score.value}`;

  return (
    <div className="arg-root">
      <style>{CSS}</style>

      {/* Barre */}
      <header className="arg-top">
        <div className="arg-brand">
          <span className="arg-mark"><ArgLogo /></span>
          <span className="arg-word">Argentier</span>
          <span className="arg-chip">
            {data.account.name} · {data.account.bank}
          </span>
          <span className={"arg-src " + (data.meta?.source === "qonto" ? "live" : "demo")}>
            ● {data.meta?.source === "qonto" ? T.srcLive : T.srcDemo}
            {data.meta?.categorized === "claude" ? ` · ${T.byClaude}` : ""}
          </span>
        </div>
        <div className="arg-top-right">
          <button className="arg-pitch-open" onClick={() => setPitchOpen(true)}>
            ▶ {T.pitch}
          </button>
          <div className="arg-lang" role="group" aria-label="Language">
            {(["fr", "en"] as Lang[]).map((l) => (
              <button
                key={l}
                className={"arg-lang-btn" + (lang === l ? " on" : "")}
                onClick={() => changeLang(l)}
                aria-pressed={lang === l}
              >
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          <span className="arg-window">{data.window.label[lang]}</span>
        </div>
      </header>

      {/* Hero */}
      <section className="arg-hero">
        <div>
          <p className="arg-eyebrow">{loaded ? T.heroEyebrow : T.analyzing}</p>
          <p className={"arg-figure" + (loaded ? "" : " loading")} aria-live="polite">
            {eur(shownAnnual)}
          </p>
          <p className="arg-sub">{T.heroSub(eur(monthly))}</p>
          <button className="arg-cta">{T.cta}</button>
        </div>

        <div className="arg-hero-side">
          <div className="arg-score">
            <svg viewBox="0 0 36 36" width="84" height="84" aria-hidden="true">
              <circle className="arg-score-bg" cx="18" cy="18" r="15.9155" />
              <circle
                className="arg-score-fg"
                cx="18"
                cy="18"
                r="15.9155"
                strokeDasharray={scoreDash}
                strokeDashoffset="25"
              />
            </svg>
            <div className="arg-score-num">
              <strong>{data.score.value}</strong>
              <span>/100</span>
            </div>
            <p className="arg-score-cap">{T.scoreCap}</p>
          </div>
          <div className="arg-runway">
            <span className="arg-runway-num">
              {T.months(data.runway.months.toLocaleString(lang === "en" ? "en-US" : "fr-FR"))}
            </span>
            <span className="arg-runway-cap">{T.treso(data.runway.note[lang])}</span>
          </div>
        </div>
      </section>

      {/* Barre ledger — natures */}
      <section className="arg-card">
        <div className="arg-card-head">
          <span className="arg-card-title">{T.ledgerTitle}</span>
          <span className="arg-muted arg-mono">{T.thisMonth(eur(data.totals.out))}</span>
        </div>
        <div className="arg-ledger" role="img" aria-label={T.natureAria}>
          {data.natures.map((n) => (
            <div
              key={n.key}
              className="arg-ledger-seg"
              style={{ width: `${(n.amount / natureTotal) * 100}%`, background: NATURE_COLOR[n.key] }}
              title={`${natureLabel(n.key, lang)} ${eur(n.amount)}`}
            />
          ))}
        </div>
        <div className="arg-legend">
          {data.natures.map((n) => (
            <span key={n.key} className="arg-legend-item">
              <i style={{ background: NATURE_COLOR[n.key] }} /> {natureLabel(n.key, lang)}{" "}
              <b className="arg-mono">{eur(n.amount)}</b>
            </span>
          ))}
        </div>
      </section>

      {/* Metric cards */}
      <section className="arg-metrics">
        <Metric label={T.mRunrate} value={eur(data.totals.runRate) + "/m"} note={T.mRunrateNote(eur(data.totals.runRate * 12))} />
        <Metric label={T.mActive} value={eur(monthly) + "/m"} accent note={T.mActiveNote(eur(annual))} />
        <Metric label={T.mOptimized} value={eur(optimized) + "/m"} note={T.mOptimizedNote(pct)} />
      </section>

      {/* Détail pilotable par pôle */}
      <section className="arg-card">
        <div className="arg-card-head">
          <span className="arg-card-title">{T.polesTitle}</span>
        </div>
        <div className="arg-bars">
          {data.poles.map((p) => (
            <div key={p.label} className="arg-bar-row">
              <span className="arg-bar-label">{p.label}</span>
              <div className="arg-bar-track">
                <div className="arg-bar-fill" style={{ width: `${(p.amount / maxPole) * 100}%` }} />
              </div>
              <span className="arg-bar-val arg-mono">{eur(p.amount)}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Simulateur */}
      <section className="arg-card">
        <div className="arg-card-head">
          <span className="arg-card-title">{T.simTitle}</span>
          <span className="arg-muted">{T.simRecovered(pct)}</span>
        </div>

        <div className="arg-sim-read">
          <SimStat label={T.perMonth} value={eur(monthly)} accent />
          <SimStat label={T.perYear} value={eur(annual)} />
          <SimStat label={T.cumul(horizon)} value={eur(monthly * horizon)} />
          <SimStat label={T.optimizedRunrate} value={eur(optimized)} />
        </div>

        <div className="arg-horizon">
          <label htmlFor="hz">{T.horizon}</label>
          <input
            id="hz"
            type="range"
            min={1}
            max={36}
            value={horizon}
            onChange={(e) => setHorizon(parseInt(e.target.value, 10))}
          />
          <span className="arg-mono">{T.hMonths(horizon)}</span>
        </div>

        <div className="arg-progress">
          <div style={{ width: `${pct}%` }} />
        </div>

        <div className="arg-levers">
          {levers.map((l) => (
            <div key={l.id} className={"arg-lever" + (l.active ? " on" : "")}>
              <button className="arg-lever-toggle" onClick={() => toggle(l.id)} aria-pressed={l.active}>
                <span className="arg-check" aria-hidden="true">
                  {l.active ? "✓" : ""}
                </span>
                <span className="arg-lever-txt">
                  {l.label} <span className="arg-muted">→ {l.to}</span>
                </span>
                <span className="arg-risk" style={{ color: RISK_COLOR[l.risk] }}>
                  {riskLabel(l.risk, lang)}
                </span>
                <span className="arg-lever-save arg-mono">{l.saving} €</span>
              </button>
              <button
                className="arg-lever-letter"
                onClick={() => openLetter(l)}
                title={T.letterFor(l.label)}
                aria-label={T.letterFor(l.label)}
              >
                ✎
              </button>
            </div>
          ))}
        </div>

        <div className="arg-actions">
          <button className="arg-btn" onClick={() => setAll((l) => l.risk === "safe")}>
            {T.quickWins}
          </button>
          <button className="arg-btn" onClick={() => setAll(() => true)}>
            {T.enableAll}
          </button>
          <button className="arg-btn" onClick={() => setAll(() => false)}>
            {T.disableAll}
          </button>
          <a className="arg-btn" href={`/rapport?lang=${lang}`} target="_blank" rel="noopener">
            {T.printable}
          </a>
          <button className="arg-btn arg-btn-ghost" onClick={exportCsv}>
            {T.exportCsv}
          </button>
        </div>
        <p className="arg-hint">{T.leverHint}</p>
      </section>

      {/* Anomalies */}
      <section className="arg-card">
        <div className="arg-card-head">
          <span className="arg-card-title">{T.anomTitle}</span>
        </div>
        <ul className="arg-flux">
          {data.flux.map((f, i) => (
            <li key={i} className="arg-flux-row">
              <span className={"arg-dot " + f.tone} aria-hidden="true" />
              <span className="arg-flux-label">{f.label[lang]}</span>
              <span className={"arg-flux-val arg-mono " + f.tone}>{f.value[lang]}</span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="arg-foot">
        {data.meta?.source === "mock"
          ? T.footMock
          : T.footReal(data.meta?.txCount ?? 0, data.meta?.categorized === "claude")}
        {T.footPrivacy}
      </footer>

      {/* Tiroir : lettre prête à envoyer (gate humain) */}
      {letterFor && (
        <div className="arg-drawer-wrap" role="dialog" aria-modal="true" aria-label={letterFor.label}>
          <div className="arg-drawer-backdrop" onClick={() => setLetterFor(null)} />
          <aside className="arg-drawer">
            <div className="arg-drawer-head">
              <div>
                <p className="arg-drawer-eyebrow">{T.drawerEyebrow}</p>
                <h3 className="arg-drawer-title">{letterFor.label}</h3>
              </div>
              <button className="arg-drawer-close" onClick={() => setLetterFor(null)} aria-label={T.close}>
                ✕
              </button>
            </div>

            {letterLoading ? (
              <div className="arg-drawer-loading">{T.drawerLoading}</div>
            ) : (
              <textarea
                className="arg-drawer-text arg-mono"
                value={letterText}
                onChange={(e) => setLetterText(e.target.value)}
                spellCheck={false}
              />
            )}

            <div className="arg-drawer-actions">
              <button className="arg-btn" onClick={() => openLetter(letterFor)} disabled={letterLoading}>
                {T.regenerate}
              </button>
              <button className="arg-btn arg-btn-ghost" onClick={copyLetter} disabled={letterLoading || !letterText}>
                {copied ? T.copied : T.copy}
              </button>
            </div>

            {/* Benchmark web — sur accord (règle 3) */}
            <div className="arg-bench">
              <div className="arg-bench-head">
                <span className="arg-bench-title">{T.benchTitle}</span>
                <button className="arg-btn arg-bench-btn" onClick={() => runBenchmark(letterFor)} disabled={benchLoading}>
                  {benchLoading ? "…" : bench ? T.benchRerun : T.benchSource}
                </button>
              </div>

              {benchLoading && <p className="arg-bench-hint">{T.benchSearching}</p>}

              {bench && !benchLoading && (
                <>
                  {bench.bestSaving > 0 && bench.bestAlternative && (
                    <p className="arg-bench-best mono">{T.benchBest(bench.bestSaving, bench.bestAlternative)}</p>
                  )}
                  {bench.alternatives.length > 0 ? (
                    <ul className="arg-bench-list">
                      {bench.alternatives.map((a, i) => (
                        <li key={i}>
                          <span className="arg-bench-alt">{a.name}</span>
                          {a.monthlyPrice != null && (
                            <span className="mono arg-bench-price">
                              {a.monthlyPrice} €{a.unit}
                            </span>
                          )}
                          {a.sourceUrl && (
                            <a href={a.sourceUrl} target="_blank" rel="noopener" className="arg-bench-src">
                              {T.benchSourceLink(a.sourceDate)}
                            </a>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="arg-bench-hint">{bench.note ?? T.benchNone}</p>
                  )}
                  {bench.alternatives.some((a) => a.monthlyPrice != null) && (
                    <button className="arg-btn arg-bench-inject" onClick={regenerateWithPrices}>
                      {T.benchInject}
                    </button>
                  )}
                  {bench.provider && <p className="arg-bench-via">{T.benchVia(bench.provider)}</p>}
                </>
              )}
            </div>

            <p className="arg-drawer-note">{T.drawerNote}</p>
          </aside>
        </div>
      )}

      {/* Présentation — elevator pitch bilingue */}
      {pitchOpen && (
        <div className="arg-pitch" role="dialog" aria-modal="true" aria-label={T.pitchKicker}>
          <div className="arg-pitch-bar">
            <span className="arg-pitch-brand">
              <span className="arg-mark"><ArgLogo /></span> Argentier
            </span>
            <div className="arg-pitch-controls">
              <div className="arg-lang" role="group" aria-label="Language">
                {(["fr", "en"] as Lang[]).map((l) => (
                  <button
                    key={l}
                    className={"arg-lang-btn" + (lang === l ? " on" : "")}
                    onClick={() => changeLang(l)}
                    aria-pressed={lang === l}
                  >
                    {l.toUpperCase()}
                  </button>
                ))}
              </div>
              <button className="arg-drawer-close" onClick={() => setPitchOpen(false)} aria-label={T.close}>
                ✕
              </button>
            </div>
          </div>

          <div className="arg-pitch-scroll">
            <div className="arg-pitch-inner">
              <p className="arg-pitch-kicker">{T.pitchKicker}</p>

              <div className="arg-eu" aria-hidden="true">
                <svg
                  className="arg-eu-map"
                  viewBox={EUROPE_VIEWBOX}
                  preserveAspectRatio="xMidYMid meet"
                  dangerouslySetInnerHTML={{ __html: EUROPE_PATHS }}
                />

                {EU_COMPANIES.map((c, i) => (
                  <span
                    key={c.city}
                    className={"arg-eu-co t" + c.t + (c.cfo ? " cfo" : "")}
                    style={{
                      left: EU_CITY_XY[c.city][0] + "%",
                      top: EU_CITY_XY[c.city][1] + "%",
                      animationDelay: (i % 6) * -0.9 + "s",
                      animationDuration: 3.6 + (i % 5) * 0.45 + "s",
                    }}
                  >
                    <b className="arg-eu-dot">{c.cfo ? "★" : "▪"}</b>
                    <em className="arg-eu-city">{c.city}</em>
                  </span>
                ))}

                <div className="arg-eu-title">
                  <span className="arg-pitch-num">{PITCH[lang].hookNum}</span>
                  <span className="arg-pitch-hookcap">{PITCH[lang].hookCap}</span>
                </div>
              </div>
              {PITCH[lang].paras.map((p, i) => (
                <p key={i} className="arg-pitch-para">
                  {emph(p, `p${i}`)}
                </p>
              ))}
              <p className="arg-pitch-tagline">{PITCH[lang].tagline}</p>

              {/* Architecture — anglais, pour le jury hackathon */}
              <section className="arg-arch">
                <p className="arg-arch-kicker">Architecture</p>
                <h3 className="arg-arch-title">One brain, split in two — on purpose.</h3>
                <p className="arg-arch-lede">
                  Argentier is a <strong>Claude Code Skill</strong> wired to live <strong>MCP servers</strong>.
                  The LLM orchestrates and explains; a deterministic engine does every euro. The model
                  never touches the math — that&apos;s what makes every figure auditable.
                </p>

                <div className="arg-arch-flow" aria-label="pipeline">
                  {["Observe", "Analyse", "Benchmark", "Recommend", "Gate", "Ledger", "Verify"].map((s, i) => (
                    <span key={s} className="arg-arch-step">
                      <b>{String(i + 1).padStart(2, "0")}</b>
                      {s}
                    </span>
                  ))}
                </div>

                <div className="arg-arch-grid">
                  <div className="arg-arch-card">
                    <div className="arg-arch-head">
                      <i className="lock" /> Qonto MCP <span className="arg-arch-tag green">read-only</span>
                    </div>
                    <p className="arg-arch-desc">Reads the real account, live.</p>
                    <code className="arg-arch-tools">get_organization · list_transactions · list_labels · list_transaction_attachments</code>
                    <p className="arg-arch-foot">Every write / transfer / card tool is <b>hard-denied</b> (deny&nbsp;&gt;&nbsp;allow). It cannot move money.</p>
                  </div>

                  <div className="arg-arch-card">
                    <div className="arg-arch-head">
                      <i className="calc" /> Argentier <span className="arg-arch-tag ink">deterministic</span>
                    </div>
                    <p className="arg-arch-desc">Does every euro. Never the model.</p>
                    <code className="arg-arch-tools">recurrence · ×12 annualization · duplicates · FX fees · PRO / PERSO / TO&#8209;CLARIFY</code>
                    <p className="arg-arch-foot">Same rules ported to <b>engine.ts</b> for the web dashboard.</p>
                  </div>

                  <div className="arg-arch-card">
                    <div className="arg-arch-head">
                      <i className="src" /> Linkup MCP <span className="arg-arch-tag amber">sourced + dated</span>
                    </div>
                    <p className="arg-arch-desc">Benchmarks prices on the live web.</p>
                    <code className="arg-arch-tools">linkup-search</code>
                    <p className="arg-arch-foot">Only merchant + category leave the machine. Every price carries a <b>source URL + date</b>, or it&apos;s dropped.</p>
                  </div>
                </div>

                <div className="arg-arch-rails">
                  {[
                    "Read-only Qonto",
                    "Engine computes, not the LLM",
                    "Zero PII to the web",
                    "Price = source + date",
                  ].map((r, i) => (
                    <span key={r} className="arg-arch-rail">
                      <b>{i + 1}</b>
                      {r}
                    </span>
                  ))}
                </div>

                <p className="arg-arch-close">
                  MCP&#8209;native. Read&#8209;only by construction. Human&#8209;in&#8209;the&#8209;loop by design.
                </p>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Marque Argentier : chevron « A » + barres ascendantes (le run-rate qui monte).
function ArgLogo() {
  return (
    <svg className="arg-logo" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path
        d="M5.5 25.5 L16 5.5 L26.5 25.5"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <rect x="12" y="19.5" width="2.3" height="6" rx="0.7" className="arg-logo-bar" />
      <rect x="15.4" y="16.5" width="2.3" height="9" rx="0.7" className="arg-logo-bar" />
      <rect x="18.8" y="13.5" width="2.3" height="12" rx="0.7" className="arg-logo-bar" />
    </svg>
  );
}

function Metric({ label, value, note, accent }: { label: string; value: string; note?: string; accent?: boolean }) {
  return (
    <div className="arg-metric">
      <p className="arg-metric-label">{label}</p>
      <p className={"arg-metric-val arg-mono" + (accent ? " accent" : "")}>{value}</p>
      {note && <p className="arg-metric-note">{note}</p>}
    </div>
  );
}

function SimStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="arg-simstat">
      <p className={"arg-simstat-val arg-mono" + (accent ? " accent" : "")}>{value}</p>
      <p className="arg-simstat-label">{label}</p>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap');

.arg-root{
  --c-paper:#FAFAF7; --c-ink:#17140F; --c-ink2:#5B554C;
  --c-line:#E4E0D6; --c-line-strong:#B8B2A5;
  --c-vert:#2F6F5B; --c-vert-soft:#E7F0EC; --c-amber:#B9812B; --c-clay:#A9432B;
  --r:14px;
  max-width:860px; margin:0 auto; padding:28px 20px 48px;
  background:var(--c-paper); color:var(--c-ink);
  font-family:'Inter',system-ui,sans-serif; line-height:1.5;
  -webkit-font-smoothing:antialiased;
}
.arg-root *{box-sizing:border-box;}
.arg-mono{font-family:'JetBrains Mono',ui-monospace,monospace; font-variant-numeric:tabular-nums;}

.arg-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px;gap:12px;flex-wrap:wrap;}
.arg-brand{display:flex;align-items:center;gap:10px;}
.arg-mark{width:30px;height:30px;border-radius:8px;background:var(--c-ink);color:var(--c-paper);
  display:flex;align-items:center;justify-content:center;font-family:'Space Grotesk';font-size:18px;flex:none;}
.arg-logo{width:66%;height:66%;display:block;}
.arg-logo-bar{fill:var(--c-amber);}
.arg-word{font-family:'Space Grotesk';font-weight:600;font-size:18px;letter-spacing:-.01em;}
.arg-chip{font-size:11px;color:var(--c-ink2);border:1px solid var(--c-line);border-radius:99px;padding:3px 10px;}
.arg-src{font-size:11px;font-weight:700;padding:3px 9px;border-radius:99px;white-space:nowrap;letter-spacing:.01em;}
.arg-src.live{background:var(--c-vert-soft);color:var(--c-vert);border:1px solid color-mix(in srgb,var(--c-vert) 32%,transparent);}
.arg-src.demo{background:color-mix(in srgb,var(--c-amber) 13%,transparent);color:var(--c-amber);border:1px solid color-mix(in srgb,var(--c-amber) 30%,transparent);}
.arg-top-right{display:flex;align-items:center;gap:12px;}
.arg-window{font-size:12px;color:var(--c-ink2);}
.arg-figure.loading{opacity:.5;animation:argPulse 1s ease-in-out infinite;}
@keyframes argPulse{0%,100%{opacity:.4}50%{opacity:.72}}
@media(prefers-reduced-motion:reduce){.arg-figure.loading{animation:none;opacity:1;}}
.arg-lang{display:inline-flex;border:1px solid var(--c-line);border-radius:8px;overflow:hidden;}
.arg-lang-btn{border:0;background:#fff;color:var(--c-ink2);font-family:inherit;font-size:11px;font-weight:600;
  padding:4px 9px;cursor:pointer;transition:background .1s,color .1s;}
.arg-lang-btn.on{background:var(--c-ink);color:var(--c-paper);}
.arg-lang-btn:not(.on):hover{background:var(--c-vert-soft);}
.arg-pitch-open{border:1px solid var(--c-vert);background:var(--c-vert);color:#fff;border-radius:8px;
  font-family:inherit;font-size:12px;font-weight:600;padding:5px 12px;cursor:pointer;transition:transform .08s ease,opacity .1s;}
.arg-pitch-open:hover{transform:translateY(-1px);opacity:.94;}

/* Présentation plein écran */
.arg-pitch{position:fixed;inset:0;z-index:60;background:var(--c-paper);display:flex;flex-direction:column;
  animation:argFade .25s ease;}
@keyframes argFade{from{opacity:0}to{opacity:1}}
.arg-pitch-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:16px 22px;border-bottom:1px solid var(--c-line);flex:none;}
.arg-pitch-brand{display:flex;align-items:center;gap:9px;font-family:'Space Grotesk';font-weight:600;font-size:17px;}
.arg-pitch-controls{display:flex;align-items:center;gap:12px;}
.arg-pitch-scroll{flex:1;overflow:auto;}
.arg-pitch-inner{max-width:760px;margin:0 auto;padding:min(9vh,72px) 24px 96px;}
.arg-pitch-kicker{font-size:12px;text-transform:uppercase;letter-spacing:.16em;color:var(--c-vert);
  font-weight:700;margin:0 0 22px;}
/* Hero : carte d'Europe + entreprises flottantes */
.arg-eu{position:relative;width:100%;aspect-ratio:1000/626;max-height:60vh;margin:0 0 34px;
  padding-bottom:22px;border-bottom:1px solid var(--c-line);isolation:isolate;}
.arg-eu-map{position:absolute;inset:0;width:100%;height:100%;z-index:0;}
.arg-eu-map path{fill:color-mix(in srgb,var(--c-vert) 15%,transparent);
  stroke:color-mix(in srgb,var(--c-vert) 42%,transparent);stroke-width:1;
  stroke-linejoin:round;vector-effect:non-scaling-stroke;}
.arg-eu-co{position:absolute;z-index:1;transform:translate(-50%,-50%);
  display:flex;flex-direction:column;align-items:center;gap:2px;
  animation:argFloat 4s ease-in-out infinite;will-change:transform;pointer-events:none;}
.arg-eu-dot{display:flex;align-items:center;justify-content:center;border-radius:50%;
  background:#fff;color:var(--c-ink2);border:1px solid var(--c-line-strong);
  box-shadow:0 3px 10px rgba(23,20,15,.10);line-height:1;font-style:normal;}
.arg-eu-co.t1 .arg-eu-dot{width:16px;height:16px;font-size:7px;}
.arg-eu-co.t2 .arg-eu-dot{width:22px;height:22px;font-size:9px;}
.arg-eu-co.t3 .arg-eu-dot{width:30px;height:30px;font-size:12px;}
.arg-eu-co.cfo .arg-eu-dot{background:var(--c-vert);color:#fff;border-color:var(--c-vert);
  box-shadow:0 4px 14px color-mix(in srgb,var(--c-vert) 45%,transparent);}
.arg-eu-city{font-style:normal;font-size:9.5px;font-weight:600;color:var(--c-ink2);
  letter-spacing:.01em;white-space:nowrap;opacity:.68;
  text-shadow:0 1px 3px var(--c-paper),0 0 3px var(--c-paper);}
.arg-eu-co.cfo .arg-eu-city{color:var(--c-vert);opacity:1;}
.arg-eu-co.t1 .arg-eu-city{font-size:8px;opacity:.5;}
@keyframes argFloat{0%,100%{transform:translate(-50%,-50%)}50%{transform:translate(-50%,calc(-50% - 8px))}}

.arg-eu-title{position:absolute;left:2px;top:6px;z-index:2;max-width:min(64%,420px);
  display:flex;flex-direction:column;gap:2px;}
.arg-pitch-num{font-family:'JetBrains Mono',ui-monospace,monospace;font-weight:600;
  font-size:clamp(64px,13vw,120px);line-height:.86;color:var(--c-vert);letter-spacing:-.03em;
  text-shadow:0 2px 20px var(--c-paper),0 0 8px var(--c-paper);}
.arg-pitch-hookcap{font-family:'Space Grotesk';font-weight:600;font-size:clamp(18px,3vw,28px);
  color:var(--c-ink);max-width:340px;letter-spacing:-.01em;line-height:1.12;
  text-shadow:0 1px 10px var(--c-paper),0 0 6px var(--c-paper);}
@media(prefers-reduced-motion:reduce){.arg-eu-co{animation:none;}}
@media(max-width:560px){.arg-eu-city{display:none;}
  .arg-eu-co.cfo .arg-eu-city{display:block;}
  .arg-eu-co.t1 .arg-eu-dot{width:12px;height:12px;}}
.arg-pitch-para{font-size:clamp(17px,2.1vw,21px);line-height:1.62;color:var(--c-ink2);margin:0 0 22px;text-wrap:pretty;}
.arg-pitch-para strong{color:var(--c-ink);font-weight:600;}
.arg-pitch-tagline{font-family:'Space Grotesk';font-weight:600;font-size:clamp(24px,4.2vw,38px);
  line-height:1.15;color:var(--c-vert);letter-spacing:-.02em;margin:14px 0 0;text-wrap:balance;
  padding-top:26px;border-top:2px solid var(--c-ink);}
@media(prefers-reduced-motion:reduce){.arg-pitch{animation:none;}}

/* Architecture (bas du pitch deck) */
.arg-arch{margin-top:64px;padding-top:34px;border-top:1px solid var(--c-line);}
.arg-arch-kicker{font-size:12px;text-transform:uppercase;letter-spacing:.16em;color:var(--c-vert);
  font-weight:700;margin:0 0 12px;}
.arg-arch-title{font-family:'Space Grotesk';font-weight:600;font-size:clamp(24px,3.6vw,34px);
  letter-spacing:-.02em;line-height:1.1;color:var(--c-ink);margin:0 0 14px;}
.arg-arch-lede{font-size:clamp(15px,1.7vw,18px);line-height:1.6;color:var(--c-ink2);margin:0 0 26px;
  max-width:620px;text-wrap:pretty;}
.arg-arch-lede strong{color:var(--c-ink);font-weight:600;}

.arg-arch-flow{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 28px;}
.arg-arch-step{display:inline-flex;align-items:center;gap:7px;padding:7px 13px 7px 9px;
  border:1px solid var(--c-line);border-radius:99px;background:#fff;
  font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--c-ink);text-transform:uppercase;}
.arg-arch-step b{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:10px;font-weight:600;
  color:#fff;background:var(--c-vert);border-radius:6px;padding:2px 5px;letter-spacing:0;}
.arg-arch-step:last-child{border-color:color-mix(in srgb,var(--c-vert) 40%,transparent);
  background:var(--c-vert-soft);color:var(--c-vert);}

.arg-arch-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:0 0 26px;}
.arg-arch-card{border:1px solid var(--c-line);border-radius:var(--r);background:#fff;
  padding:18px;display:flex;flex-direction:column;}
.arg-arch-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  font-family:'JetBrains Mono',ui-monospace,monospace;font-weight:600;font-size:14px;color:var(--c-ink);}
.arg-arch-head i{width:11px;height:11px;flex:none;border-radius:3px;}
.arg-arch-head i.lock{background:var(--c-vert);}
.arg-arch-head i.calc{background:var(--c-ink);}
.arg-arch-head i.src{background:var(--c-amber);}
.arg-arch-tag{font-family:'Inter',sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;
  letter-spacing:.04em;padding:2px 7px;border-radius:99px;white-space:nowrap;}
.arg-arch-tag.green{background:var(--c-vert-soft);color:var(--c-vert);}
.arg-arch-tag.ink{background:color-mix(in srgb,var(--c-ink) 8%,transparent);color:var(--c-ink);}
.arg-arch-tag.amber{background:color-mix(in srgb,var(--c-amber) 15%,transparent);color:var(--c-amber);}
.arg-arch-desc{font-size:14px;font-weight:500;color:var(--c-ink);margin:12px 0 10px;line-height:1.4;}
.arg-arch-tools{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;line-height:1.6;
  color:var(--c-ink2);background:var(--c-paper);border:1px solid var(--c-line);border-radius:8px;
  padding:9px 11px;display:block;word-break:break-word;}
.arg-arch-foot{font-size:12px;line-height:1.5;color:var(--c-ink2);margin:11px 0 0;}
.arg-arch-foot b{color:var(--c-ink);font-weight:600;}

.arg-arch-rails{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;
  padding:16px;border:1px solid var(--c-line);border-radius:var(--r);
  background:var(--c-vert-soft);margin:0 0 22px;}
.arg-arch-rail{display:flex;align-items:center;gap:9px;font-size:12.5px;font-weight:600;color:var(--c-ink);}
.arg-arch-rail b{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:11px;color:#fff;
  background:var(--c-vert);width:19px;height:19px;flex:none;border-radius:50%;
  display:flex;align-items:center;justify-content:center;}
.arg-arch-close{font-family:'Space Grotesk';font-weight:600;font-size:clamp(15px,1.9vw,19px);
  color:var(--c-vert);letter-spacing:-.01em;margin:0;text-wrap:balance;}
@media(max-width:720px){.arg-arch-grid{grid-template-columns:1fr;}
  .arg-arch-rails{grid-template-columns:repeat(2,1fr);}}

.arg-hero{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;
  padding:26px;border:1px solid var(--c-line);border-radius:var(--r);background:#fff;margin-bottom:12px;}
.arg-eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--c-ink2);margin:0 0 10px;}
.arg-figure{font-family:'JetBrains Mono';font-variant-numeric:tabular-nums;font-weight:600;
  font-size:clamp(38px,7vw,56px);line-height:1;color:var(--c-vert);margin:0;letter-spacing:-.02em;}
.arg-sub{font-size:14px;color:var(--c-ink2);margin:12px 0 0;}
.arg-cta{margin-top:18px;background:var(--c-ink);color:var(--c-paper);border:0;border-radius:10px;
  padding:11px 18px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;transition:transform .08s ease;}
.arg-cta:hover{transform:translateY(-1px);}
.arg-hero-side{display:flex;flex-direction:column;align-items:center;gap:14px;flex:none;}
.arg-score{position:relative;text-align:center;}
.arg-score-bg{fill:none;stroke:var(--c-vert-soft);stroke-width:3;}
.arg-score-fg{fill:none;stroke:var(--c-vert);stroke-width:3;stroke-linecap:round;transform:rotate(-90deg);transform-origin:center;}
.arg-score-num{position:absolute;inset:0;top:30px;display:flex;flex-direction:column;align-items:center;line-height:1;}
.arg-score-num strong{font-family:'JetBrains Mono';font-size:22px;color:var(--c-vert);}
.arg-score-num span{font-size:10px;color:var(--c-ink2);}
.arg-score-cap{font-size:11px;color:var(--c-ink2);margin:6px 0 0;}
.arg-runway{text-align:center;border:1px solid var(--c-line);border-radius:10px;padding:8px 14px;}
.arg-runway-num{display:block;font-family:'JetBrains Mono';font-weight:600;font-size:15px;}
.arg-runway-cap{font-size:10px;color:var(--c-ink2);}

.arg-card{border:1px solid var(--c-line);border-radius:var(--r);background:#fff;padding:18px 20px;margin-bottom:12px;}
.arg-card-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px;gap:10px;}
.arg-card-title{font-family:'Space Grotesk';font-weight:600;font-size:15px;}
.arg-muted{color:var(--c-ink2);font-size:12px;}

.arg-ledger{display:flex;height:16px;border-radius:6px;overflow:hidden;margin-bottom:10px;}
.arg-ledger-seg{height:100%;}
.arg-legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--c-ink2);}
.arg-legend-item{display:flex;align-items:center;gap:6px;}
.arg-legend-item i{width:9px;height:9px;border-radius:2px;display:inline-block;}
.arg-legend-item b{color:var(--c-ink);font-weight:600;}

.arg-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:12px;}
.arg-metric{border:1px solid var(--c-line);border-radius:var(--r);background:#fff;padding:16px 18px;}
.arg-metric-label{font-size:12px;color:var(--c-ink2);margin:0 0 6px;}
.arg-metric-val{font-size:22px;font-weight:600;margin:0;}
.arg-metric-val.accent{color:var(--c-vert);}
.arg-metric-note{font-size:11px;color:var(--c-ink2);margin:5px 0 0;}

.arg-bars{display:flex;flex-direction:column;gap:9px;}
.arg-bar-row{display:grid;grid-template-columns:170px 1fr 64px;align-items:center;gap:12px;}
.arg-bar-label{font-size:12px;color:var(--c-ink2);}
.arg-bar-track{height:9px;background:var(--c-vert-soft);border-radius:5px;overflow:hidden;}
.arg-bar-fill{height:100%;background:var(--c-vert);border-radius:5px;}
.arg-bar-val{font-size:12px;text-align:right;}

.arg-sim-read{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;}
.arg-simstat-val{font-size:20px;font-weight:600;margin:0;}
.arg-simstat-val.accent{color:var(--c-vert);}
.arg-simstat-label{font-size:11px;color:var(--c-ink2);margin:3px 0 0;}

.arg-horizon{display:flex;align-items:center;gap:12px;margin-bottom:12px;font-size:13px;color:var(--c-ink2);}
.arg-horizon input{flex:1;accent-color:var(--c-vert);}
.arg-progress{height:8px;background:var(--c-line);border-radius:5px;overflow:hidden;margin-bottom:16px;}
.arg-progress>div{height:100%;background:var(--c-vert);transition:width .2s ease;}

.arg-levers{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:8px;}
.arg-lever{display:flex;align-items:stretch;border:1px solid var(--c-line);border-radius:10px;
  background:#fff;overflow:hidden;transition:border-color .1s,background .1s;}
.arg-lever:hover{border-color:var(--c-line-strong);}
.arg-lever.on{border-color:var(--c-vert);background:var(--c-vert-soft);}
.arg-lever-toggle{flex:1;display:flex;align-items:center;gap:10px;padding:10px 12px;border:0;
  background:transparent;cursor:pointer;text-align:left;font-family:inherit;color:inherit;}
.arg-lever-letter{flex:none;width:42px;border:0;border-left:1px solid var(--c-line);background:transparent;
  cursor:pointer;font-size:15px;color:var(--c-ink2);transition:background .1s,color .1s;}
.arg-lever-letter:hover{background:var(--c-vert-soft);color:var(--c-vert);}
.arg-lever.on .arg-lever-letter{border-left-color:color-mix(in srgb,var(--c-vert) 30%,transparent);}
.arg-check{width:18px;height:18px;border-radius:5px;border:1.5px solid var(--c-line-strong);
  display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;flex:none;}
.arg-lever.on .arg-check{background:var(--c-vert);border-color:var(--c-vert);}
.arg-lever-txt{flex:1;font-size:13px;}
.arg-risk{font-size:11px;white-space:nowrap;}
.arg-lever-save{font-size:13px;font-weight:600;min-width:46px;text-align:right;}

.arg-hint{font-size:11px;color:var(--c-ink2);margin:12px 0 0;}

/* Tiroir lettre */
.arg-drawer-wrap{position:fixed;inset:0;z-index:50;display:flex;justify-content:flex-end;}
.arg-drawer-backdrop{position:absolute;inset:0;background:rgba(23,20,15,.32);}
.arg-drawer{position:relative;width:min(520px,100%);height:100%;background:var(--c-paper);
  border-left:1px solid var(--c-line);box-shadow:-8px 0 30px rgba(23,20,15,.12);
  display:flex;flex-direction:column;padding:22px 22px 18px;overflow:auto;}
.arg-drawer-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:14px;}
.arg-drawer-eyebrow{font-size:10px;text-transform:uppercase;letter-spacing:.09em;font-weight:700;
  color:var(--c-vert);margin:0 0 4px;}
.arg-drawer-title{font-family:'Space Grotesk';font-weight:600;font-size:20px;margin:0;letter-spacing:-.01em;}
.arg-drawer-close{border:1px solid var(--c-line);background:#fff;border-radius:8px;width:32px;height:32px;
  cursor:pointer;font-size:14px;color:var(--c-ink2);flex:none;}
.arg-drawer-close:hover{border-color:var(--c-line-strong);}
.arg-drawer-loading{flex:1;display:flex;align-items:center;justify-content:center;color:var(--c-ink2);
  font-size:14px;border:1px dashed var(--c-line);border-radius:10px;margin-bottom:12px;min-height:220px;}
.arg-drawer-text{flex:1;min-height:340px;width:100%;resize:vertical;border:1px solid var(--c-line);
  border-radius:10px;padding:14px;font-size:12.5px;line-height:1.6;color:var(--c-ink);background:#fff;
  margin-bottom:12px;white-space:pre-wrap;}
.arg-drawer-text:focus{outline:2px solid var(--c-vert);outline-offset:1px;}
.arg-drawer-actions{display:flex;gap:8px;}
.arg-drawer-actions .arg-btn{flex:1;text-align:center;}
.arg-drawer-note{font-size:11px;color:var(--c-ink2);margin:10px 0 0;text-align:center;}

.arg-bench{margin-top:16px;padding-top:14px;border-top:1px solid var(--c-line);}
.arg-bench-head{display:flex;align-items:center;justify-content:space-between;gap:10px;}
.arg-bench-title{font-family:'Space Grotesk';font-weight:600;font-size:13px;}
.arg-bench-btn{font-size:12px;padding:6px 11px;}
.arg-bench-hint{font-size:12px;color:var(--c-ink2);margin:10px 0 0;}
.arg-bench-best{font-size:12px;font-weight:600;color:var(--c-vert);margin:10px 0 0;}
.arg-bench-via{font-size:10.5px;color:var(--c-ink2);margin:10px 0 0;text-align:right;font-style:italic;}
.arg-bench-list{list-style:none;margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:7px;}
.arg-bench-list li{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:12.5px;
  padding-bottom:7px;border-bottom:1px solid var(--c-line);}
.arg-bench-alt{font-weight:600;}
.arg-bench-price{color:var(--c-vert);}
.arg-bench-src{font-size:11px;color:var(--c-ink2);text-decoration:underline;margin-left:auto;}
.arg-bench-src:hover{color:var(--c-vert);}
.arg-bench-inject{width:100%;margin-top:12px;font-size:12.5px;}
@media(max-width:680px){.arg-drawer{width:100%;}}

.arg-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;}
.arg-btn{border:1px solid var(--c-line);background:#fff;border-radius:9px;padding:8px 14px;
  font-size:13px;cursor:pointer;font-family:inherit;color:var(--c-ink);transition:border-color .1s;text-decoration:none;display:inline-block;}
.arg-btn:hover{border-color:var(--c-line-strong);}
.arg-btn-ghost{margin-left:auto;background:var(--c-ink);color:var(--c-paper);border-color:var(--c-ink);}

.arg-flux{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;}
.arg-flux-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-top:1px solid var(--c-line);}
.arg-flux-row:first-child{border-top:0;}
.arg-dot{width:8px;height:8px;border-radius:99px;flex:none;background:var(--c-ink2);}
.arg-dot.amber{background:var(--c-amber);} .arg-dot.danger{background:var(--c-clay);} .arg-dot.neutral{background:var(--c-line-strong);}
.arg-flux-label{flex:1;font-size:13px;}
.arg-flux-val{font-size:13px;font-weight:600;}
.arg-flux-val.danger{color:var(--c-clay);} .arg-flux-val.amber{color:var(--c-amber);}

.arg-foot{font-size:11px;color:var(--c-ink2);text-align:center;margin-top:20px;}

.arg-lever-toggle:focus-visible,.arg-lever-letter:focus-visible,.arg-btn:focus-visible,.arg-cta:focus-visible,.arg-lang-btn:focus-visible,.arg-horizon input:focus-visible{
  outline:2px solid var(--c-vert);outline-offset:2px;}

@media(max-width:680px){
  .arg-hero{flex-direction:column;} .arg-hero-side{flex-direction:row;align-self:stretch;justify-content:space-between;}
  .arg-metrics{grid-template-columns:1fr;} .arg-sim-read{grid-template-columns:repeat(2,1fr);}
  .arg-bar-row{grid-template-columns:120px 1fr 58px;}
}
@media(prefers-reduced-motion:reduce){.arg-cta,.arg-progress>div{transition:none;}}
`;
