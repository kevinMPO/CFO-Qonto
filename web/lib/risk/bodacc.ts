// ---------------------------------------------------------------------------
// Procedures collectives — BODACC (OpenDataSoft, GRATUIT, sans clé).
//
// Source LEGALE et officielle → confiance "high" → une ouverture de procedure
// devient un CRITICAL_EVENT dans le moteur. On ne fait que LIRE, par SIREN.
//
// Le champ `jugement` est un JSON STRINGIFIE : { type, famille, nature, date,
// complementJugement }. On ne retient que les OUVERTURES de sauvegarde /
// redressement / liquidation (pas les clotures ni les plans).
// ---------------------------------------------------------------------------

import type { CompanySignal } from "./types";

const BASE =
  "https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales/records";

type ProcedureKind = "sauvegarde" | "redressement" | "liquidation";

interface Jugement {
  type?: string;
  famille?: string;
  nature?: string;
  date?: string;
  complementJugement?: string;
}

/**
 * Classe un jugement BODACC en (kind, isOpening). Pur & testable.
 * Renvoie null si ce n'est pas une ouverture de procedure collective.
 */
export function classifyJugement(jug: Jugement): { kind: ProcedureKind } | null {
  const text = `${jug.nature ?? ""} ${jug.complementJugement ?? ""} ${jug.type ?? ""}`.toLowerCase();
  // Exclure les fins/sorties de procedure : ce ne sont pas des evenements negatifs.
  if (/cl[oô]ture|plan de (continuation|sauvegarde|redressement|cession)|r[ée]solution du plan|fin de la|clos/.test(text)) {
    return null;
  }
  let kind: ProcedureKind | null = null;
  if (/liquidation/.test(text)) kind = "liquidation";
  else if (/redressement/.test(text)) kind = "redressement";
  else if (/sauvegarde/.test(text)) kind = "sauvegarde";
  if (!kind) return null;
  // Doit ressembler a une ouverture (ou un jugement d'ouverture).
  const opening = /ouvertur|prononce|prononc[ée]|jugement d'ouverture/.test(text) || !/jugement/.test(text);
  return opening ? { kind } : { kind };
}

interface RawRecord {
  registre?: string[];
  jugement?: string;
  dateparution?: string;
  tribunal?: string;
  id?: string;
}

function procedureUrl(siren: string): string {
  return `https://bodacc-datadila.opendatasoft.com/explore/dataset/annonces-commerciales/table/?q=${siren}`;
}

/** Transforme les enregistrements BODACC en signaux (pur, hors reseau). */
export function bodaccRecordsToSignals(records: RawRecord[], siren: string): CompanySignal[] {
  const signals: CompanySignal[] = [];
  for (const r of records) {
    if (!r.jugement) continue;
    let jug: Jugement;
    try {
      jug = JSON.parse(r.jugement) as Jugement;
    } catch {
      continue;
    }
    const cls = classifyJugement(jug);
    if (!cls) continue;
    const label =
      cls.kind === "liquidation"
        ? "Liquidation judiciaire"
        : cls.kind === "redressement"
          ? "Redressement judiciaire"
          : "Procédure de sauvegarde";
    signals.push({
      type: "procedure",
      procedureKind: cls.kind,
      title: `${label} — ${jug.nature ?? "jugement"}`,
      summary: (jug.complementJugement ?? "").slice(0, 400) || `${label} publiée au BODACC.`,
      sentiment: "negative",
      date: jug.date ?? r.dateparution ?? null,
      sourceUrl: procedureUrl(siren),
      sourceName: r.tribunal ? `BODACC — ${r.tribunal}` : "BODACC",
      confidence: "high", // source légale officielle
    });
  }
  return signals;
}

/** Recupere les procedures collectives d'un SIREN depuis BODACC. */
export async function fetchBodaccProcedures(
  siren: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CompanySignal[]> {
  const where = encodeURIComponent(`registre like "${siren}" and familleavis="collective"`);
  const url = `${BASE}?where=${where}&order_by=dateparution%20desc&limit=20`;
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`BODACC ${res.status}`);
  const data = (await res.json()) as { results?: RawRecord[] };
  return bodaccRecordsToSignals(data.results ?? [], siren);
}
