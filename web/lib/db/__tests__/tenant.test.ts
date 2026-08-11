// ---------------------------------------------------------------------------
// Tests de lib/db/tenant.ts — l'isolation des locataires.
//
// Aucun vrai D1 n'est invoqué. On branche un FAUX D1Database minimal
// (prepare / bind / first / all / run) qui :
//   1. ENREGISTRE chaque requête SQL émise et ses bindings — c'est ce qui
//      permet d'affirmer qu'un WHERE org_id = ? est bien présent et qu'aucune
//      valeur n'a été concaténée dans la chaîne ;
//   2. ÉVALUE un sous-ensemble volontairement étroit de SQL (le seul que
//      tenant.ts émet) sur des tables en mémoire — c'est ce qui permet de
//      prouver qu'une lecture avec un autre orgId ne ramène rien pour de vrai,
//      et pas seulement « en apparence ».
//
// Le faux D1 REFUSE toute construction qu'il ne comprend pas (condition WHERE
// qui n'est pas `colonne <op> ?`, CREATE non idempotent, table inconnue...).
// C'est deliberé : une valeur concatenee dans le SQL ne ressemblerait plus a
// `colonne = ?` et ferait exploser le test au lieu de passer inaperçue.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import {
  appendAudit,
  applyMigrations,
  avecSchema,
  estTableManquante,
  decouperSql,
  depotTenant,
  getOrganizationByQontoId,
  insertDecision,
  listAudit,
  listDecisions,
  promoteToProven,
  SQL_MIGRATION_0001,
  upsertOrganization,
  type D1Database,
  type D1PreparedStatement,
  type D1Result,
} from "@/lib/db/tenant";

// --- Faux D1 ----------------------------------------------------------------

type Ligne = Record<string, unknown>;

interface AppelSql {
  /** SQL tel qu'émis par tenant.ts. */
  sql: string;
  /** Même SQL sans commentaires, espaces compactés (pour les assertions). */
  normalise: string;
  bindings: unknown[];
  methode: "first" | "all" | "run";
}

interface Contrainte {
  colonne: string;
  valeurs: string[];
}

interface Predicat {
  colonne: string;
  operateur: string;
  valeurs: unknown[];
}

