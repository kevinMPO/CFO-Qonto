#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Garde-fou secrets — refuse tout commit contenant une clé, un identifiant
# bancaire ou un fichier d'environnement. Appelé par la CI et utilisable en
# local : ./scripts/check-secrets.sh
#
# N'inspecte QUE les fichiers suivis par git (via `git grep`) : ce qui est
# gitignoré n'a pas vocation à être scanné, et .env.local doit pouvoir
# contenir de vraies clés sans faire échouer la vérification.
#
# Compatible bash 3.2 (macOS) : ni `mapfile`, ni tableaux associatifs.
# ---------------------------------------------------------------------------
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

ROUGE=$'\033[31m'; VERT=$'\033[32m'; GRAS=$'\033[1m'; FIN=$'\033[0m'
fautes=0

# Exclusions communes, passées en paramètres positionnels pour être réutilisées
# comme pathspecs `git grep` via "$@". Ce script s'auto-exclut : il contient les
# motifs de détection, qui déclencheraient sinon ses propres alertes.
set -- ':!*.png' ':!*.jpg' ':!*.jpeg' ':!*.gif' ':!*.pdf' ':!*.ico' \
       ':!*.woff' ':!*.woff2' ':!*-lock.json' ':!*.lock' ':!scripts/check-secrets.sh'

signaler() {
  printf '%s%s✗ %s%s\n' "$ROUGE" "$GRAS" "$1" "$FIN"
  printf '%s\n' "$2" | sed 's/^/   /' | cut -c1-160
  fautes=$((fautes + 1))
}

# Filtre une sortie `git grep` (chemin:ligne:contenu) en n'appliquant le motif
# d'exclusion QU'AU CONTENU. Indispensable : sinon un fichier situé sous
# __tests__/ ou nommé *example* exempterait tout son contenu de la détection,
# alors que ce sont précisément les endroits où traînent les données réalistes.
# Le motif attendu est en minuscules.
filtrer_contenu() {
  awk -v excl="$1" '{
    contenu = $0
    sub(/^[^:]*:[0-9]+:/, "", contenu)
    if (tolower(contenu) !~ excl) print
  }'
}

# --- 1. Aucun fichier d'environnement ne doit être suivi -------------------
# .env.example est la seule exception légitime (gabarits uniquement).
env_suivis=$(git ls-files | grep -E '(^|/)\.env' | grep -v '\.env\.example$' || true)
[ -n "$env_suivis" ] && signaler "Fichier d'environnement suivi par git" "$env_suivis"

# --- 2. Clés d'API en clair ------------------------------------------------
# Chaque motif vise un préfixe propriétaire : peu de faux positifs.
while IFS='|' read -r nom motif; do
  [ -z "$nom" ] && continue
  trouve=$(git grep -InE "$motif" -- "$@" 2>/dev/null | head -5 || true)
  [ -n "$trouve" ] && signaler "$nom en clair" "$trouve"
done <<'MOTIFS'
Clé API Anthropic|sk-ant-[A-Za-z0-9_-]{20,}
Clé API OpenAI|sk-[A-Za-z0-9]{32,}
Clé API Linkup|lk_[A-Za-z0-9]{24,}
Token GitHub|gh[pousr]_[A-Za-z0-9]{30,}
Clé privée PEM|-----BEGIN [A-Z ]*PRIVATE KEY-----
Token Cloudflare|CLOUDFLARE_API_TOKEN[[:space:]]*[=:][[:space:]]*[A-Za-z0-9_-]{30,}
URL avec identifiants|https?://[^/[:space:]:]+:[^/[:space:]@]+@
MOTIFS

# --- 3. Variables sensibles affectées à autre chose qu'un gabarit ----------
# Tolérés : vide, <à provisionner>, your-key-here, ${VAR}, process.env...
# .env.example est exclu par pathspec (choix explicite), pas par mot-clé.
SENSIBLES='QONTO_SECRET_KEY|QONTO_LOGIN|ANTHROPIC_API_KEY|LINKUP_API_KEY|ELEVENLABS_API_KEY|ARGENTIER_TOKEN_KEY|ARGENTIER_SESSION_SECRET'
affectations=$(git grep -InE "($SENSIBLES)[[:space:]]*=[[:space:]]*[\"']?[A-Za-z0-9+/_-]{16,}" -- "$@" ':!*.env.example' 2>/dev/null \
  | filtrer_contenu '(your|placeholder|xxxx|changeme|provisionner|remplacer|<|\$\{|process\.env)' || true)
[ -n "$affectations" ] && signaler "Variable sensible affectée à une valeur littérale" "$affectations"

# --- 4. Données bancaires réelles (règle 3 : zéro PII) ---------------------
# Pas de `\b` : git grep -E utilise une ERE POSIX qui ne le supporte pas et
# échouerait SILENCIEUSEMENT. La structure du motif (2 lettres, 2 chiffres,
# 11 à 30 alphanumériques majuscules) sert de pré-filtre grossier.
#
# Le tri fin se fait ensuite sur la CLÉ DE CONTRÔLE mod-97 (ISO 13616) : un
# IBAN réel la vérifie toujours, un IBAN inventé pour une fixture presque
# jamais. C'est un critère structurel, bien plus fiable qu'une liste de
# mots-clés — et il ne dépend pas de la bonne volonté de celui qui écrit
# le test. L'IBAN de documentation français est exclu nommément.
ibans=$(git grep -InE '[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}' -- "$@" 2>/dev/null \
  | python3 "$(dirname "$0")/iban-mod97.py" || true)
[ -n "$ibans" ] && signaler "IBAN valide (clé mod-97 correcte) dans un fichier suivi" "$ibans"

# --- 5. Snapshots de flux bancaires ---------------------------------------
flux=$(git ls-files | grep -E 'data/(flows-|qonto-snapshot)' || true)
[ -n "$flux" ] && signaler "Données bancaires brutes suivies par git" "$flux"

# --- Verdict ---------------------------------------------------------------
total=$(git ls-files | wc -l | tr -d ' ')
echo
if [ "$fautes" -gt 0 ]; then
  printf '%s%s%d catégorie(s) de fuite détectée(s). Commit refusé.%s\n' "$ROUGE" "$GRAS" "$fautes" "$FIN"
  exit 1
fi
printf '%s✓ Aucun secret ni donnée bancaire dans les %s fichiers suivis.%s\n' "$VERT" "$total" "$FIN"
