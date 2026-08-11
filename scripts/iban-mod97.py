#!/usr/bin/env python3
"""
Filtre de lignes `git grep` : ne conserve que celles contenant un IBAN dont la
clé de contrôle mod-97 (ISO 13616) est VALIDE.

Un IBAN réel vérifie toujours sa clé. Un IBAN inventé pour une fixture de test
la vérifie avec une probabilité d'environ 1 %. Ce critère structurel remplace
avantageusement une liste de mots-clés « test / mock / exemple », qui dépendait
du bon vouloir de celui qui écrit le fichier et exemptait au passage tout un
répertoire __tests__.

Lit stdin (format `chemin:ligne:contenu`), écrit sur stdout les lignes retenues.
"""

import re
import sys

# IBAN de documentation français, présent dans à peu près toutes les specs.
# Sa clé est valide, mais il ne désigne aucun compte.
DOCUMENTATION = {"FR7630006000011234567890189"}

CANDIDAT = re.compile(r"[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}")


def cle_valide(iban: str) -> bool:
    """Contrôle mod-97 : les 4 premiers caractères passent à la fin, les
    lettres deviennent leur rang (A=10 ... Z=35), le tout modulo 97 doit
    valoir 1."""
    deplace = iban[4:] + iban[:4]
    try:
        numerique = "".join(
            str(int(c, 36)) if c.isalpha() else c for c in deplace
        )
    except ValueError:
        return False
    if not numerique.isdigit():
        return False
    return int(numerique) % 97 == 1


def main() -> int:
    for ligne in sys.stdin:
        trouves = [
            i for i in CANDIDAT.findall(ligne)
            if i not in DOCUMENTATION and cle_valide(i)
        ]
        if trouves:
            sys.stdout.write(ligne)
    return 0


if __name__ == "__main__":
    sys.exit(main())