/** Retire les commentaires `--` et compacte les espaces. */
function normaliser(sql: string): string {
  return sql
    .split("\n")
    .map((ligne) => ligne.replace(/--.*$/, ""))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

/** Curseur de consommation des bindings, dans l'ordre d'apparition des `?`. */
class Curseur {
  private index = 0;
  constructor(private readonly bindings: unknown[]) {}
  suivant(): unknown {
    if (this.index >= this.bindings.length) {
      throw new Error("FauxD1 : plus de binding disponible pour un `?` de la requete.");
    }
    return this.bindings[this.index++];
  }
  reste(): number {
    return this.bindings.length - this.index;
  }
}

/**
 * Analyse une clause WHERE. N'accepte que `colonne <op> ?` et
 * `colonne IN (?, ?, ...)` : toute autre forme (donc toute valeur écrite en dur
 * dans le SQL) lève une erreur.
 */
function analyserWhere(clause: string, curseur: Curseur): Predicat[] {
  const predicats: Predicat[] = [];
  for (const brut of clause.split(/\s+AND\s+/i)) {
    const condition = brut.trim();

    const dansListe = /^(\w+) IN \(\s*\?(?:\s*,\s*\?)*\s*\)$/i.exec(condition);
    if (dansListe) {
      const nombre = (condition.match(/\?/g) ?? []).length;
      const valeurs: unknown[] = [];
      for (let i = 0; i < nombre; i += 1) valeurs.push(curseur.suivant());
      predicats.push({ colonne: dansListe[1], operateur: "IN", valeurs });
      continue;
    }

    const comparaison = /^(\w+)\s*(=|<=|>=|<|>)\s*\?$/.exec(condition);
    if (comparaison) {
      predicats.push({
        colonne: comparaison[1],
        operateur: comparaison[2],
        valeurs: [curseur.suivant()],
      });
      continue;
    }

    throw new Error(
      `FauxD1 : condition WHERE non parametree ou non supportee → « ${condition} ». ` +
        "Une valeur a-t-elle ete concatenee dans le SQL ?",
    );
  }
  return predicats;
}

function correspond(ligne: Ligne, predicats: Predicat[]): boolean {
  return predicats.every((predicat) => {
    const valeur = ligne[predicat.colonne];
    if (predicat.operateur === "IN") return predicat.valeurs.some((v) => v === valeur);
    if (predicat.operateur === "=") return valeur === predicat.valeurs[0];
    // Comparaisons d'ordre : en SQL, NULL <op> x n'est jamais vrai.
    if (valeur === null || valeur === undefined) return false;
    const gauche = valeur as number;
    const droite = predicat.valeurs[0] as number;
    if (predicat.operateur === "<=") return gauche <= droite;
    if (predicat.operateur === ">=") return gauche >= droite;
    if (predicat.operateur === "<") return gauche < droite;
    return gauche > droite;
  });
}

class FauxD1 implements D1Database {
  /** Journal de TOUTES les requêtes émises, dans l'ordre. */
  readonly appels: AppelSql[] = [];
  readonly tables = new Map<string, Ligne[]>();
  readonly contraintes = new Map<string, Contrainte[]>();
  readonly index: string[] = [];

  prepare(requete: string): D1PreparedStatement {
    return new FauxStatement(this, requete);
  }

  /** Requêtes métier = tout sauf le DDL de migration. */
  appelsMetier(): AppelSql[] {
    return this.appels.filter((appel) => !/^CREATE /i.test(appel.normalise));
  }

  lignes(table: string): Ligne[] {
    const contenu = this.tables.get(table);
    if (!contenu) throw new Error(`FauxD1 : table inconnue « ${table} ».`);
    return contenu;
  }

  private tableRequise(nom: string): Ligne[] {
    const contenu = this.tables.get(nom);
    if (!contenu) {
      throw new Error(`FauxD1 : table « ${nom} » inexistante — applyMigrations n'a pas tourne ?`);
    }
    return contenu;
  }

  verifierContraintes(table: string, ligne: Ligne): void {
    for (const contrainte of this.contraintes.get(table) ?? []) {
      const valeur = ligne[contrainte.colonne];
      if (valeur === undefined || valeur === null) continue;
      if (!contrainte.valeurs.includes(String(valeur))) {
        throw new Error(
          `FauxD1 : CHECK viole sur ${table}.${contrainte.colonne} → « ${String(valeur)} ».`,
        );
      }
    }
  }

  executer(sql: string, bindings: unknown[], methode: AppelSql["methode"]): D1Result<Ligne> {
    const normalise = normaliser(sql);
    this.appels.push({ sql, normalise, bindings, methode });

    if (/^CREATE TABLE/i.test(normalise)) return this.creerTable(normalise);
    if (/^CREATE INDEX/i.test(normalise)) return this.creerIndex(normalise);
    if (/^SELECT /i.test(normalise)) return this.selectionner(normalise, bindings);
    if (/^INSERT /i.test(normalise)) return this.inserer(normalise, bindings);
    if (/^UPDATE /i.test(normalise)) return this.mettreAJour(normalise, bindings);

    throw new Error(`FauxD1 : instruction non supportee → « ${normalise} ».`);
  }

  private resultat(lignes: Ligne[], changements = 0): D1Result<Ligne> {
    return { results: lignes, success: true, meta: { changes: changements } };
  }

  private creerTable(normalise: string): D1Result<Ligne> {
    const entete = /^CREATE TABLE IF NOT EXISTS (\w+) \((.*)\)$/i.exec(normalise);
    if (!entete) {
      throw new Error(`FauxD1 : CREATE TABLE non idempotent ou illisible → « ${normalise} ».`);
    }
    const [, nom, corps] = entete;
    if (!this.tables.has(nom)) this.tables.set(nom, []);

    const contraintes: Contrainte[] = [];
    const motif = /CHECK \((\w+) IN \(([^)]*)\)\)/gi;
    let trouve = motif.exec(corps);
    while (trouve !== null) {
      contraintes.push({
        colonne: trouve[1],
        valeurs: [...trouve[2].matchAll(/'([^']*)'/g)].map((m) => m[1]),
      });
      trouve = motif.exec(corps);
    }
    this.contraintes.set(nom, contraintes);
    return this.resultat([]);
  }

  private creerIndex(normalise: string): D1Result<Ligne> {
    const entete = /^CREATE INDEX IF NOT EXISTS (\w+) ON (\w+) \((.+)\)$/i.exec(normalise);
    if (!entete) {
      throw new Error(`FauxD1 : CREATE INDEX non idempotent ou illisible → « ${normalise} ».`);
    }
    this.tableRequise(entete[2]);
    if (!this.index.includes(entete[1])) this.index.push(entete[1]);
    return this.resultat([]);
  }

  private selectionner(normalise: string, bindings: unknown[]): D1Result<Ligne> {
    const depuis = /\bFROM (\w+)/i.exec(normalise);
    if (!depuis) throw new Error(`FauxD1 : SELECT sans FROM → « ${normalise} ».`);
    let reste = normalise.slice(depuis.index + depuis[0].length);

    let limite: boolean = false;
    const clauseLimite = /\bLIMIT \?\s*$/i.exec(reste);
    if (clauseLimite) {
      limite = true;
      reste = reste.slice(0, clauseLimite.index);
    }

    let tri: string | null = null;
    const clauseTri = /\bORDER BY (.+)$/i.exec(reste);
    if (clauseTri) {
      tri = clauseTri[1].trim();
      reste = reste.slice(0, clauseTri.index);
    }

    const clauseWhere = /\bWHERE (.+)$/i.exec(reste);
    const curseur = new Curseur(bindings);
    const predicats = clauseWhere ? analyserWhere(clauseWhere[1].trim(), curseur) : [];

    let lignes = this.tableRequise(depuis[1]).filter((ligne) => correspond(ligne, predicats));

    if (tri) {
      const [colonne, sens] = tri.split(/\s+/);
      const facteur = (sens ?? "ASC").toUpperCase() === "DESC" ? -1 : 1;
      lignes = [...lignes].sort((a, b) => {
        const x = Number(a[colonne]);
        const y = Number(b[colonne]);
        return x === y ? 0 : (x < y ? -1 : 1) * facteur;
      });
    }

    if (limite) {
      const plafond = Number(curseur.suivant());
      lignes = lignes.slice(0, plafond);
    }
    if (curseur.reste() !== 0) {
      throw new Error(`FauxD1 : ${curseur.reste()} binding(s) non consomme(s) → « ${normalise} ».`);
    }

    return this.resultat(lignes.map((ligne) => ({ ...ligne })));
  }

  private inserer(normalise: string, bindings: unknown[]): D1Result<Ligne> {
    let corps = normalise;

    let retour = false;
    const clauseRetour = /\bRETURNING .+$/i.exec(corps);
    if (clauseRetour) {
      retour = true;
      corps = corps.slice(0, clauseRetour.index).trim();
    }

    let conflit: { colonne: string; affectations: string[] } | null = null;
    const clauseConflit = /\bON CONFLICT\((\w+)\) DO UPDATE SET (.+)$/i.exec(corps);
    if (clauseConflit) {
      conflit = {
        colonne: clauseConflit[1],
        affectations: clauseConflit[2].split(",").map((a) => a.trim()),
      };
      corps = corps.slice(0, clauseConflit.index).trim();
    }

    const entete = /^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)$/i.exec(corps);
    if (!entete) throw new Error(`FauxD1 : INSERT illisible → « ${corps} ».`);
    const table = entete[1];
    const colonnes = entete[2].split(",").map((c) => c.trim());
    const marqueurs = entete[3].split(",").map((m) => m.trim());
    if (marqueurs.some((m) => m !== "?")) {
      throw new Error(`FauxD1 : VALUES contient une valeur en dur → « ${entete[3]} ».`);
    }
    if (marqueurs.length !== colonnes.length) {
      throw new Error("FauxD1 : nombre de colonnes et de `?` differents.");
    }

    const curseur = new Curseur(bindings);
    const nouvelle: Ligne = {};
    for (const colonne of colonnes) nouvelle[colonne] = curseur.suivant();
    if (curseur.reste() !== 0) {
      throw new Error(`FauxD1 : ${curseur.reste()} binding(s) non consomme(s) a l'INSERT.`);
    }

    const contenu = this.tableRequise(table);

    if (conflit) {
      const existante = contenu.find((l) => l[conflit.colonne] === nouvelle[conflit.colonne]);
      if (existante) {
        for (const affectation of conflit.affectations) {
          const paire = /^(\w+) = excluded\.(\w+)$/i.exec(affectation);
          if (!paire) throw new Error(`FauxD1 : affectation ON CONFLICT illisible → « ${affectation} ».`);
          existante[paire[1]] = nouvelle[paire[2]];
        }
        this.verifierContraintes(table, existante);
        return this.resultat(retour ? [{ ...existante }] : [], 1);
      }
    }

    this.verifierContraintes(table, nouvelle);
    contenu.push(nouvelle);
    return this.resultat(retour ? [{ ...nouvelle }] : [], 1);
  }

  private mettreAJour(normalise: string, bindings: unknown[]): D1Result<Ligne> {
    let corps = normalise;

    let retour = false;
    const clauseRetour = /\bRETURNING .+$/i.exec(corps);
    if (clauseRetour) {
      retour = true;
      corps = corps.slice(0, clauseRetour.index).trim();
    }

    const entete = /^UPDATE (\w+) SET (.+?) WHERE (.+)$/i.exec(corps);
    if (!entete) throw new Error(`FauxD1 : UPDATE illisible → « ${corps} ».`);
    const [, table, clauseSet, clauseWhere] = entete;

    const curseur = new Curseur(bindings);
    const affectations: [string, unknown][] = [];
    for (const brut of clauseSet.split(",")) {
      const paire = /^(\w+)\s*=\s*\?$/.exec(brut.trim());
      if (!paire) {
        throw new Error(`FauxD1 : affectation SET non parametree → « ${brut.trim()} ».`);
      }
      affectations.push([paire[1], curseur.suivant()]);
    }

    const predicats = analyserWhere(clauseWhere.trim(), curseur);
    if (curseur.reste() !== 0) {
      throw new Error(`FauxD1 : ${curseur.reste()} binding(s) non consomme(s) a l'UPDATE.`);
    }

    const touchees = this.tableRequise(table).filter((ligne) => correspond(ligne, predicats));
    for (const ligne of touchees) {
      for (const [colonne, valeur] of affectations) ligne[colonne] = valeur;
      this.verifierContraintes(table, ligne);
    }

    return this.resultat(
      retour ? touchees.map((ligne) => ({ ...ligne })) : [],
      touchees.length,
    );
  }
}

