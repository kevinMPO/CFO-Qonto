// ---------------------------------------------------------------------------
// Identite entreprise — via l'API publique recherche-entreprises.api.gouv.fr
// (GRATUIT, sans clé). On envoie UNIQUEMENT le SIREN (donnee publique) ; on ne
// fait que LIRE. Sert de socle au recoupement anti-homonyme des signaux Linkup.
// ---------------------------------------------------------------------------

import type { CompanyIdentity } from "./types";

const BASE = "https://recherche-entreprises.api.gouv.fr/search";

/** Normalise un SIREN : 9 chiffres, sinon lève. */
export function normalizeSiren(input: string): string {
  const s = (input || "").replace(/\D/g, "");
  if (s.length !== 9) throw new Error(`SIREN invalide (attendu 9 chiffres) : "${input}"`);
  return s;
}

interface RawResult {
  siren?: string;
  nom_complet?: string;
  nom_raison_sociale?: string;
  activite_principale?: string;
  section_activite_principale?: string;
  date_creation?: string;
  etat_administratif?: string;
  siege?: Record<string, unknown>;
  dirigeants?: Array<Record<string, unknown>>;
  complements?: Record<string, unknown>;
  finances?: Record<string, { ca?: number | null; resultat_net?: number | null }>;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function firstDirigeant(dirigeants?: Array<Record<string, unknown>>): string | null {
  const d = (dirigeants ?? [])[0];
  if (!d) return null;
  if (d.type_dirigeant === "personne morale" || d.denomination) return str(d.denomination);
  const prenoms = str(d.prenoms);
  const nom = str(d.nom);
  return [prenoms, nom].filter(Boolean).join(" ") || null;
}

/** Recupere l'identite d'une entreprise a partir de son SIREN. */
export async function fetchCompanyIdentity(
  sirenInput: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ identity: CompanyIdentity; raw: RawResult }> {
  const siren = normalizeSiren(sirenInput);
  const url = `${BASE}?q=${siren}&per_page=1`;
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`recherche-entreprises ${res.status}`);
  const data = (await res.json()) as { results?: RawResult[] };
  const raw = (data.results ?? []).find((r) => r.siren === siren) ?? (data.results ?? [])[0];
  if (!raw) throw new Error(`Aucune entreprise trouvée pour le SIREN ${siren}`);

  const siege = (raw.siege ?? {}) as Record<string, unknown>;
  const identity: CompanyIdentity = {
    siren,
    raisonSociale: str(raw.nom_complet) ?? str(raw.nom_raison_sociale),
    naf: str(raw.activite_principale),
    activite: str(raw.section_activite_principale),
    ville: str(siege.libelle_commune),
    adresse: str(siege.geo_adresse) ?? str(siege.adresse),
    dirigeant: firstDirigeant(raw.dirigeants),
    dateCreation: str(raw.date_creation),
    etatAdministratif: raw.etat_administratif === "A" ? "actif" : raw.etat_administratif ? "cesse" : null,
    siteOfficiel: str((raw.complements ?? {}).site_internet),
  };
  return { identity, raw };
}
