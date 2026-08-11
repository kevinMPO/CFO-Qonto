// ---------------------------------------------------------------------------
// tenant.ts — couche d'accès typée au socle multi-locataire (Cloudflare D1).
//
// RAISON D'ÊTRE : le prototype était mono-locataire (un data/decisions.json
// plat, sans identifiant de client). Ici, chaque ligne appartient à une
// organisation et TOUTE fonction de lecture ou d'écriture prend `orgId` comme
// premier paramètre métier obligatoire, puis l'injecte dans sa clause WHERE.
//
// C'est une FRONTIÈRE DE SÉCURITÉ, pas une convention de confort :
//   - aucune requête de ce module ne peut traverser deux organisations ;
//   - aucune valeur n'est jamais concaténée dans une chaîne SQL : tout passe
//     par des requêtes préparées et bind() ;
//   - aucune fonction n'expose UPDATE ni DELETE sur audit_log (journal immuable).
// Les tests de lib/db/__tests__/tenant.test.ts échouent bruyamment si l'une de
// ces trois propriétés est cassée.
//
// CE QUI EST BRANCHÉ, ET CE QUI NE L'EST PAS ENCORE. À lire avant de faire
// confiance à ce fichier :
//   - branchées sur du code de production : `upsertOrganization`, `appendAudit`,
//     `getOrganizationById` (lu à chaque session, cf. lib/auth/session.ts),
//     `revokeOrganization`, `avecSchema` / `applyMigrations` / `decouperSql`
//     (le callback OAuth applique la migration si le schéma manque) ;
//   - PAS ENCORE ATTEINTES : tout le ledger des décisions — `insertDecision`,
//     `listDecisions`, `promoteToProven`, `listAudit`, `getOrganizationByQontoId`
//     et la façade `depotTenant`. Aucune route ne les appelle : la surface
//     produit correspondante (gate humain, preuve J+30) vit encore côté CLI, pas
//     côté web. Leurs tests sont sincères mais ne protègent aucun chemin réel —
//     ne pas les compter comme une couverture du produit servi.
//
// RÈGLE 2 DU PROJET : ce module ne CALCULE aucun euro. Il persiste des montants
// déjà produits par lib/engine.ts et les relit tels quels. Aucune addition,
// aucune multiplication, aucune annualisation ici.
//
// Convention de temps : entiers = epoch en millisecondes UTC (Date.now()).
// Seule `sourceDate` est une chaîne ISO AAAA-MM-JJ (date de publication d'une
// source, règle 4).
// ---------------------------------------------------------------------------

// --- Types D1 minimaux ------------------------------------------------------
// @cloudflare/workers-types n'est pas installé dans ce paquet (et on n'ajoute
// pas de dépendance). On déclare donc le sous-ensemble STRUCTUREL du binding
// D1 qu'on utilise : un vrai `D1Database` de Workers y est assignable tel quel,
// et un faux D1 de test aussi. Le jour où les types officiels arrivent, ce bloc
// se supprime sans toucher au reste du fichier.

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta?: { changes?: number; [cle: string]: unknown };
}