class FauxStatement implements D1PreparedStatement {
  private bindings: unknown[] = [];

  constructor(
    private readonly db: FauxD1,
    private readonly sql: string,
  ) {}

  bind(...valeurs: unknown[]): D1PreparedStatement {
    this.bindings = valeurs;
    return this;
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const resultat = this.db.executer(this.sql, this.bindings, "first");
    return (resultat.results[0] ?? null) as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.db.executer(this.sql, this.bindings, "all") as unknown as D1Result<T>;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.db.executer(this.sql, this.bindings, "run") as unknown as D1Result<T>;
  }
}

// --- Jeu d'essai ------------------------------------------------------------

const ORG_A = "org_argentier_a";
const ORG_B = "org_voisin_b";
const T0 = 1_760_000_000_000;
const JOUR = 86_400_000;

/** Base migrée + deux organisations distinctes + une décision chacune. */
async function baseAmorcee(): Promise<FauxD1> {
  const db = new FauxD1();
  await applyMigrations(db);

  await upsertOrganization(db, ORG_A, {
    qontoOrgId: "qonto_a",
    legalName: "Argentier SAS",
    createdAt: T0,
    connectedAt: T0,
  });
  await upsertOrganization(db, ORG_B, {
    qontoOrgId: "qonto_b",
    legalName: "Voisin EI",
    createdAt: T0,
  });

  await insertDecision(db, ORG_A, {
    id: "dec_a1",
    merchant: "Notion",
    lever: "doublon",
    montantMensuelEur: 48,
    economieAnnuelleEur: 576,
    statut: "approuve",
    sourceUrl: "https://www.notion.com/pricing",
    sourceDate: "2026-07-02",
    decidedAt: T0,
    verifyDueAt: T0 + 30 * JOUR,
  });
  await insertDecision(db, ORG_A, {
    id: "dec_a2",
    merchant: "Slack",
    lever: "downgrade",
    montantMensuelEur: 21,
    economieAnnuelleEur: 252,
    statut: "refuse",
    decidedAt: T0 + JOUR,
  });
  await insertDecision(db, ORG_B, {
    id: "dec_b1",
    merchant: "Figma",
    lever: "resiliation",
    montantMensuelEur: 15,
    economieAnnuelleEur: 180,
    statut: "approuve",
    decidedAt: T0,
    verifyDueAt: T0 + 30 * JOUR,
  });
  return db;
}

