# Argentier

Agent d'optimisation bancaire et fiscale pour TPE, freelances et EI, branché sur Qonto.
**Ton vrai run-rate, pas ton relevé.**

Argentier lit le compte **en lecture seule**, sépare les 4 natures de flux
(pilotable / structurel / ponctuel / perso), chiffre ce qui est récupérable et le
rend actionnable en un écran : hero « tu peux récupérer X €/an », score de santé,
runway, simulateur de leviers, fil d'anomalies.

## Architecture (le principe non négociable)

> **Le LLM classe, `engine.ts` calcule.** Claude étiquette chaque marchand
> (nature, pôle, action, ratio d'économie). Tout montant en euros est calculé par
> le moteur déterministe. Le LLM ne multiplie jamais.

```
Qonto (lecture seule)  ─▶  categorize.ts (Claude : étiquettes)  ─▶  engine.ts (€)  ─▶  /api/analyze  ─▶  front
   lib/mcp/qonto-read-client.ts   lib/categorize.ts                lib/engine.ts     app/api/analyze    app/Argentier.tsx
```

### Connexion Qonto : OAuth par visiteur

Chaque visiteur connecte **son** compte (`/api/auth/qonto/start` → consentement
Qonto → `/api/auth/qonto/callback`). Les jetons sont chiffrés (AES-GCM) dans KV,
la session est un cookie signé qui ne contient qu'un identifiant de locataire
opaque, et `/api/auth/qonto/revoke` débranche tout.

> ⚠️ Le serveur d'autorisation de Qonto **ignore** le paramètre `scope` et
> délivre un jeton doté de droits d'**écriture** qu'on ne peut pas refuser
> (vérifié à la main, cf. `lib/auth/providers.ts`). La lecture seule d'Argentier
> ne vient donc PAS du jeton : elle vient de l'**allowlist applicative**
> (`lib/mcp/readonly-guard.ts`), traversée avant chaque appel réseau. C'est une
> frontière de sécurité de premier ordre, couverte par plus de 500 tests dont
> un invariant de dépôt (voir ci-dessous). Le jour où
> Qonto délivre un client OAuth dédié en `.read`, la bascule est une variable
> d'environnement (`QONTO_OAUTH_PROVIDER=direct-readonly`), pas une réécriture.

| Fichier | Rôle |
|---|---|
| `lib/types.ts` | Le contrat d'API (fait foi entre front et back). |
| `lib/auth/providers.ts` | Description des serveurs d'autorisation (le seul endroit qui dépend d'un fournisseur). |
| `lib/auth/pkce.ts` · `oauth-client.ts` | PKCE S256 + client OAuth 2.1 générique (client public). |
| `lib/auth/crypto.ts` · `token-store.ts` | Chiffrement AES-GCM des jetons + stockage KV. Repli mémoire en dev **uniquement** : en production, binding absent = refus. |
| `lib/auth/session.ts` · `access.ts` | Cookie de session signé (HMAC) + renouvellement transparent du jeton. |
| `lib/mcp/readonly-guard.ts` | **Allowlist read-only** : méthode + chemin, deny by default. |
| `lib/mcp/qonto-read-client.ts` | Client Qonto authentifié par jeton — une seule sortie réseau, filtrée. |
| `lib/privacy/egress.ts` | Filtre anti-PII : `assertNoPii` avant chaque `fetch` sortant (règle 3). |
| `lib/db/tenant.ts` · `db/0001_init.sql` | Socle multi-locataire D1 : organisations, décisions, journal d'audit. |
| `lib/categorize.ts` | Catégorisation Claude (`claude-sonnet-5`) + fallback règles. |
| `lib/engine.ts` | Moteur déterministe : natures, run-rate, pôles, score, runway, leviers, anomalies. |
| `lib/letters.ts` | Lettres de résiliation / renégociation via Claude + gabarit de secours. |
| `lib/export.ts` | Export du plan en CSV (Excel FR). |
| `lib/mock.ts` | Données de démo (fallback sans clés). |
| `app/api/analyze/route.ts` | Orchestration OBSERVE → CATÉGORISE → CALCULE (session OAuth, sinon démo — jamais le compte d'un autre). |
| `app/api/auth/qonto/*` | Flux OAuth : `start`, `callback`, `revoke`, `status`. |
| `app/api/letter/route.ts` | Prépare un courrier prêt à envoyer pour un levier. |
| `app/Argentier.tsx` | Le front d'entrée (hero, ledger, simulateur, anomalies, lettres). |
| `app/rapport/page.tsx` | Rapport imprimable (→ PDF via impression). |

## Démarrer

```bash
npm install
cp .env.example .env.local   # optionnel : renseigner les clés
npm run dev                  # http://localhost:3000
```

**Sans clés**, l'app tourne en mode démo (données mock) — démontrable en pitch.
**Avec les clés** (`.env.local`), elle analyse un vrai compte :

```env
ANTHROPIC_API_KEY=sk-ant-...          # sans : catégorisation par règles (mots-clés)

# Connexion OAuth du visiteur — le SEUL chemin vers un vrai compte
QONTO_OAUTH_PROVIDER=mcp-proxy        # ou direct-readonly, le jour du client dédié
ARGENTIER_BASE_URL=http://localhost:3000
ARGENTIER_TOKEN_KEY=...               # 32 octets base64 : chiffre les jetons au repos
ARGENTIER_SESSION_SECRET=...          # 32 caractères min : signe le cookie de session
```

Les deux secrets se génèrent avec :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Production : Cloudflare Workers, et deux bindings obligatoires

La cible de production est **Cloudflare Workers** (OpenNext + `wrangler.jsonc`).
Deux bindings y sont provisionnés, et ils ne sont pas optionnels :

| Binding | Type | Rôle | Sans lui, en production |
|---|---|---|---|
| `ARGENTIER_TOKENS` | KV | Jetons OAuth chiffrés AES-GCM, TTL calé sur le refresh token | **refus** (`BindingManquantError`) |
| `ARGENTIER_DB` | D1 (`weur`) | Socle multi-locataire : organisations, décisions, `audit_log` (cf. [`db/README.md`](db/README.md)) | **refus** (`BindingManquantError`) |

Hors production (`next dev`, tests), leur absence est tolérée : jetons en
mémoire du process, aucun journal. En production, elle **lève**, et
`/api/analyze` répond `503 configuration_incomplete`. Ce n'est pas une rigidité
gratuite : un jeton bancaire porteur de `request_transfers.write` gardé en clair
dans le tas d'une lambda, sans expiration et sans révocation d'une instance à
l'autre, n'est pas un « mode dégradé » — et une lecture bancaire sans trace est
exactement ce qu'un DAF nous paie pour empêcher. L'échappatoire
`ARGENTIER_ALLOW_DEGRADED_BINDINGS=1` existe pour un build local, jamais pour
servir du trafic.

```bash
npx opennextjs-cloudflare build
npx wrangler deploy
```

### Ce qui a été RETIRÉ, et ne doit pas revenir

Le client Qonto par **clé API statique** (`lib/qonto.ts`, et les variables
`QONTO_LOGIN` / `QONTO_SECRET_KEY` / `QONTO_IBAN`) est **supprimé**. Une seule
clé, celle du fondateur, était partagée par tous les visiteurs et portait les
droits d'**écriture** complets. Elle causait deux défauts distincts :

1. **fuite inter-locataire.** `/api/analyze` enchaînait les sources sans
   distinguer « pas de visiteur » de « visiteur connu dont le jeton a disparu ».
   Un client OAuth dont le jeton s'évaporait (cookie encore valide, refresh
   refusé, KV vidé) basculait sans condition sur cette clé et recevait le compte
   bancaire **réel du fondateur**, badgé « live ». Désormais : une session sans
   jeton exploitable reçoit un **401 `qonto_reconnexion_requise`**, jamais les
   données d'un autre. Le visiteur **anonyme**, lui, garde la démo (`/demo`
   fonctionne sans la moindre clé) — badgée `source: "mock"`.
