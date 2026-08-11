-- ---------------------------------------------------------------------------
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