// --- Tests ------------------------------------------------------------------

describe("migration 0001", () => {
  const cheminSql = fileURLToPath(new URL("../../../db/0001_init.sql", import.meta.url));
  const fichierSql = readFileSync(cheminSql, "utf8");

  it("embarque exactement le contenu de db/0001_init.sql (anti-derive)", () => {
    // Le Worker n'a pas de système de fichiers : le SQL est dupliqué dans
    // tenant.ts. Ce test interdit que les deux copies divergent.
    expect(SQL_MIGRATION_0001).toBe(fichierSql);
  });

  it("contraint le statut aux trois etats du produit (CHECK)", () => {
    for (const source of [fichierSql, SQL_MIGRATION_0001]) {
      expect(source).toMatch(
        /CHECK\s*\(\s*statut\s+IN\s*\(\s*'approuve'\s*,\s*'refuse'\s*,\s*'prouve'\s*\)\s*\)/i,
      );
    }
    // Aucun quatrième état ne s'est glissé dans la table decisions.
    const etats = [...fichierSql.matchAll(/CHECK \(statut IN \(([^)]*)\)\)/g)];
    expect(etats).toHaveLength(1);
    expect([...etats[0][1].matchAll(/'([^']*)'/g)].map((m) => m[1])).toEqual([
      "approuve",
      "refuse",
      "prouve",
    ]);
  });

  it("porte org_id sur les trois tables et casse les decisions d'une org purgee", () => {
    expect(fichierSql).toMatch(/CREATE TABLE IF NOT EXISTS decisions/);
    expect(fichierSql).toMatch(
      /org_id\s+TEXT\s+NOT NULL REFERENCES organizations\(id\) ON DELETE CASCADE/,
    );
    expect(fichierSql).toMatch(/CREATE TABLE IF NOT EXISTS audit_log/);
  });

  it("n'emet que des instructions idempotentes et non destructrices", () => {
    const instructions = decouperSql(SQL_MIGRATION_0001);
    expect(instructions).toHaveLength(6); // 3 tables + 3 index
    for (const instruction of instructions) {
      // On raisonne sur le SQL réel, commentaires retirés : la prose française
      // du fichier contient des « ; » et le mot « DROP » (à titre d'explication).
      expect(normaliser(instruction)).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS /i);
      // Rien de destructeur ni de semé. (« ON DELETE CASCADE » est une regle
      // référentielle, pas une suppression : d'où le motif ciblé.)
      expect(normaliser(instruction)).not.toMatch(
        /\b(DROP\s+(TABLE|INDEX)|DELETE\s+FROM|ALTER\s+TABLE|INSERT\s+INTO)\b/i,
      );
    }
  });

  it("cree les trois tables et les trois index, et se rejoue sans effet", async () => {
    const db = new FauxD1();
    await applyMigrations(db);
    await applyMigrations(db); // idempotence

    expect([...db.tables.keys()].sort()).toEqual(["audit_log", "decisions", "organizations"]);
    expect(db.index.sort()).toEqual([
      "idx_audit_log_org_at",
      "idx_decisions_org_statut",
      "idx_decisions_verify_due",
    ]);
    for (const table of db.tables.keys()) {
      expect(db.lignes(table)).toHaveLength(0);
    }
  });
});

