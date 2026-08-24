#!/usr/bin/env python3
"""
sum_ledger.py — recalcule DETERMINISTIQUEMENT les totaux du ledger.

Regle #2 : le moteur (code) calcule chaque euro, jamais le LLM. Ce script
remplace le « deplace le montant » de /verify (ou le LLM additionnait a la main)
par une somme reproductible depuis `data/decisions.json` :

  economies_prouvees_eur_an   = somme des `montant_annualise` des decisions `prouve`
  economies_en_attente_eur_an = somme des `montant_annualise` des decisions `approuve`
                                (approuve = valide, pas encore prouve a J+30)
  economies_reversees_eur_an  = somme des `montant_annualise` des decisions `reverte`
                                (net-de-reversion : une economie prouvee qui est repartie
                                 -- abonnement re-souscrit, prix remonte -- passe en `reverte`
                                 et sort AUTOMATIQUEMENT du total prouve. La North Star
                                 s'auto-corrige : elle ne peut que refleter ce qui tient encore.)

Le mode --check ne reecrit rien : il sort avec un code != 0 si les scalaires
stockes divergent du recalcul. C'est le garde-fou qui detecte une somme qui
aurait derive (p. ex. additionnee a la main par le LLM).

Usage :
  python3 sum_ledger.py [chemin]           # recalcule ET reecrit les scalaires
  python3 sum_ledger.py [chemin] --check    # verifie sans reecrire ; exit!=0 si derive
"""
from __future__ import annotations

import json
import sys
import unicodedata

DEFAULT_PATH = "data/decisions.json"


def _norm(value: object) -> str:
    """Minuscule + sans accent, pour comparer les statuts de facon robuste."""
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(c for c in text if not unicodedata.combining(c))
    return text.strip().lower()


def _amount(decision: dict) -> float:
    """Montant annualise d'une decision (0 si absent/non numerique)."""
    raw = decision.get("montant_annualise", decision.get("montant_annuel_eur", 0))
    try:
        return float(raw or 0)
    except (TypeError, ValueError):
        return 0.0


# Statuts consideres comme « economie repartie » (net-de-reversion).
REVERTED_STATUSES = frozenset({"reverte", "reversee", "reverted"})


def compute_totals(decisions: list) -> tuple:
    """Renvoie (prouvees, en_attente) en euros/an, arrondis a l'entier."""
    prouvees = 0.0
    en_attente = 0.0
    for decision in decisions:
        if not isinstance(decision, dict):
            continue
        statut = _norm(decision.get("statut"))
        if statut == "prouve":
            prouvees += _amount(decision)
        elif statut == "approuve":
            en_attente += _amount(decision)
        # refuse / reverte / inconnu -> ne compte pas dans prouvees ni en_attente
    return round(prouvees), round(en_attente)


def compute_reversed(decisions: list) -> int:
    """Somme des economies repartis (statut `reverte`), en euros/an."""
    total = 0.0
    for decision in decisions:
        if isinstance(decision, dict) and _norm(decision.get("statut")) in REVERTED_STATUSES:
            total += _amount(decision)
    return round(total)


def recompute(path: str = DEFAULT_PATH, *, check: bool = False) -> int:
    with open(path, encoding="utf-8") as handle:
        ledger = json.load(handle)

    decisions = ledger.get("decisions", [])
    prouvees, en_attente = compute_totals(decisions)
    reversees = compute_reversed(decisions)
    old_p = ledger.get("economies_prouvees_eur_an", 0)
    old_a = ledger.get("economies_en_attente_eur_an", 0)
    old_r = ledger.get("economies_reversees_eur_an", 0)

    if check:
        if old_p != prouvees or old_a != en_attente or old_r != reversees:
            print(
                f"DERIVE ledger : prouvees {old_p} -> {prouvees}, "
                f"en_attente {old_a} -> {en_attente}, reversees {old_r} -> {reversees}",
                file=sys.stderr,
            )
            return 1
        print(
            f"OK : prouvees={prouvees} en_attente={en_attente} "
            f"reversees={reversees} (aucune derive)"
        )
        return 0

    ledger["economies_prouvees_eur_an"] = prouvees
    ledger["economies_en_attente_eur_an"] = en_attente
    ledger["economies_reversees_eur_an"] = reversees
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(ledger, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print(
        f"Ledger recalcule : prouvees={prouvees} en_attente={en_attente} "
        f"reversees={reversees}"
    )
    return 0


def main(argv: list) -> int:
    check = "--check" in argv
    positional = [a for a in argv[1:] if not a.startswith("--")]
    path = positional[0] if positional else DEFAULT_PATH
    return recompute(path, check=check)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
