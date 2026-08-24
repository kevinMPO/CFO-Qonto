#!/usr/bin/env python3
# ---------------------------------------------------------------------------
# call_engine.py — pont entre Claude (dans Slack) et l'API moteur d'Argentier.
#
# Claude ÉTIQUETTE (nature, motif, action) ; ce script fait CALCULER le moteur
# déterministe et rend ses chiffres VERBATIM. Le LLM ne multiplie jamais un euro
# lui-même (règle #2). Bibliothèque standard uniquement : aucun `pip install`,
# pour tourner dans le bac à sable d'exécution de Claude Tag.
#
# Config (variables d'environnement / secrets de la skill) :
#   ENGINE_API_URL    base publique, défaut https://getargentier.com
#   ENGINE_API_TOKEN  jeton Bearer (un des ENGINE_API_TOKENS du déploiement)
#
# Usage :
#   echo '<json>' | python3 call_engine.py analyze
#   python3 call_engine.py analyze  --file audit.json
#   python3 call_engine.py simulate --file audit.json
#   python3 call_engine.py health
#
# Le <json> attendu par `analyze` / `simulate` :
#   {
#     "windowDays": 90,
#     "account": { "name": "...", "bank": "Qonto", "balance": 0 },
#     "transactions": [
#       { "merchant": "Notion", "amount": 20, "date": "2026-08-15" }, ...
#     ],
#     "labels": [   # optionnel — les étiquettes posées par Claude
#       { "merchant": "Notion", "nature": "pilotable",
#         "motif": "abonnement", "action": "cancel", "isSubscription": true }
#     ]
#   }
# ---------------------------------------------------------------------------

import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_BASE = "https://getargentier.com"
TIMEOUT_S = 30


def _fail(message, code=1):
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False), file=sys.stderr)
    sys.exit(code)


def _read_body(argv):
    """Corps JSON : depuis --file <path>, sinon depuis stdin."""
    if "--file" in argv:
        i = argv.index("--file")
        try:
            path = argv[i + 1]
        except IndexError:
            _fail("--file attend un chemin")
        try:
            with open(path, "r", encoding="utf-8") as fh:
                raw = fh.read()
        except OSError as exc:
            # Fichier absent / dossier / permission : on rend le MEME contrat
            # d'erreur JSON que le reste du script, jamais un traceback brut.
            _fail("fichier illisible (%s) : %s" % (path, exc))
    else:
        raw = sys.stdin.read()
    if not raw.strip():
        _fail("corps JSON vide : fournis les transactions sur stdin ou via --file")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        _fail("JSON invalide : %s" % exc)


def _request(method, url, token, payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer %s" % token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        try:
            body = json.loads(body)
        except json.JSONDecodeError:
            pass
        return exc.code, body
    except urllib.error.URLError as exc:
        _fail("réseau : %s" % exc.reason)


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return
    endpoint = argv[0]
    if endpoint not in ("analyze", "simulate", "health"):
        _fail("endpoint inconnu « %s » (analyze | simulate | health)" % endpoint)

    base = os.environ.get("ENGINE_API_URL", DEFAULT_BASE).rstrip("/")
    token = os.environ.get("ENGINE_API_TOKEN", "")
    url = "%s/api/v1/engine/%s" % (base, endpoint)

    if endpoint == "health":
        status, body = _request("GET", url, token=None)
    else:
        if not token:
            _fail("ENGINE_API_TOKEN manquant : impossible d'appeler /%s" % endpoint)
        payload = _read_body(argv)
        status, body = _request("POST", url, token=token, payload=payload)

    # On rend TOUJOURS la réponse du moteur telle quelle : ses chiffres sont la
    # source de vérité, Claude les reprend sans les recalculer.
    print(json.dumps(body, ensure_ascii=False, indent=2))
    if status != 200:
        sys.exit(2)


if __name__ == "__main__":
    main()