2. **sortie réseau hors garde.** Ce client appelait `fetch` sans passer par
   `assertReadOnly`, c'est-à-dire à côté de la seule frontière qui empêche
   Argentier de bouger de l'argent. L'invariant est maintenant **vérifié à
   l'échelle du dépôt** par `lib/mcp/__tests__/invariant-fetch-qonto.test.ts` :
   tout module de `lib/` ou `app/` qui appelle `fetch` sur un hôte Qonto doit
   importer *et* appeler la garde, sous peine de test rouge. Le même test passe
   au rouge si `QONTO_LOGIN` réapparaît dans le code.

Si ces variables subsistent dans un environnement de déploiement, **retire-les**
côté hébergeur : elles ne sont plus lues, mais une clé write-capable qui traîne
dans un secret store reste une clé exfiltrable.

Vérifs :

```bash
npm run typecheck
npm test
npm run build
```

## Ce qu'Argentier NE fait pas

- Aucune action bancaire : pas de paiement, pas de résiliation automatique.
  Il conseille et prépare ; **c'est toi qui agis** (PRD §3, §5.8).
- Aucune donnée utilisée pour entraîner un modèle. Traitement en Europe.
- Conseils fiscaux = pistes à valider avec un comptable.

## Roadmap (extrait PRD §13)

- **M0 (démo)** — front + `/api/analyze` branché Qonto, données réelles, sans persistance. ✅
- **M1 (MVP)** — export CSV + lettres de résiliation/renégociation + rapport PDF ✅ · auth (magic link), persistance Postgres, freemium ⏳
- **M2** — multi-banque (Bridge/Powens), benchmarking anonymisé, suivi des économies réalisées, pricing à la performance.

### Couche « passage à l'action » (M1, livrée)

- **Export du plan** — bouton *Exporter le plan (CSV)* → téléchargement Excel-compatible (BOM UTF-8).
- **Rapport imprimable** — `/rapport` → *Imprimer / Enregistrer en PDF*.
- **Lettres prêtes à envoyer** — l'icône ✎ sur chaque levier ouvre un courrier rédigé par Claude
  (résiliation / renégociation / consolidation selon l'action), éditable, avec bouton *Copier*.
  Argentier prépare, **tu envoies** : aucun envoi automatique, `[crochets]` à compléter.

## Modèle Claude

La catégorisation utilise `claude-sonnet-5` (configurable via `ARGENTIER_MODEL`),
conformément au PRD §6. Structured outputs (`output_config.format`) garantissent un
JSON valide ; le LLM ne renvoie que des étiquettes, jamais des euros.
