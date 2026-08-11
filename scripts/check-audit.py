#!/usr/bin/env python3
"""
Porte de sécurité sur les dépendances de production.

`npm audit --audit-level=high` ne sait pas faire d'exception. Sans mécanisme,
on n'a que deux options : une CI rouge en permanence (donc ignorée), ou pas de
porte du tout. Ce script offre la troisième : des exceptions explicites,
justifiees et DATÉES, définies dans security/audit-exceptions.json.

Échoue si :
  - une vulnérabilité haute ou critique n'est pas listée dans les exceptions ;
  - une exception a dépassé sa date d'expiration (il faut re-trancher) ;
  - une exception ne correspond à aucune vulnérabilité réelle (nettoyage).

Usage : python3 scripts/check-audit.py [--date AAAA-MM-JJ]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import date
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
WEB = RACINE / "web"
EXCEPTIONS = RACINE / "security" / "audit-exceptions.json"

BLOQUANTES = {"high", "critical"}

ROUGE, JAUNE, VERT, GRAS, FIN = "\033[31m", "\033[33m", "\033[32m", "\033[1m", "\033[0m"


def lire_audit() -> dict:
    """Lance `npm audit` sur les dépendances de production et rend son JSON.

    npm audit sort en code 1 dès qu'il trouve quelque chose : ce n'est pas une
    erreur d'exécution, on ignore donc le code de retour et on ne se fie qu'au
    JSON. En revanche une sortie illisible est une vraie panne.
    """
    proc = subprocess.run(
        ["npm", "audit", "--json", "--omit=dev"],
        cwd=WEB,
        capture_output=True,
        text=True,
    )
    if not proc.stdout.strip():
        print(f"{ROUGE}npm audit n'a rien renvoyé.{FIN}\n{proc.stderr[:500]}", file=sys.stderr)
        sys.exit(2)
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as err:
        print(f"{ROUGE}Sortie de npm audit illisible : {err}{FIN}", file=sys.stderr)
        sys.exit(2)


def vulnerabilites_bloquantes(rapport: dict) -> dict[str, str]:
    """{nom du paquet: gravité} pour les seules gravités hautes et critiques."""
    return {
        nom: v.get("severity", "?")
        for nom, v in rapport.get("vulnerabilities", {}).items()
        if v.get("severity") in BLOQUANTES
    }


def lire_exceptions() -> list[dict]:
    if not EXCEPTIONS.exists():
        return []
    with EXCEPTIONS.open(encoding="utf-8") as fichier:
        return json.load(fichier).get("exceptions", [])


def main() -> int:
    parseur = argparse.ArgumentParser()
    parseur.add_argument(
        "--date",
        help="Date du jour au format AAAA-MM-JJ (pour les tests).",
        default=None,
    )
    args = parseur.parse_args()
    aujourdhui = date.fromisoformat(args.date) if args.date else date.today()

    vulns = vulnerabilites_bloquantes(lire_audit())
    exceptions = lire_exceptions()
    par_paquet = {e["paquet"]: e for e in exceptions}

    fautes: list[str] = []

    # 1. Vulnérabilités non couvertes par une exception.
    for nom, gravite in sorted(vulns.items()):
        if nom not in par_paquet:
            fautes.append(f"{gravite.upper()} · {nom} : aucune exception documentée.")

    # 2. Exceptions expirées : la CI doit redevenir rouge pour forcer l'arbitrage.
    for exc in exceptions:
        if exc["paquet"] not in vulns:
            continue
        expiration = date.fromisoformat(exc["expire_le"])
        if expiration < aujourdhui:
            jours = (aujourdhui - expiration).days
            fautes.append(
                f"{exc['paquet']} : exception expirée depuis {jours} jour(s) "
                f"(échéance {exc['expire_le']}). À re-trancher."
            )

    # 3. Exceptions devenues inutiles : on garde le fichier honnête.
    obsoletes = [e["paquet"] for e in exceptions if e["paquet"] not in vulns]

    print(f"{GRAS}Audit des dépendances de production{FIN}")
    print(f"  vulnérabilités hautes/critiques : {len(vulns)}")
    print(f"  exceptions documentées          : {len(exceptions)}")

    for nom, gravite in sorted(vulns.items()):
        exc = par_paquet.get(nom)
        if exc:
            reste = (date.fromisoformat(exc["expire_le"]) - aujourdhui).days
            etat = f"expire dans {reste} j" if reste >= 0 else f"EXPIRÉE depuis {-reste} j"
            couleur = JAUNE if reste >= 0 else ROUGE
            print(f"  {couleur}· {nom} ({gravite}) — exception, {etat}{FIN}")
        else:
            print(f"  {ROUGE}· {nom} ({gravite}) — NON COUVERTE{FIN}")

    if obsoletes:
        print(f"\n{JAUNE}Exceptions sans vulnérabilité correspondante (à retirer) :{FIN}")
        for nom in obsoletes:
            print(f"  · {nom}")
        fautes.append(
            "Exceptions obsolètes à retirer de security/audit-exceptions.json : "
            + ", ".join(obsoletes)
        )

    print()
    if fautes:
        print(f"{ROUGE}{GRAS}Porte de sécurité fermée :{FIN}")
        for faute in fautes:
            print(f"  {ROUGE}✗{FIN} {faute}")
        return 1

    print(f"{VERT}✓ Toute vulnérabilité haute ou critique est couverte par une exception valide.{FIN}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
