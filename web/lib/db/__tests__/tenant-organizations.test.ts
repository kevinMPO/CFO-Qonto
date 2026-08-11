// ---------------------------------------------------------------------------
// Tests des deux accès « organisation » du flux OAuth :
// getOrganizationById (le cookie de session ne connaît que l'id interne) et
// revokeOrganization (débranchement du compte Qonto).
//
// Ce qu'ils protègent :
//   - l'isolation : la requête porte l'id du locataire, un autre id ne rend
//     rien et ne modifie rien ;
//   - l'absence de concaténation : autant de « ? » que de valeurs bindées, et
//     aucune valeur bindée présente en clair dans le SQL émis ;
//   - la traçabilité : révoquer HORODATE la ligne, il ne la supprime pas.
//
// Ces deux fonctions ne sont plus seulement de la traçabilité : `connected_at`
// et `revoked_at`, relus par `lireSession`, sont ce qui périme un cookie de
// session capturé (cf. lib/auth/session.ts).
//
// Faux D1 minimal, volontairement local à ce fichier : il enregistre le SQL
// émis et n'évalue que les deux formes de requête concernées.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  getOrganizationById,
  revokeOrganization,
  type D1Database,
  type D1PreparedStatement,
  type D1Result,
} from "@/lib/db/tenant";

const T0 = 1_760_000_000_000;

interface LigneOrg extends Record<string, unknown> {
  id: string;
  qonto_org_id: string;
  legal_name: string | null;
  created_at: number;
  connected_at: number | null;
  revoked_at: number | null;
}

/** Faux D1 : deux formes de requête comprises, tout le reste explose. */
class FauxD1 implements D1Database {
  readonly lignes = new Map<string, LigneOrg>();
  readonly emis: Array<{ sql: string; bindings: unknown[] }> = [];

  prepare(requete: string): D1PreparedStatement {
    const sql = requete.replace(/\s+/g, " ").trim();
    const base = this;
    let bindings: unknown[] = [];

    const statement: D1PreparedStatement = {
      bind(...valeurs: unknown[]) {
        bindings = valeurs;
        const marqueurs = (sql.match(/\?/g) ?? []).length;
        if (marqueurs !== valeurs.length) {
          throw new Error(
            `FauxD1 : ${marqueurs} marqueur(s) « ? » pour ${valeurs.length} valeur(s) — ` +
              "une valeur a-t-elle ete concatenee ?",
          );
        }
        base.emis.push({ sql, bindings: valeurs });
        return statement;
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        const correspondance = /^SELECT .+ FROM organizations WHERE id = \?$/.exec(sql);
        if (!correspondance) throw new Error(`FauxD1 : SELECT non gere → « ${sql} ».`);
        const ligne = base.lignes.get(String(bindings[0]));
        return (ligne as T | undefined) ?? null;
      },
      async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        throw new Error("FauxD1 : all() non gere.");
      },
      async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const correspondance =
          /^UPDATE organizations SET revoked_at = \? WHERE id = \? RETURNING id$/.exec(sql);
        if (!correspondance) throw new Error(`FauxD1 : UPDATE non gere → « ${sql} ».`);
        const ligne = base.lignes.get(String(bindings[1]));
        if (!ligne) return { results: [], success: true, meta: { changes: 0 } };
        ligne.revoked_at = bindings[0] as number;
        return {
          results: [{ id: ligne.id } as unknown as T],
          success: true,
          meta: { changes: 1 },
        };
      },
    };

    return statement;
  }
}

function baseAmorcee(): FauxD1 {
  const db = new FauxD1();
  db.lignes.set("org_a", {
    id: "org_a",
    qonto_org_id: "qonto_a",
    legal_name: "MAMFORMA",
    created_at: T0,
    connected_at: T0,
    revoked_at: null,
  });
  db.lignes.set("org_b", {
    id: "org_b",
    qonto_org_id: "qonto_b",
    legal_name: "Acme",
    created_at: T0,
    connected_at: T0,
    revoked_at: null,
  });
  return db;
}

describe("getOrganizationById", () => {
  it("rend l'organisation du locataire demande", async () => {
    const db = baseAmorcee();
    const organisation = await getOrganizationById(db, "org_a");

    expect(organisation).toMatchObject({
      id: "org_a",
      qontoOrgId: "qonto_a",
      legalName: "MAMFORMA",
      revokedAt: null,
    });
  });

  it("borne la lecture a l'id fourni (WHERE id = ?, valeur bindee)", async () => {
    const db = baseAmorcee();
    await getOrganizationById(db, "org_a");

    const { sql, bindings } = db.emis[0];
    expect(sql).toContain("WHERE id = ?");
    expect(bindings).toEqual(["org_a"]);
    expect(sql).not.toContain("org_a");
  });

  it("rend null sur un locataire inconnu ou une tentative d'injection", async () => {
    const db = baseAmorcee();
    await expect(getOrganizationById(db, "org_inconnu")).resolves.toBeNull();
    await expect(getOrganizationById(db, "org_a' OR 1=1 --")).resolves.toBeNull();
  });

  it("refuse un identifiant vide avant toute requete", async () => {
    const db = baseAmorcee();
    await expect(getOrganizationById(db, "  ")).rejects.toThrow(/orgId manquant/);
    expect(db.emis).toHaveLength(0);
  });
});

describe("revokeOrganization", () => {
  it("horodate la revocation sans supprimer la ligne", async () => {
    const db = baseAmorcee();

    await expect(revokeOrganization(db, "org_a", T0 + 1000)).resolves.toBe(true);

    // La traçabilité exige que la ligne survive à la révocation.
    expect(db.lignes.has("org_a")).toBe(true);
    expect(db.lignes.get("org_a")?.revoked_at).toBe(T0 + 1000);
  });

  it("ne touche pas les autres locataires", async () => {
    const db = baseAmorcee();
    await revokeOrganization(db, "org_a", T0 + 1000);

    expect(db.lignes.get("org_b")?.revoked_at).toBeNull();
  });

  it("est idempotent et rend false sur un locataire inconnu", async () => {
    const db = baseAmorcee();

    await expect(revokeOrganization(db, "org_a", T0 + 1000)).resolves.toBe(true);
    await expect(revokeOrganization(db, "org_a", T0 + 2000)).resolves.toBe(true);
    expect(db.lignes.get("org_a")?.revoked_at).toBe(T0 + 2000);

    await expect(revokeOrganization(db, "org_fantome", T0)).resolves.toBe(false);
  });

  it("bind les deux valeurs, n'en concatene aucune", async () => {
    const db = baseAmorcee();
    await revokeOrganization(db, "org_a", T0 + 1000);

    const { sql, bindings } = db.emis[0];
    expect(bindings).toEqual([T0 + 1000, "org_a"]);
    expect(sql).not.toContain("org_a");
    expect(sql).not.toContain(String(T0 + 1000));
  });

  it("refuse un identifiant vide avant toute requete", async () => {
    const db = baseAmorcee();
    await expect(revokeOrganization(db, "", T0)).rejects.toThrow(/orgId manquant/);
    expect(db.emis).toHaveLength(0);
  });
});
