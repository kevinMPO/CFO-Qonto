# Argentier — Agent DAF (dans Claude Code)

Argentier analyse **en lecture seule** un compte Qonto reel, benchmarke les depenses
via Linkup / Bright Data, et **prepare** des livrables (mails, lettres). Il n'agit
jamais a ta place : tu declenches, tu relis, tu approuves.

## Les 4 regles non negociables

1. **Read-only Qonto.** Seuls les tools de lecture sont autorises. Tous les tools
   d'ecriture Qonto sont DURS-BLOQUES dans `.claude/settings.json` (`deny` > `allow`).
   Ne jamais tenter de les appeler.
2. **engine.py calcule, jamais le LLM.** Tout montant en euros vient de `engine.py`.
   Claude ne fait aucune arithmetique financiere lui-meme ; il reprend les chiffres du moteur.
3. **Zero PII vers le web.** Vers Linkup / Bright Data : uniquement le nom du marchand
   et la categorie. Jamais d'IBAN, de numero de compte, de `transaction_id`, ni de donnee perso.
4. **Chaque prix affiche = source + date.** Sinon, rejet et 1 seul retry, puis « non verifie ».

## Methode (boucle /audit)

OBSERVE (Qonto 90 j) → ANALYSE (engine.py) → BENCHMARK (avec ton accord, Linkup/Bright Data)
→ RECOMMANDER (carte sourcee+datee, passe de verification) → GATE HUMAIN (livrable dans
`drafts/`, « PRET — A ENVOYER PAR TOI ») → LEDGER (`data/decisions.json`).

## Regles metier du moteur (engine.py)

- Marchand normalise via `clean_counterparty_name`, sinon `label`.
- **Recurrence** = marchand vu >= 2 fois sur 90 j a montant similaire. Un one-off n'est
  JAMAIS annualise. **Annualisation = montant mensuel x 12.**
- Detecte : abonnements SaaS recurrents, **doublons** (meme marchand 2x le meme jour, ou
  2 abonnements paralleles chez le meme marchand), **frais de change** (`qonto_fee` +
  reference `fx_card`) agreges en un seul levier.
- **Compte EI** (perso + pro melanges) : classe chaque depense en **PRO / PERSO / A-CLARIFIER**.
  En cas de doute → A-CLARIFIER. C'est la brique la plus utile : voir les listes de mots-cles
  dans `engine.py` (`PRO_KEYWORDS`, `PERSO_KEYWORDS`), extensibles via `data/profile.json`.

## Moteur web (`web/lib/engine`) et taxonomie des leviers

Le miroir TypeScript du moteur (`web/lib/engine/core.ts`) applique la meme regle #2 :
le LLM ne rend que des ETIQUETTES (categories), le moteur detient les euros.

- **Nature** ∈ pilotable | structurel | ponctuel | perso.
- **Motif** ∈ abonnement | doublon | fx | variable (orthogonal a la nature).
- Un **levier** n'existe QUE si `nature = pilotable` ET `motif ∈ {abonnement, doublon, fx}`.
  Un one-off (`variable`) n'en produit jamais.
- Economie €/mois = montant mensuel × `RATIO_ECONOMIE[action]`, table CONSTANTE du
  moteur (cancel 1.0, consolidate 0.5, switch 0.4, downgrade 0.3, renegotiate 0.2). Le
  LLM choisit l'`action` (une categorie) ; il n'emet jamais le ratio ni l'euro. Avant,
  `savingRatio` etait un nombre EMIS par le LLM — c'etait la violation de la regle #2,
  reparee (meme patron que le moteur de risque : le LLM etiquette, la table score).
- `ENGINE_VERSION` est jointe a chaque reponse de l'API moteur.

## API moteur publique (`/api/v1/engine`) et Claude Tag

Le moteur est appelable en HTTP, 100 % deterministe, aucun appel LLM/reseau/ecriture cote serveur :

- `POST /api/v1/engine/analyze` — audite des transactions (+ `labels` optionnels deja poses).
- `POST /api/v1/engine/simulate` — projette l'impact de decisions (activer/desactiver des leviers).
- `GET  /api/v1/engine/health` — sonde ouverte : `{ ok, engineVersion, ts }`.

Auth Bearer (`ENGINE_API_TOKENS`, sinon 503), validation Zod `.strict()`, debit 60/min
par jeton (best-effort en memoire sur Vercel). `claude-tag/` rend Argentier utilisable
depuis Slack (@Claude) : la skill ETIQUETTE, `scripts/call_engine.py` fait CALCULER
l'API moteur, Claude reprend les chiffres verbatim.

## Fichiers

| Fichier | Role |
|---|---|
| `engine.py` | Moteur de calcul deterministe (le cerveau chiffre, cote CLI). |
| `tests/test_engine.py` | Tests des regles (recurrence, annualisation, doublons, FX, classification). |
| `web/lib/engine/core.ts` | Miroir web du moteur : leviers, motif, `RATIO_ECONOMIE`, `ENGINE_VERSION`. |
| `web/lib/engine/api.ts` | Frontiere HTTP de l'API moteur (Zod strict, auth Bearer, analyze/simulate). |
| `web/app/api/v1/engine/` | Routes publiques `analyze` / `simulate` / `health`. |
| `claude-tag/` | Skill Slack (Claude Tag) : `SKILL.md`, `standing-instructions.md`, `ADMIN-SETUP.md`, `scripts/call_engine.py`. |
| `.claude/settings.json` | Le garde-fou : read-only Qonto (deny > allow). |
| `.claude/commands/audit.md` | La commande `/audit`. |
| `.claude/commands/verify.md` | La commande `/verify` (preuve J+30). |
| `data/profile.json` | Ton identite : criteres, fournisseurs intouchables, refus passes. |
| `data/decisions.json` | Le ledger : decisions + economies prouvees / en attente. |
| `data/flows-*.json` | Flux Qonto bruts (gitignores, jamais commites). |
| `drafts/` | Livrables prets a envoyer (par toi). |

## Comment relancer

```bash
python3 -m unittest discover -s tests    # verifier que le moteur est sain
python3 engine.py data/exemple-demo.json  # voir le rendu sur l'echantillon
```

Dans une session Claude Code : `/audit` (analyse + reco) puis, ~30 jours apres une
action, `/verify` (preuve). Les cles MCP sont en scope `local` (`~/.claude.json`),
hors du repo.