export interface D1PreparedStatement {
  bind(...valeurs: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1Database {
  prepare(requete: string): D1PreparedStatement;
}

// --- Modèle --------------------------------------------------------------

/**
 * Machine à états RÉELLE du produit : 'approuve' | 'refuse' -> 'prouve'.
 * 'approuve' et 'refuse' sont les états d'entrée (le gate humain) ; 'prouve'
 * est l'état terminal, atteint uniquement quand la preuve J+30 est constatée.
 */
export type StatutDecision = "approuve" | "refuse" | "prouve";

/** États depuis lesquels une décision peut encore être promue en 'prouve'. */
export const STATUTS_PROMOUVABLES: readonly StatutDecision[] = ["approuve", "refuse"];

/** Une organisation Qonto connectée = un locataire. */
export interface Organization {
  /** Identifiant interne Argentier (clé de locataire). */
  id: string;
  /** Identifiant de l'organisation côté Qonto (unique). */
  qontoOrgId: string;
  legalName: string | null;
  createdAt: number;
  /**
   * Dernier consentement OAuth accordé (null si jamais connecté). C'est aussi la
   * GÉNÉRATION de session : lib/auth/session.ts refuse tout cookie émis avant.
   */
  connectedAt: number | null;
  /**
   * Révocation de l'accès (null tant que l'accès est actif). Relu à chaque
   * lecture de session : une organisation révoquée n'a plus de session valide.
   */
  revokedAt: number | null;
}

/** Champs acceptés par upsertOrganization (l'id est passé à part, en 2e arg). */
export interface SaisieOrganization {
  qontoOrgId: string;
  legalName?: string | null;
  createdAt: number;
  connectedAt?: number | null;
  revokedAt?: number | null;
}

/** Une décision du ledger, rattachée à une organisation. */
export interface Decision {
  id: string;
  orgId: string;
  merchant: string;
  lever: string;
  /** Euros/mois — calculé par lib/engine.ts, jamais ici. */
  montantMensuelEur: number;
  /** Euros/an — calculé par lib/engine.ts, jamais ici. */
  economieAnnuelleEur: number;
  statut: StatutDecision;
  /** Règle 4 : source du prix... */
  sourceUrl: string | null;
  /** ...et sa date (ISO AAAA-MM-JJ). */
  sourceDate: string | null;
  decidedAt: number;
  /** Échéance de la preuve J+30 (null si rien à prouver). */
  verifyDueAt: number | null;
  provenAt: number | null;
}

/** Champs acceptés par insertDecision (orgId est passé à part, en 2e arg). */
export interface SaisieDecision {
  /** Optionnel : généré via WebCrypto si absent. */
  id?: string;
  merchant: string;
  lever: string;
  montantMensuelEur: number;
  economieAnnuelleEur: number;
  statut: StatutDecision;
  sourceUrl?: string | null;
  sourceDate?: string | null;
  decidedAt: number;
  verifyDueAt?: number | null;
  provenAt?: number | null;
}

/** Filtre de listDecisions. Tous les critères sont optionnels et cumulatifs. */
export interface FiltreDecisions {
  /** Un statut, ou plusieurs (traduit en IN (?, ?) — valeurs toujours bindées). */
  statut?: StatutDecision | StatutDecision[];
  /** Ne garder que les preuves J+30 échues à cette date (epoch ms) ou avant. */
  verifyDueAvant?: number;
  /** Plafond de lignes (borne bindée, jamais concaténée). */
  limite?: number;
}

/** Une entrée du journal d'audit (immuable une fois écrite). */
export interface AuditEntry {
  id: string;
  orgId: string;
  /** Qui agit : 'agent', 'user:<membership>', 'cron'... */
  actor: string;
  /** Action métier : 'qonto.list_transactions', 'oauth.revoke'... */
  action: string;
  httpMethod: string | null;
  /** Chemin appelé, sans query string ni PII (règle 3). */
  path: string | null;
  /** Issue : 'ok', 'denied' (bloqué par l'allowlist read-only), 'error'. */
  outcome: string;
  at: number;
}

/** Champs acceptés par appendAudit (orgId est passé à part, en 2e arg). */
export interface SaisieAudit {
  id?: string;
  actor: string;
  action: string;
  httpMethod?: string | null;
  path?: string | null;
  outcome: string;
  at: number;
}

// --- Migration --------------------------------------------------------------

/**
 * Contenu EXACT de db/0001_init.sql, embarqué ici parce qu'un Worker n'a pas de
 * système de fichiers à l'exécution. Un test compare cette constante au fichier
 * pour interdire toute dérive entre les deux.
 *
 * Le corps de la constante reste SANS ACCENTS, à l'inverse du reste du fichier :
 * c'est la copie littérale d'un artefact déjà appliqué en distant, et un test
 * l'exige octet pour octet. On ne réécrit pas un artefact déployé pour du
 * confort de lecture.
 */
export const SQL_MIGRATION_0001 = `-- ---------------------------------------------------------------------------
-- Migration 0001 — socle multi-locataire (multi-tenant) d'Argentier.
-- Cible : Cloudflare D1 (SQLite).
--
-- Pourquoi : le prototype est mono-locataire (un seul data/decisions.json plat,
-- sans le moindre identifiant de client). Ici, TOUTE ligne metier porte un
-- org_id. C'est la frontiere d'isolation entre locataires ; elle est appliquee
-- dans chaque clause WHERE par lib/db/tenant.ts, qui n'expose aucune requete
-- capable de traverser deux organisations.
--
-- Idempotence : rejouable sans effet de bord (CREATE ... IF NOT EXISTS
-- uniquement, aucun DROP, aucune donnee semee).
--
-- Regle 2 du projet : la base ne CALCULE aucun euro. Les montants arrivent deja
-- calcules par lib/engine.ts ; SQLite ne fait que les conserver. Aucune vue,
-- aucun trigger, aucune colonne generee ne derive un montant ici.
--
-- Convention de temps : tous les horodatages sont des entiers = epoch en
-- MILLISECONDES UTC (Date.now()). Seule source_date est une chaine ISO
-- AAAA-MM-JJ, car c'est la date de publication affichee d'une source (regle 4).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Table 1/3 — organizations : une ligne par organisation Qonto connectee.
--
--   id           identifiant interne Argentier (opaque, genere par l'app).
--                C'est LA cle de locataire referencee partout ailleurs.
--   qonto_org_id identifiant de l'organisation cote Qonto. UNIQUE : une meme
--                organisation Qonto ne peut pas exister en double.
--   legal_name   raison sociale, pour l'affichage seulement (peut manquer).
--   created_at   creation de la ligne.
--   connected_at dernier consentement OAuth accorde (NULL si jamais connecte).
--   revoked_at   revocation de l'acces (NULL tant que l'acces est actif). On ne
--                supprime pas la ligne a la revocation : on l'horodate, sinon
--                on perdrait la tracabilite exigee par les DAF.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organizations (
  id           TEXT    PRIMARY KEY,
  qonto_org_id TEXT    NOT NULL UNIQUE,
  legal_name   TEXT,
  created_at   INTEGER NOT NULL,
  connected_at INTEGER,
  revoked_at   INTEGER
);

-- ---------------------------------------------------------------------------
-- Table 2/3 — decisions : le ledger (ex-data/decisions.json), desormais par
-- organisation. Une ligne = une decision humaine sur un levier propose.
--
--   org_id                locataire proprietaire. ON DELETE CASCADE : purger
--                         une organisation purge ses decisions (RGPD).
--   merchant              marchand normalise (clean_counterparty_name).
--   lever                 levier retenu (resiliation, doublon, FX, renego...).
--   montant_mensuel_eur   depense mensuelle observee, en euros. CALCULEE PAR
--                         lib/engine.ts — recopiee telle quelle ici.
--   economie_annuelle_eur economie annualisee, en euros. CALCULEE PAR
--                         lib/engine.ts (mensuel x 12) — recopiee telle quelle.
--   statut                machine a etats REELLE du produit :
--                             'approuve' | 'refuse'  ->  'prouve'
--                         'approuve' et 'refuse' sont les etats d'entree (la
--                         decision humaine du gate) ; 'prouve' est l'etat
--                         terminal, atteint seulement quand la preuve J+30 est
--                         constatee sur les flux. Le CHECK interdit tout autre
--                         mot : un statut invente par un appelant est rejete
--                         par la base, pas seulement par le code.
--   source_url            regle 4 : tout prix affiche porte sa source...
--   source_date           ...et sa date (chaine ISO AAAA-MM-JJ). NULL = prix
--                         non verifie, donc jamais presente comme un prix.
--   decided_at            horodatage du gate humain.
--   verify_due_at         echeance de la preuve J+30 (NULL si rien a prouver).
--   proven_at             horodatage du passage a 'prouve' (NULL sinon).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decisions (
  id                    TEXT    PRIMARY KEY,
  org_id                TEXT    NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  merchant              TEXT    NOT NULL,
  lever                 TEXT    NOT NULL,
  montant_mensuel_eur   REAL    NOT NULL,
  economie_annuelle_eur REAL    NOT NULL,
  statut                TEXT    NOT NULL CHECK (statut IN ('approuve', 'refuse', 'prouve')),
  source_url            TEXT,
  source_date           TEXT,
  decided_at            INTEGER NOT NULL,
  verify_due_at         INTEGER,
  proven_at             INTEGER
);

-- ---------------------------------------------------------------------------
-- Table 3/3 — audit_log : journal IMMUABLE de chaque appel Qonto (et de chaque
-- evenement sensible : consentement, revocation, refus de l'allowlist
-- read-only). C'est la piece que reclame un DAF : qui a lu quoi, quand, avec
-- quelle issue. On n'y fait qu'INSERT + SELECT ; lib/db/tenant.ts n'expose ni
-- UPDATE ni DELETE sur cette table.
--
--   org_id      locataire concerne. Volontairement SANS clef etrangere : le
--               journal doit survivre a la purge d'une organisation, sinon la
--               cascade effacerait justement la trace de ce qui a ete lu.
--   actor       qui agit : 'agent', 'user:<membership>', 'cron'...
--   action      action metier ('qonto.list_transactions', 'oauth.revoke'...).
--   http_method methode HTTP de l'appel sortant (NULL si non pertinent).
--   path        chemin appele, SANS query string ni identifiant personnel
--               (regle 3 : zero PII).
--   outcome     issue : 'ok', 'denied' (bloque par l'allowlist), 'error'.
--   at          horodatage de l'appel.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT    PRIMARY KEY,
  org_id      TEXT    NOT NULL,
  actor       TEXT    NOT NULL,
  action      TEXT    NOT NULL,
  http_method TEXT,
  path        TEXT,
  outcome     TEXT    NOT NULL,
  at          INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Index. Ils suivent exactement les trois lectures du produit :
--   1. le tableau de bord d'une organisation, filtre par statut ;
--   2. le balayage /verify : quelles preuves J+30 sont echues (toutes orgs
--      confondues, c'est un job de fond, d'ou l'absence d'org_id en tete) ;
--   3. le journal d'audit d'une organisation, du plus recent au plus ancien.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_decisions_org_statut ON decisions (org_id, statut);
CREATE INDEX IF NOT EXISTS idx_decisions_verify_due ON decisions (verify_due_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_org_at ON audit_log (org_id, at);
`;

/** Toutes les migrations, dans l'ordre d'application. */
export const MIGRATIONS: readonly string[] = [SQL_MIGRATION_0001];

/**
 * Découpe un script SQL en instructions individuelles exécutables.
 * D1 n'accepte qu'UNE instruction par requête préparée.
 *
 * Le découpage ne peut pas être un simple `split(";")` : nos migrations sont
 * abondamment commentées en français, et le point-virgule français (« a ; b »)
 * couperait une instruction en plein milieu. On balaie donc le script en
 * ignorant les `;` situés dans un commentaire `--` ou dans un littéral `'...'`.
 *
 * Les commentaires sont conservés dans l'instruction rendue (SQLite les
 * tolère, et ils rendent les erreurs lisibles), mais un fragment qui ne
 * contient QUE des commentaires est écarté : ce n'est pas une instruction.
 *
 * Limite assumée : les quotes doublées (`'l''an'`) ne sont pas traitées à part.
 * Nos migrations sont écrites à la main dans ce dépôt et n'en contiennent pas.
 */
export function decouperSql(script: string): string[] {
  const instructions: string[] = [];
  let courante = "";
  let dansCommentaire = false;
  let dansLitteral = false;

  for (let i = 0; i < script.length; i += 1) {
    const caractere = script[i];

    if (dansCommentaire) {
      courante += caractere;
      if (caractere === "\n") dansCommentaire = false;
      continue;
    }
    if (dansLitteral) {
      courante += caractere;
      if (caractere === "'") dansLitteral = false;
      continue;
    }
    if (caractere === "-" && script[i + 1] === "-") {
      dansCommentaire = true;
      courante += caractere;
      continue;
    }
    if (caractere === "'") {
      dansLitteral = true;
      courante += caractere;
      continue;
    }
    if (caractere === ";") {
      instructions.push(courante);
      courante = "";
      continue;
    }
    courante += caractere;
  }
  instructions.push(courante);

  return instructions
    .map((fragment) => fragment.trim())
    .filter((fragment) => {
      const sansCommentaires = fragment
        .split("\n")
        .map((ligne) => ligne.replace(/^\s*--.*$/, "").trim())
        .join("")
        .trim();
      return sansCommentaires.length > 0;
    });
}

/**
 * Applique le schéma. Idempotent : la migration n'utilise que des
 * `CREATE ... IF NOT EXISTS`, donc la rejouer sur une base déjà à jour ne fait
 * rien. Opération de schéma : pas de locataire, donc pas d'orgId ici.
 */
export async function applyMigrations(db: D1Database): Promise<void> {
  for (const migration of MIGRATIONS) {
    for (const instruction of decouperSql(migration)) {
      await db.prepare(instruction).run();
    }
  }
}

/**
 * L'erreur dit-elle « cette table n'existe pas » ?
 *
 * SQLite (donc D1) ne donne pas de code d'erreur exploitable : il faut lire le
 * message, que D1 préfixe de `D1_ERROR:`. On reste volontairement étroit — un
 * `no such column` n'est PAS un schéma absent, c'est une dérive de modèle, et
 * elle doit remonter au lieu d'être « réparée » en silence.
 */
export function estTableManquante(erreur: unknown): boolean {
  const message = erreur instanceof Error ? erreur.message : String(erreur);
  return /no such table/i.test(message);
}

/**
 * Bases dont le schéma a déjà été appliqué dans CE isolat. `WeakSet` : la clé
 * est le binding lui-même, il n'y a donc rien à invalider et rien qui fuie.
 */
const schemasAppliques = new WeakSet<D1Database>();

/**
 * Exécute une opération de base en APPLIQUANT LA MIGRATION si le schéma manque,
 * puis en réessayant une fois.
 *
 * Pourquoi ici et pas dans un script de déploiement : `wrangler.jsonc`
 * documentait `wrangler d1 execute --file=./db/0001_init.sql` comme une étape
 * MANUELLE, alors que le binding porte un `database_id` réel. Oublier cette
 * commande ne produisait aucun avertissement — seulement des connexions qui
 * échouaient toutes avec, pour tout diagnostic, `?qonto=erreur`. Une base
 * provisionnée mais vide se répare toute seule et ne coûte qu'un aller-retour,
 * une fois par isolat.
 *
 * Ce n'est PAS un moteur de migration : la migration est idempotente et sans
 * `ALTER`, donc la rejouer est sans effet de bord. Le jour où une migration
 * devra transformer des données, elle passera par un script versionné et cette
 * réparation restera bornée à « la table n'existe pas du tout ».
 */
export async function avecSchema<T>(
  db: D1Database,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (erreur) {
    if (!estTableManquante(erreur) || schemasAppliques.has(db)) throw erreur;
    console.error(
      "[argentier][db] Schéma multi-locataire absent : application de " +
        "db/0001_init.sql, puis nouvelle tentative.",
    );
    await applyMigrations(db);
    schemasAppliques.add(db);
    return operation();
  }
}

// --- Outils internes --------------------------------------------------------

/** Colonnes de `decisions`, dans l'ordre du modèle. */
const COLONNES_DECISION =
  "id, org_id, merchant, lever, montant_mensuel_eur, economie_annuelle_eur, " +
  "statut, source_url, source_date, decided_at, verify_due_at, proven_at";

/** Colonnes de `organizations`, dans l'ordre du modèle. */
const COLONNES_ORGANIZATION =
  "id, qonto_org_id, legal_name, created_at, connected_at, revoked_at";

/** Colonnes de `audit_log`, dans l'ordre du modèle. */
const COLONNES_AUDIT = "id, org_id, actor, action, http_method, path, outcome, at";

/** Identifiant opaque. WebCrypto natif : pas de node:crypto sur Workers. */
function nouvelId(): string {
  return crypto.randomUUID();
}

/** Refuse un orgId vide : sans locataire, aucune requête ne doit partir. */
function exigerOrgId(orgId: string): string {
  if (typeof orgId !== "string" || orgId.trim() === "") {
    throw new Error("orgId manquant : toute requete doit etre portee par une organisation.");
  }
  return orgId;
}

function texteOuNull(valeur: unknown): string | null {
  return typeof valeur === "string" ? valeur : null;
}

function nombreOuNull(valeur: unknown): number | null {
  return typeof valeur === "number" ? valeur : null;
}

function versOrganization(ligne: Record<string, unknown>): Organization {
  return {
    id: String(ligne.id),
    qontoOrgId: String(ligne.qonto_org_id),
    legalName: texteOuNull(ligne.legal_name),
    createdAt: Number(ligne.created_at),
    connectedAt: nombreOuNull(ligne.connected_at),
    revokedAt: nombreOuNull(ligne.revoked_at),
  };
}

function versDecision(ligne: Record<string, unknown>): Decision {
  return {
    id: String(ligne.id),
    orgId: String(ligne.org_id),
    merchant: String(ligne.merchant),
    lever: String(ligne.lever),
    // Recopie brute : aucun arrondi, aucun recalcul (règle 2).
    montantMensuelEur: Number(ligne.montant_mensuel_eur),
    economieAnnuelleEur: Number(ligne.economie_annuelle_eur),
    statut: String(ligne.statut) as StatutDecision,
    sourceUrl: texteOuNull(ligne.source_url),
    sourceDate: texteOuNull(ligne.source_date),
    decidedAt: Number(ligne.decided_at),
    verifyDueAt: nombreOuNull(ligne.verify_due_at),
    provenAt: nombreOuNull(ligne.proven_at),
  };
}

function versAuditEntry(ligne: Record<string, unknown>): AuditEntry {
  return {
    id: String(ligne.id),
    orgId: String(ligne.org_id),
    actor: String(ligne.actor),
    action: String(ligne.action),
    httpMethod: texteOuNull(ligne.http_method),
    path: texteOuNull(ligne.path),
    outcome: String(ligne.outcome),
    at: Number(ligne.at),
  };
}

// --- organizations ----------------------------------------------------------

/**
 * Crée ou met à jour une organisation.
 *
 * Le conflit est résolu sur `qonto_org_id`, pas sur l'id interne : si la même
 * organisation Qonto se reconnecte, on CONSERVE son id interne existant (sinon
 * ses décisions déjà enregistrées seraient orphelines). `orgId` ne sert donc
 * qu'à la toute première insertion. `created_at` n'est jamais écrasé.
 *
 * L'id rendu est la SEULE clé de locataire à retenir : le callback OAuth signe
 * le cookie de session et indexe le token store dessus. Ne pas y substituer
 * l'identifiant dérivé passé en argument, sous peine de faire coexister deux
 * identités pour un même locataire (journal d'audit scindé, révocation qui ne
 * touche aucune ligne).
 *
 * @param orgId id interne à utiliser si l'organisation n'existe pas encore.
 * @returns la ligne canonique après upsert (son `id` peut différer d'`orgId`).
 */
export async function upsertOrganization(
  db: D1Database,
  orgId: string,
  saisie: SaisieOrganization,
): Promise<Organization> {
  exigerOrgId(orgId);
  const resultat = await db
    .prepare(
      `INSERT INTO organizations (${COLONNES_ORGANIZATION}) VALUES (?, ?, ?, ?, ?, ?) ` +
        "ON CONFLICT(qonto_org_id) DO UPDATE SET " +
        "legal_name = excluded.legal_name, " +
        "connected_at = excluded.connected_at, " +
        "revoked_at = excluded.revoked_at " +
        `RETURNING ${COLONNES_ORGANIZATION}`,
    )
    .bind(
      orgId,
      saisie.qontoOrgId,
      saisie.legalName ?? null,
      saisie.createdAt,
      saisie.connectedAt ?? null,
      saisie.revokedAt ?? null,
    )
    .run<Record<string, unknown>>();

  const ligne = resultat.results?.[0];
  if (!ligne) {
    throw new Error("upsertOrganization : la base n'a renvoye aucune ligne.");
  }
  return versOrganization(ligne);
}

/**
 * Retrouve une organisation par son identifiant Qonto — le chemin d'amorçage :
 * à la connexion OAuth on ne connaît pas encore l'id interne. `qonto_org_id`
 * est UNIQUE, donc cette lecture est elle aussi bornée à un seul locataire.
 *
 * Non appelée à ce jour (cf. en-tête) : `upsertOrganization` résout déjà le
 * conflit et rend la ligne canonique en un seul aller-retour.
 */
export async function getOrganizationByQontoId(
  db: D1Database,
  qontoOrgId: string,
): Promise<Organization | null> {
  exigerOrgId(qontoOrgId);
  const ligne = await db
    .prepare(`SELECT ${COLONNES_ORGANIZATION} FROM organizations WHERE qonto_org_id = ?`)
    .bind(qontoOrgId)
    .first<Record<string, unknown>>();
  return ligne ? versOrganization(ligne) : null;
}

/**
 * Retrouve une organisation par son identifiant INTERNE (la clé de locataire).
 * C'est ce que porte le cookie de session : la route ne connaît que cet id.
 * `id` étant la clé primaire, la lecture est bornée à un seul locataire.
 *
 * Chemin chaud : `lireSession` l'appelle à chaque requête authentifiée pour
 * confronter la génération du cookie à `connected_at` et `revoked_at`.
 */
export async function getOrganizationById(
  db: D1Database,
  orgId: string,
): Promise<Organization | null> {
  exigerOrgId(orgId);
  const ligne = await db
    .prepare(`SELECT ${COLONNES_ORGANIZATION} FROM organizations WHERE id = ?`)
    .bind(orgId)
    .first<Record<string, unknown>>();
  return ligne ? versOrganization(ligne) : null;
}

/**
 * Horodate la révocation de l'accès d'une organisation (débranchement Qonto).
 *
 * On n'efface PAS la ligne : la traçabilité réclamée par un DAF exige de savoir
 * qu'un accès a existé puis a été retiré. La suppression effective des secrets,
 * elle, se fait dans le token store (`TokenStore.delete`).
 *
 * Cet horodatage n'est pas décoratif : c'est lui que relit `lireSession` pour
 * refuser les cookies de session émis avant la révocation. Un appelant qui
 * IGNORE la valeur de retour laisse donc passer le cas « aucune ligne touchée »,
 * où la révocation n'a aucun effet sur les sessions déjà émises.
 *
 * Idempotent : rappeler la fonction sur une organisation déjà révoquée ne fait
 * que réécrire l'horodatage ; sur une organisation inconnue, elle ne touche
 * aucune ligne et rend false.
 *
 * @returns true si une ligne a bien été horodatée.
 */
export async function revokeOrganization(
  db: D1Database,
  orgId: string,
  at: number,
): Promise<boolean> {
  exigerOrgId(orgId);
  const resultat = await db
    .prepare("UPDATE organizations SET revoked_at = ? WHERE id = ? RETURNING id")
    .bind(at, orgId)
    .run<{ id: string }>();

  const lignes = resultat.results ?? [];
  return lignes.length > 0 || (resultat.meta?.changes ?? 0) > 0;
}

// --- decisions --------------------------------------------------------------

/**
 * Écrit une décision dans le ledger du locataire `orgId`.
 * Les deux montants sont persistés tels que fournis par lib/engine.ts.
 *
 * Non appelée à ce jour : le ledger n'est pas branché côté web (cf. en-tête).
 */
export async function insertDecision(
  db: D1Database,
  orgId: string,
  saisie: SaisieDecision,
): Promise<Decision> {
  exigerOrgId(orgId);
  const decision: Decision = {
    id: saisie.id ?? nouvelId(),
    orgId,
    merchant: saisie.merchant,
    lever: saisie.lever,
    montantMensuelEur: saisie.montantMensuelEur,
    economieAnnuelleEur: saisie.economieAnnuelleEur,
    statut: saisie.statut,
    sourceUrl: saisie.sourceUrl ?? null,
    sourceDate: saisie.sourceDate ?? null,
    decidedAt: saisie.decidedAt,
    verifyDueAt: saisie.verifyDueAt ?? null,
    provenAt: saisie.provenAt ?? null,
  };

  await db
    .prepare(
      `INSERT INTO decisions (${COLONNES_DECISION}) ` +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      decision.id,
      decision.orgId,
      decision.merchant,
      decision.lever,
      decision.montantMensuelEur,
      decision.economieAnnuelleEur,
      decision.statut,
      decision.sourceUrl,
      decision.sourceDate,
      decision.decidedAt,
      decision.verifyDueAt,
      decision.provenAt,
    )
    .run();

  return decision;
}

/**
 * Liste les décisions du locataire `orgId`, de la plus récente à la plus
 * ancienne. `org_id = ?` est toujours la première condition : aucun filtre ne
 * peut l'annuler, puisque les critères ne font que s'ajouter en AND.
 *
 * Non appelée à ce jour : le ledger n'est pas branché côté web (cf. en-tête).
 */
export async function listDecisions(
  db: D1Database,
  orgId: string,
  filtre: FiltreDecisions = {},
): Promise<Decision[]> {
  exigerOrgId(orgId);

  const conditions: string[] = ["org_id = ?"];
  const valeurs: unknown[] = [orgId];

  if (filtre.statut !== undefined) {
    const statuts = Array.isArray(filtre.statut) ? filtre.statut : [filtre.statut];
    if (statuts.length === 0) return [];
    if (statuts.length === 1) {
      conditions.push("statut = ?");
    } else {
      // Autant de "?" que de statuts : c'est la STRUCTURE qui varie, jamais la
      // valeur — chaque statut reste bind().
      conditions.push(`statut IN (${statuts.map(() => "?").join(", ")})`);
    }
    valeurs.push(...statuts);
  }

  if (filtre.verifyDueAvant !== undefined) {
    conditions.push("verify_due_at <= ?");
    valeurs.push(filtre.verifyDueAvant);
  }

  let requete =
    `SELECT ${COLONNES_DECISION} FROM decisions WHERE ${conditions.join(" AND ")} ` +
    "ORDER BY decided_at DESC";
  if (filtre.limite !== undefined) {
    requete += " LIMIT ?";
    valeurs.push(filtre.limite);
  }

  const resultat = await db
    .prepare(requete)
    .bind(...valeurs)
    .all<Record<string, unknown>>();
  return (resultat.results ?? []).map(versDecision);
}

/**
 * Fait passer une décision à l'état terminal 'prouve' (preuve J+30 constatée).
 *
 * Deux garde-fous, tous deux dans le WHERE donc impossibles à oublier :
 *   1. `org_id = ?` — une organisation ne peut pas promouvoir la décision d'une
 *      autre ; la requête ne touche alors aucune ligne et renvoie false ;
 *   2. `statut IN ('approuve', 'refuse')` (valeurs bindées) — on ne repromeut
 *      pas une décision déjà 'prouve', ce qui rendrait `proven_at` mouvant.
 *
 * Aucun euro n'est touché : promouvoir ne recalcule rien, cela n'écrit que le
 * statut et l'horodatage de preuve.
 *
 * Non appelée à ce jour : le ledger n'est pas branché côté web (cf. en-tête).
 *
 * @returns true si une ligne a réellement changé d'état.
 */
export async function promoteToProven(
  db: D1Database,
  orgId: string,
  decisionId: string,
  at: number,
): Promise<boolean> {
  exigerOrgId(orgId);
  const marqueurs = STATUTS_PROMOUVABLES.map(() => "?").join(", ");
  const resultat = await db
    .prepare(
      "UPDATE decisions SET statut = ?, proven_at = ? " +
        `WHERE org_id = ? AND id = ? AND statut IN (${marqueurs}) RETURNING id`,
    )
    .bind("prouve", at, orgId, decisionId, ...STATUTS_PROMOUVABLES)
    .run<{ id: string }>();

  const lignes = resultat.results ?? [];
  return lignes.length > 0 || (resultat.meta?.changes ?? 0) > 0;
}

// --- audit_log --------------------------------------------------------------

/**
 * Ajoute une entrée au journal du locataire `orgId`. Le journal est immuable :
 * ce module n'expose délibérément aucun UPDATE ni DELETE sur audit_log.
 *
 * Portée exacte de cette immuabilité, pour ne pas la survendre à un DAF : elle
 * est APPLICATIVE. La table n'a ni trigger `BEFORE UPDATE`/`BEFORE DELETE`, ni
 * chaînage d'intégrité, et le binding D1 brut reste accessible aux routes — un
 * `DELETE FROM audit_log` reste donc possible pour qui écrit du code ou détient
 * un jeton d'API Cloudflare, et resterait indétectable a posteriori.
 * « Personne n'a écrit la fonction qui l'altère » n'est pas une preuve
 * d'immuabilité : le garde-fou côté base reste à faire (migration 0002).
 */
export async function appendAudit(
  db: D1Database,
  orgId: string,
  saisie: SaisieAudit,
): Promise<AuditEntry> {
  exigerOrgId(orgId);
  const entree: AuditEntry = {
    id: saisie.id ?? nouvelId(),
    orgId,
    actor: saisie.actor,
    action: saisie.action,
    httpMethod: saisie.httpMethod ?? null,
    path: saisie.path ?? null,
    outcome: saisie.outcome,
    at: saisie.at,
  };

  await db
    .prepare(`INSERT INTO audit_log (${COLONNES_AUDIT}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      entree.id,
      entree.orgId,
      entree.actor,
      entree.action,
      entree.httpMethod,
      entree.path,
      entree.outcome,
      entree.at,
    )
    .run();

  return entree;
}

/**
 * Journal du locataire `orgId` depuis `depuis` (epoch ms inclus), du plus
 * récent au plus ancien.
 *
 * Non appelée à ce jour : aucune surface web n'expose encore le journal.
 */
export async function listAudit(
  db: D1Database,
  orgId: string,
  depuis: number,
  limite?: number,
): Promise<AuditEntry[]> {
  exigerOrgId(orgId);
  const valeurs: unknown[] = [orgId, depuis];
  let requete =
    `SELECT ${COLONNES_AUDIT} FROM audit_log WHERE org_id = ? AND at >= ? ORDER BY at DESC`;
  if (limite !== undefined) {
    requete += " LIMIT ?";
    valeurs.push(limite);
  }

  const resultat = await db
    .prepare(requete)
    .bind(...valeurs)
    .all<Record<string, unknown>>();
  return (resultat.results ?? []).map(versAuditEntry);
}

// --- Façade liée à un binding ----------------------------------------------

/**
 * Enveloppe le binding D1 une bonne fois pour toutes, pour que le code appelant
 * écrive exactement `depot.listDecisions(orgId, filtre)` : orgId redevient le
 * tout premier argument, impossible à oublier ou à intervertir avec le binding.
 *
 * Non utilisée à ce jour (cf. en-tête). Le jour où le ledger sera branché, c'est
 * cette façade qu'il faudra exposer aux routes plutôt que le `D1Database` brut :
 * elle n'offre aucune primitive d'altération du journal d'audit.
 */
export function depotTenant(db: D1Database) {
  return {
    applyMigrations: () => applyMigrations(db),
    upsertOrganization: (orgId: string, saisie: SaisieOrganization) =>
      upsertOrganization(db, orgId, saisie),
    getOrganizationByQontoId: (qontoOrgId: string) => getOrganizationByQontoId(db, qontoOrgId),
    getOrganizationById: (orgId: string) => getOrganizationById(db, orgId),
    revokeOrganization: (orgId: string, at: number) => revokeOrganization(db, orgId, at),
    insertDecision: (orgId: string, saisie: SaisieDecision) => insertDecision(db, orgId, saisie),
    listDecisions: (orgId: string, filtre?: FiltreDecisions) => listDecisions(db, orgId, filtre),
    promoteToProven: (orgId: string, decisionId: string, at: number) =>
      promoteToProven(db, orgId, decisionId, at),
    appendAudit: (orgId: string, saisie: SaisieAudit) => appendAudit(db, orgId, saisie),
    listAudit: (orgId: string, depuis: number, limite?: number) =>
      listAudit(db, orgId, depuis, limite),
  };
}
