# Argentier dans Slack — installation (admin)

Pour un·e admin de workspace Slack. ~15 min. À la fin, taper `@Claude` dans Slack
et demander un audit de dépenses déclenche la skill Argentier, qui fait calculer
le moteur déterministe d'Argentier.

## Prérequis

- Un workspace Slack où tu peux installer/administrer l'app Claude.
- Un déploiement Argentier joignable en HTTPS (par défaut `https://getargentier.com`).
- Accès aux variables d'environnement de ce déploiement (Vercel).

## 1. Installer Claude dans Slack (Claude Tag)

Suis le flux officiel d'installation de Claude pour Slack (côté Claude Code :
`/install-slack-app`, ou l'installation depuis l'admin de ton espace). Une fois
l'app présente, `@Claude` répond dans les canaux où elle est invitée.

## 2. Armer l'API moteur (côté déploiement Argentier)

L'API `/api/v1/engine` est **fermée par défaut** : sans jeton, elle répond `503`.

1. Génère un jeton dédié à Slack :
   ```bash
   node -e "console.log('eng_'+require('crypto').randomBytes(24).toString('hex'))"
   ```
2. Ajoute-le à la variable `ENGINE_API_TOKENS` du déploiement (valeurs séparées
   par des virgules si tu en as plusieurs). Sur Vercel :
   ```bash
   vercel env add ENGINE_API_TOKENS production   # colle le(s) jeton(s)
   vercel --prod --yes                            # redéploie pour prise en compte
   ```
3. Vérifie que l'API répond :
   ```bash
   curl -s https://getargentier.com/api/v1/engine/health
   # {"ok":true,"engineVersion":"1.0.0","ts":"..."}
   ```

> Rotation : retire l'ancien jeton de `ENGINE_API_TOKENS`, ajoute le nouveau,
> redéploie. Les jetons sont comparés en temps constant et hachés avant tout
> comptage de débit — ils n'apparaissent jamais en clair dans un stockage.

## 3. Fournir la skill à Claude Tag

Rends ce dossier `claude-tag/` disponible comme skill à ton app Claude Slack
(selon le mécanisme de skills de ton espace : dépôt connecté ou import). La skill
lit deux secrets, à définir dans l'environnement d'exécution de la skill :

| Secret | Valeur |
|---|---|
| `ENGINE_API_URL` | `https://getargentier.com` (ou ton domaine) |
| `ENGINE_API_TOKEN` | le jeton généré à l'étape 2 |

Le script `scripts/call_engine.py` n'utilise que la bibliothèque standard Python
(pas de `pip install`).

## 4. Test de bout en bout

Dans un canal où Claude est invité :

> `@Claude` audite ces dépenses : Notion 20€ le 15/06, 15/07 et 15/08 ;
> Apollo 100€/mois ; Instantly 90€/mois (on double avec Apollo).

Claude doit : poser les natures/motifs/actions, appeler `call_engine.py analyze`,
puis présenter les leviers avec les euros **du moteur** (jamais recalculés).

## 5. Qualification des accès

L'accès Slack est **qualifié** : la landing (`getargentier.com`) récolte les
demandes via le bouton « Demander l'accès Slack » (marquées `source=slack` dans
la liste d'attente KV). Ouvre l'accès aux workspaces dont l'usage correspond
(TPE/EI clientes Qonto qui veulent piloter leurs dépenses), pas en libre-service.

## Rappels de sécurité

- La skill est **read-only** : elle ne peut pas bouger d'argent (l'API moteur ne
  fait que calculer, il n'existe aucun endpoint d'écriture).
- Le débit est de **60 requêtes/minute par jeton**. Si plusieurs canaux tapent
  fort, donne-leur des jetons distincts pour isoler les débits.
- Ne mets jamais un jeton moteur dans un message Slack ou un fichier partagé :
  c'est un secret d'environnement.