describe("isolation des locataires — clause WHERE", () => {
  let db: FauxD1;

  beforeEach(async () => {
    db = await baseAmorcee();
    db.appels.length = 0; // on n'observe que les appels du test lui-meme
  });

  it("listDecisions borne la lecture a org_id, en premiere condition", async () => {
    await listDecisions(db, ORG_A);
    const appel = db.appelsMetier().at(-1)!;
    expect(appel.normalise).toContain("WHERE org_id = ?");
    expect(appel.bindings[0]).toBe(ORG_A);
  });

  it("listDecisions garde org_id meme avec un filtre statut + echeance + limite", async () => {
    await listDecisions(db, ORG_A, {
      statut: ["approuve", "refuse"],
      verifyDueAvant: T0 + 40 * JOUR,
      limite: 10,
    });
    const appel = db.appelsMetier().at(-1)!;
    expect(appel.normalise).toContain("WHERE org_id = ? AND statut IN (?, ?)");
    expect(appel.normalise).toContain("verify_due_at <= ?");
    expect(appel.normalise).toContain("LIMIT ?");
    expect(appel.bindings).toEqual([ORG_A, "approuve", "refuse", T0 + 40 * JOUR, 10]);
  });

  it("listAudit borne la lecture a org_id", async () => {
    await listAudit(db, ORG_A, T0);
    const appel = db.appelsMetier().at(-1)!;
    expect(appel.normalise).toContain("WHERE org_id = ? AND at >= ?");
    expect(appel.bindings[0]).toBe(ORG_A);
  });

  it("getOrganizationByQontoId est borne a l'identifiant Qonto unique", async () => {
    await getOrganizationByQontoId(db, "qonto_a");
    const appel = db.appelsMetier().at(-1)!;
    expect(appel.normalise).toContain("WHERE qonto_org_id = ?");
    expect(appel.bindings).toEqual(["qonto_a"]);
  });

  it("promoteToProven borne l'ecriture a org_id ET a l'identifiant de decision", async () => {
    await promoteToProven(db, ORG_A, "dec_a1", T0 + 31 * JOUR);
    const appel = db.appelsMetier().at(-1)!;
    expect(appel.normalise).toContain("WHERE org_id = ? AND id = ?");
    expect(appel.bindings).toContain(ORG_A);
  });

  it("les ecritures portent toujours org_id dans les colonnes inserees", async () => {
    await insertDecision(db, ORG_A, {
      merchant: "Linear",
      lever: "renegociation",
      montantMensuelEur: 12,
      economieAnnuelleEur: 144,
      statut: "approuve",
      decidedAt: T0,
    });
    await appendAudit(db, ORG_A, {
      actor: "agent",
      action: "qonto.list_transactions",
      httpMethod: "GET",
      path: "/v2/transactions",
      outcome: "ok",
      at: T0,
    });
    for (const appel of db.appelsMetier()) {
      expect(appel.normalise).toMatch(/INSERT INTO (decisions|audit_log) \(id, org_id,/);
      expect(appel.bindings[1]).toBe(ORG_A);
    }
  });

  it("refuse un orgId vide plutot que d'emettre une requete sans locataire", async () => {
    await expect(listDecisions(db, "")).rejects.toThrow(/orgId manquant/);
    await expect(listAudit(db, "   ", T0)).rejects.toThrow(/orgId manquant/);
    await expect(promoteToProven(db, "", "dec_a1", T0)).rejects.toThrow(/orgId manquant/);
    expect(db.appels).toHaveLength(0);
  });
});

describe("isolation des locataires — aucune valeur concatenee dans le SQL", () => {
  it("n'ecrit jamais une valeur dans la chaine SQL : tout passe par bind()", async () => {
    const db = new FauxD1();
    await applyMigrations(db);

    // Valeurs délibérément hostiles : si l'une d'elles apparaissait dans le
    // SQL, elle y serait visible telle quelle.
    const orgPiege = "org_x' OR '1'='1";
    const marchandPiege = "Acme'); DROP TABLE decisions;--";

    await upsertOrganization(db, orgPiege, {
      qontoOrgId: "qonto_piege",
      legalName: marchandPiege,
      createdAt: T0,
    });
    await getOrganizationByQontoId(db, "qonto_piege");
    await insertDecision(db, orgPiege, {
      id: "dec_piege",
      merchant: marchandPiege,
      lever: "resiliation",
      montantMensuelEur: 99.5,
      economieAnnuelleEur: 1194,
      statut: "approuve",
      sourceUrl: "https://exemple.test/tarifs",
      sourceDate: "2026-08-01",
      decidedAt: T0,
      verifyDueAt: T0 + 30 * JOUR,
    });
    await listDecisions(db, orgPiege, { statut: "approuve", limite: 5 });
    await promoteToProven(db, orgPiege, "dec_piege", T0 + 31 * JOUR);
    await appendAudit(db, orgPiege, {
      id: "aud_piege",
      actor: "agent",
      action: "qonto.list_transactions",
      httpMethod: "GET",
      path: "/v2/transactions",
      outcome: "ok",
      at: T0,
    });
    await listAudit(db, orgPiege, T0, 50);

    const appels = db.appelsMetier();
    expect(appels.length).toBeGreaterThanOrEqual(7);

    for (const appel of appels) {
      // 1. Autant de `?` que de bindings : aucune valeur n'a été « inlinée ».
      expect((appel.sql.match(/\?/g) ?? []).length).toBe(appel.bindings.length);

      // 2. Aucune valeur bindée n'apparaît littéralement dans le SQL.
      for (const binding of appel.bindings) {
        if (typeof binding === "string" && binding.length > 0) {
          expect(appel.sql).not.toContain(binding);
        }
        if (typeof binding === "number") {
          expect(appel.sql).not.toContain(String(binding));
        }
      }

      // 3. Aucun littéral chaîne tout court dans le SQL métier : même les
      //    statuts de la machine à états sont bindés.
      expect(appel.sql).not.toMatch(/'[^']*'/);
    }

    // La table est toujours là : l'injection n'a rien exécuté.
    expect(db.lignes("decisions")).toHaveLength(1);
    expect(db.lignes("decisions")[0].merchant).toBe(marchandPiege);
  });
});

describe("isolation des locataires — resultats", () => {
  let db: FauxD1;

  beforeEach(async () => {
    db = await baseAmorcee();
  });

  it("ne laisse pas une organisation lire les decisions d'une autre", async () => {
    const vueA = await listDecisions(db, ORG_A);
    const vueB = await listDecisions(db, ORG_B);

    expect(vueA.map((d) => d.id).sort()).toEqual(["dec_a1", "dec_a2"]);
    expect(vueB.map((d) => d.id)).toEqual(["dec_b1"]);
    expect(vueA.every((d) => d.orgId === ORG_A)).toBe(true);
  });

  it("renvoie une liste vide pour un orgId inconnu ou force", async () => {
    expect(await listDecisions(db, "org_inexistant")).toEqual([]);
    expect(await listDecisions(db, "org_argentier_a ")).toEqual([]); // pas de correspondance floue
    expect(await listDecisions(db, "' OR 1=1 --")).toEqual([]);
    expect(await listAudit(db, "org_inexistant", 0)).toEqual([]);
  });

  it("ne laisse pas une organisation lire le journal d'audit d'une autre", async () => {
    await appendAudit(db, ORG_A, {
      id: "aud_a",
      actor: "agent",
      action: "qonto.list_transactions",
      httpMethod: "GET",
      path: "/v2/transactions",
      outcome: "ok",
      at: T0 + 5,
    });
    await appendAudit(db, ORG_B, {
      id: "aud_b",
      actor: "agent",
      action: "qonto.list_transactions",
      httpMethod: "GET",
      path: "/v2/transactions",
      outcome: "denied",
      at: T0 + 6,
    });

    const journalA = await listAudit(db, ORG_A, T0);
    expect(journalA.map((e) => e.id)).toEqual(["aud_a"]);
    expect(await listAudit(db, ORG_A, T0 + 100)).toEqual([]); // borne temporelle
  });

  it("relit les montants tels qu'ils ont ete ecrits (aucun recalcul)", async () => {
    const [recente, ancienne] = await listDecisions(db, ORG_A);
    expect(recente.id).toBe("dec_a2"); // ORDER BY decided_at DESC
    expect(ancienne.montantMensuelEur).toBe(48);
    expect(ancienne.economieAnnuelleEur).toBe(576);
    expect(ancienne.sourceUrl).toBe("https://www.notion.com/pricing");
    expect(ancienne.sourceDate).toBe("2026-07-02");
  });
});

describe("promoteToProven — machine a etats et frontiere d'organisation", () => {
  let db: FauxD1;

  beforeEach(async () => {
    db = await baseAmorcee();
  });

  it("refuse de promouvoir la decision d'une autre organisation", async () => {
    const promu = await promoteToProven(db, ORG_B, "dec_a1", T0 + 31 * JOUR);

    expect(promu).toBe(false);
    const [decision] = (await listDecisions(db, ORG_A, { statut: "approuve" })).filter(
      (d) => d.id === "dec_a1",
    );
    expect(decision.statut).toBe("approuve");
    expect(decision.provenAt).toBeNull();
    // Et rien n'a bougé non plus chez B.
    expect((await listDecisions(db, ORG_B))[0].statut).toBe("approuve");
  });

  it("promeut la decision de sa propre organisation, une seule fois", async () => {
    expect(await promoteToProven(db, ORG_A, "dec_a1", T0 + 31 * JOUR)).toBe(true);

    const prouvees = await listDecisions(db, ORG_A, { statut: "prouve" });
    expect(prouvees.map((d) => d.id)).toEqual(["dec_a1"]);
    expect(prouvees[0].provenAt).toBe(T0 + 31 * JOUR);
    // Les euros n'ont pas bougé : promouvoir ne recalcule rien.
    expect(prouvees[0].economieAnnuelleEur).toBe(576);

    // 'prouve' est terminal : pas de seconde promotion, donc pas de proven_at mouvant.
    expect(await promoteToProven(db, ORG_A, "dec_a1", T0 + 60 * JOUR)).toBe(false);
    expect((await listDecisions(db, ORG_A, { statut: "prouve" }))[0].provenAt).toBe(
      T0 + 31 * JOUR,
    );
  });

  it("renvoie false pour une decision inexistante", async () => {
    expect(await promoteToProven(db, ORG_A, "dec_fantome", T0)).toBe(false);
  });
});

describe("organizations", () => {
  it("conserve l'id interne existant quand la meme org Qonto se reconnecte", async () => {
    const db = new FauxD1();
    await applyMigrations(db);

    const premiere = await upsertOrganization(db, ORG_A, {
      qontoOrgId: "qonto_a",
      legalName: "Argentier SAS",
      createdAt: T0,
      connectedAt: T0,
    });
    expect(premiere.id).toBe(ORG_A);

    // Reconnexion : l'appelant propose un nouvel id interne, la base garde
    // l'ancien — sinon les décisions déjà liées deviendraient orphelines.
    const seconde = await upsertOrganization(db, "org_nouvel_id", {
      qontoOrgId: "qonto_a",
      legalName: "Argentier SAS (renomme)",
      createdAt: T0 + JOUR,
      connectedAt: T0 + JOUR,
    });
    expect(seconde.id).toBe(ORG_A);
    expect(seconde.legalName).toBe("Argentier SAS (renomme)");
    expect(seconde.connectedAt).toBe(T0 + JOUR);
    expect(seconde.createdAt).toBe(T0); // jamais ecrase
    expect(db.lignes("organizations")).toHaveLength(1);

    const relue = await getOrganizationByQontoId(db, "qonto_a");
    expect(relue?.id).toBe(ORG_A);
    expect(await getOrganizationByQontoId(db, "qonto_inconnu")).toBeNull();
  });
});

describe("garde-fous du schema", () => {
  it("rejette un statut hors machine a etats (CHECK applique par la base)", async () => {
    const db = await baseAmorcee();
    await expect(
      insertDecision(db, ORG_A, {
        merchant: "Zoom",
        lever: "inconnu",
        montantMensuelEur: 15,
        economieAnnuelleEur: 180,
        // Statut volontairement hors contrat : le CHECK doit le refuser.
        statut: "en_cours" as never,
        decidedAt: T0,
      }),
    ).rejects.toThrow(/CHECK viole sur decisions\.statut/);
  });

  it("n'expose aucune mise a jour ni suppression du journal d'audit", async () => {
    const db = await baseAmorcee();
    const depot = depotTenant(db);
    const surface = Object.keys(depot).join(" ");
    expect(surface).not.toMatch(/update.*audit|delete|remove|purge/i);

    await depot.appendAudit(ORG_A, {
      id: "aud_immuable",
      actor: "agent",
      action: "oauth.revoke",
      outcome: "ok",
      at: T0,
    });
    // Hors DDL de migration, tout ce qui touche audit_log est un INSERT ou un
    // SELECT : jamais un UPDATE, jamais un DELETE. Immuabilité APPLICATIVE
    // seulement : la base, elle, n'a aucun trigger qui l'interdise (cf. le
    // commentaire d'appendAudit dans tenant.ts).
    const emis = db
      .appelsMetier()
      .map((appel) => appel.normalise)
      .filter((sql) => /audit_log/i.test(sql));
    expect(emis.length).toBeGreaterThan(0);
    expect(emis.every((sql) => /^(INSERT|SELECT)/i.test(sql))).toBe(true);
  });
});

describe("depotTenant — orgId en premier argument", () => {
  it("expose la même surface, avec le binding D1 déjà lié", async () => {
    const db = await baseAmorcee();
    const depot = depotTenant(db);

    expect((await depot.listDecisions(ORG_A)).map((d) => d.id).sort()).toEqual([
      "dec_a1",
      "dec_a2",
    ]);
    expect(await depot.promoteToProven(ORG_B, "dec_a1", T0)).toBe(false);
    expect((await depot.getOrganizationByQontoId("qonto_b"))?.id).toBe(ORG_B);
  });
});

// --- Réparation du schéma ---------------------------------------------------
//
// Trois faux D1 minuscules, locaux à ce bloc : ils ne comprennent rien au SQL,
// ils distinguent seulement « DDL de migration » de « écriture métier ».
//
// `applyMigrations` n'était appelée par AUCUN code applicatif : la migration
// était une étape MANUELLE documentée dans wrangler.jsonc, alors que le binding
// portait déjà un database_id réel. L'oublier ne produisait aucun avertissement,
// seulement des connexions OAuth qui échouaient toutes avec « qonto=erreur »
// pour tout diagnostic. `avecSchema` referme cet écart.

/** Résultat D1 vide, générique — les faux ci-dessous ne rendent aucune ligne. */
function resultatVide<T = Record<string, unknown>>(): D1Result<T> {
  return { results: [], success: true };
}

describe("estTableManquante", () => {
  it("reconnaît le message que D1 remonte sur une table absente", () => {
    expect(estTableManquante(new Error("D1_ERROR: no such table: organizations"))).toBe(true);
    expect(estTableManquante("no such table: audit_log")).toBe(true);
  });

  it("ne confond pas une table absente avec une dérive de modèle ou une panne", () => {
    // Une colonne manquante est une dérive de schéma : elle doit REMONTER, pas
    // être « réparée » par une migration idempotente qui n'y changera rien.
    expect(estTableManquante(new Error("D1_ERROR: no such column: session_epoch"))).toBe(false);
    expect(estTableManquante(new Error("D1_ERROR: database is locked"))).toBe(false);
    expect(estTableManquante(null)).toBe(false);
  });
});

describe("avecSchema", () => {
  /** Base qui refuse ses écritures jusqu'à ce que la migration soit passée. */
  function baseSansSchema() {
    const etat = { migre: false, tentatives: 0, ddl: 0 };
    const db: D1Database = {
      prepare(requete: string) {
        const estDdl = /CREATE (TABLE|INDEX)/i.test(requete);
        const statement: D1PreparedStatement = {
          bind: () => statement,
          first: async () => null,
          all: async <T = Record<string, unknown>>() => resultatVide<T>(),
          run: async <T = Record<string, unknown>>() => {
            if (estDdl) {
              etat.ddl += 1;
              etat.migre = true;
              return resultatVide<T>();
            }
            etat.tentatives += 1;
            if (!etat.migre) throw new Error("D1_ERROR: no such table: organizations");
            return resultatVide<T>();
          },
        };
        return statement;
      },
    };
    return { db, etat };
  }

  it("applique la migration puis rejoue l'opération une seule fois", async () => {
    const { db, etat } = baseSansSchema();

    const resultat = await avecSchema(db, async () => {
      await db.prepare("INSERT INTO organizations (id) VALUES (?)").bind("org_a").run();
      return "ecrit";
    });

    expect(resultat).toBe("ecrit");
    expect(etat.tentatives).toBe(2);
    expect(etat.ddl).toBeGreaterThan(0);
  });

  it("ne touche à rien quand l'opération réussit du premier coup", async () => {
    const { db, etat } = baseSansSchema();
    etat.migre = true;

    await avecSchema(db, () =>
      db.prepare("INSERT INTO organizations (id) VALUES (?)").bind("org_a").run(),
    );

    expect(etat.tentatives).toBe(1);
    expect(etat.ddl).toBe(0);
  });

  it("laisse remonter toute erreur qui n'est pas un schéma absent", async () => {
    const db: D1Database = {
      prepare() {
        const statement: D1PreparedStatement = {
          bind: () => statement,
          first: async () => null,
          all: async <T = Record<string, unknown>>() => resultatVide<T>(),
          run: async () => {
            throw new Error("D1_ERROR: database is locked");
          },
        };
        return statement;
      },
    };

    await expect(avecSchema(db, () => db.prepare("INSERT INTO x").run())).rejects.toThrow(
      /locked/,
    );
  });

  it("ne rejoue pas la migration indéfiniment si la table manque toujours", async () => {
    // Sinon une base cassée ferait tourner la migration à chaque requête.
    let ddl = 0;
    const db: D1Database = {
      prepare(requete: string) {
        const estDdl = /CREATE (TABLE|INDEX)/i.test(requete);
        const statement: D1PreparedStatement = {
          bind: () => statement,
          first: async () => null,
          all: async <T = Record<string, unknown>>() => resultatVide<T>(),
          run: async <T = Record<string, unknown>>() => {
            if (estDdl) {
              ddl += 1;
              return resultatVide<T>();
            }
            throw new Error("D1_ERROR: no such table: organizations");
          },
        };
        return statement;
      },
    };

    await expect(avecSchema(db, () => db.prepare("INSERT INTO organizations").run())).rejects.toThrow(
      /no such table/,
    );
    const ddlApresPremiere = ddl;
    await expect(avecSchema(db, () => db.prepare("INSERT INTO organizations").run())).rejects.toThrow(
      /no such table/,
    );
    // La seconde tentative n'a PAS relancé la migration sur cette même base.
    expect(ddl).toBe(ddlApresPremiere);
  });
});
