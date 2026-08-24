// ---------------------------------------------------------------------------
// Donnees financieres — N et N-1.
//
// Source GRATUITE (recherche-entreprises → champ `finances`) : uniquement CA et
// resultat net, sur quelques exercices. C'est PARTIEL : EBE, capitaux propres,
// dettes, tresorerie… ne sont pas fournis → ils restent `null` (jamais 0), et le
// moteur ne publiera pas de score financier tant que < 3 dimensions calculables.
//
// Enrichissement complet = INPI RNE (comptes annuels). Hook `enrichFromInpi`
// laissé pret : branché seulement si un token INPI est configuré. Sans lui, on
// reste honnete : finances partielles, score porte par les signaux externes.
// ---------------------------------------------------------------------------

import type { Financials, FinancialYear } from "./types";

const EMPTY_YEAR = (exercice: string | null): FinancialYear => ({
  exercice,
  chiffreAffaires: null,
  ebe: null,
  resultatNet: null,
  capitauxPropres: null,
  dettesFinancieres: null,
  tresorerie: null,
  chargesFinancieres: null,
  creancesClients: null,
  dettesFournisseurs: null,
});

type RawFinances = Record<string, { ca?: number | null; resultat_net?: number | null }> | undefined;

/**
 * Construit des Financials partiels depuis le champ `finances` de
 * recherche-entreprises (deja recupere par fetchCompanyIdentity → raw.finances).
 * On ne remplit QUE ce qui existe reellement (CA, resultat). Le reste = null.
 */
export function financialsFromRne(rawFinances: RawFinances): Financials {
  const years = Object.keys(rawFinances ?? {}).sort().reverse(); // plus recent d'abord
  const build = (y: string | undefined): FinancialYear | null => {
    if (!y) return null;
    const f = (rawFinances ?? {})[y] ?? {};
    const fy = EMPTY_YEAR(y);
    fy.chiffreAffaires = typeof f.ca === "number" ? f.ca : null;
    fy.resultatNet = typeof f.resultat_net === "number" ? f.resultat_net : null;
    return fy;
  };
  const n = build(years[0]);
  const nMinus1 = build(years[1]);
  return { source: n ? "RNE" : null, n, nMinus1 };
}

/**
 * Point d'extension : enrichit des Financials avec les comptes annuels INPI RNE
 * si un token est fourni (env `INPI_TOKEN`). Non branché en V1 (pas de clé) :
 * renvoie les finances telles quelles. La structure permet de brancher l'API
 * INPI plus tard sans changer les appelants.
 */
export async function enrichFromInpi(
  siren: string,
  partial: Financials,
  _fetchImpl: typeof fetch = fetch,
): Promise<Financials> {
  const token = process.env.INPI_TOKEN;
  if (!token) return partial; // pas de clé → on reste sur les finances partielles
  // TODO(inpi): GET api.inpi.fr comptes-annuels/{siren} avec Bearer token,
  // mapper EBE / capitaux propres / dettes / tresorerie vers FinancialYear.
  // Laisse volontairement les champs a null tant que le mapping n'est pas verifie.
  return partial;
}
