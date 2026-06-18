#!/usr/bin/env python3
"""
Tests du moteur engine.py — avec 'unittest' (livre d'origine avec Python).
Lancer :  python3 -m unittest discover -s tests

Regles verifiees :
  1. Detection d'abonnement recurrent (cadence mensuelle)
  2. Annualisation (mensuel x 12)
  3. One-off JAMAIS annualise
  4. Voyage / depense groupee sur quelques jours JAMAIS annualise (le vrai piege)
  5. Virement JAMAIS traite comme abonnement
  6. Doublon meme jour -> recuperation PONCTUELLE (pas x12)
  7. Deux abonnements paralleles -> consolidation
  8. Agregation des frais de change (FX)
  9. Classification PRO / PERSO / A-CLARIFIER
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import engine  # noqa: E402


def tx(name, amount, day, op="card", ref="", side="debit"):
    """Fausse transaction Qonto minimale. day = 'MM-JJ'. amount en euros."""
    return {
        "clean_counterparty_name": name,
        "label": name,
        "amount": amount,
        "amount_cents": None,
        "emitted_at": "2026-{}T10:00:00.000Z".format(day),
        "operation_type": op,
        "reference": ref,
        "side": side,
    }


def find(rows, marchand):
    for c in rows:
        if marchand.lower() in c["marchand"].lower():
            return c
    return None


class TestAbonnement(unittest.TestCase):
    def test_detecte_abonnement_mensuel(self):
        txs = [tx("HubSpot", 50, "04-05", op="direct_debit"),
               tx("HubSpot", 50, "05-05", op="direct_debit"),
               tx("HubSpot", 50, "06-05", op="direct_debit")]
        c = find(engine.analyze(txs)["abonnements"], "HubSpot")
        self.assertIsNotNone(c)
        self.assertEqual(c["cadence"], "mensuel")

    def test_annualisation_x12(self):
        txs = [tx("HubSpot", 50, "04-05", op="direct_debit"),
               tx("HubSpot", 50, "05-05", op="direct_debit"),
               tx("HubSpot", 50, "06-05", op="direct_debit")]
        c = find(engine.analyze(txs)["abonnements"], "HubSpot")
        self.assertEqual(c["montant_mensuel"], 50.0)
        self.assertEqual(c["montant_optimisable_eur"], 600.0)


class TestPasDAnnualisationAbusive(unittest.TestCase):
    def test_one_off_ignore(self):
        txs = [tx("Zara", 80, "05-10")]
        self.assertIsNone(find(engine.analyze(txs)["abonnements"], "Zara"))

    def test_voyage_jamais_annualise(self):
        # 3 debits carte sur 3 jours consecutifs = un seul sejour, pas un abonnement.
        txs = [tx("Sofitel", 332, "05-24"),
               tx("Sofitel", 377, "05-25"),
               tx("Sofitel", 40, "05-26")]
        res = engine.analyze(txs)
        self.assertIsNone(find(res["abonnements"], "Sofitel"),
                          "Un voyage ne doit JAMAIS etre annualise")

    def test_carte_deux_fois_pas_abonnement(self):
        # 2 paiements carte a ~1 mois d'ecart (ex: Western Union) : PAS un abonnement.
        txs = [tx("Western Union", 560, "05-03"),
               tx("Western Union", 631, "06-01")]
        self.assertIsNone(find(engine.analyze(txs)["abonnements"], "Western Union"))

    def test_virement_pas_abonnement(self):
        # Virements de facture (montants variables) : jamais un abonnement.
        txs = [tx("inkrea", 456, "04-06", op="transfer"),
               tx("inkrea", 912, "05-23", op="transfer"),
               tx("inkrea", 384, "06-23", op="transfer")]
        self.assertIsNone(find(engine.analyze(txs)["abonnements"], "inkrea"))


class TestDoublons(unittest.TestCase):
    def test_doublon_meme_jour_ponctuel(self):
        txs = [tx("Ringover", 39, "05-15"),
               tx("Ringover", 39, "05-15")]
        c = find(engine.analyze(txs)["doublons"], "Ringover")
        self.assertIsNotNone(c)
        self.assertEqual(c["nature"], "doublon")
        self.assertEqual(c["base"], "ponctuel — a verifier")
        # Recuperation = 1 fois le montant duplique, PAS x12.
        self.assertEqual(c["montant_optimisable_eur"], 39.0)

    def test_deux_abonnements_paralleles(self):
        txs = [tx("Google Workspace", 12, "04-03", op="direct_debit"),
               tx("Google Workspace", 12, "05-03", op="direct_debit"),
               tx("Google Workspace", 12, "06-03", op="direct_debit"),
               tx("Google Workspace", 6, "04-20", op="direct_debit"),
               tx("Google Workspace", 6, "05-20", op="direct_debit"),
               tx("Google Workspace", 6, "06-20", op="direct_debit")]
        goog = [c for c in engine.analyze(txs)["abonnements"]
                if "google" in c["marchand"].lower()]
        self.assertGreaterEqual(len(goog), 2)
        self.assertTrue(all(c["nature"] == "consolidation" for c in goog))


class TestFX(unittest.TestCase):
    def test_agregation_frais_change(self):
        txs = [tx("Frais", 5, "04-10", op="qonto_fee", ref="fx_card"),
               tx("Frais", 5, "05-10", op="qonto_fee", ref="fx_card")]
        c = engine.analyze(txs)["fx"][0]
        self.assertEqual(c["nature"], "fx")
        self.assertEqual(c["occurrences"], 2)
        self.assertAlmostEqual(c["montant_optimisable_eur"], 40.56, places=1)


class TestClassification(unittest.TestCase):
    def test_pro(self):
        self.assertEqual(engine.classify("hubspot"), "PRO")

    def test_perso(self):
        self.assertEqual(engine.classify("zara paris"), "PERSO")

    def test_a_clarifier(self):
        self.assertEqual(engine.classify("boucherie du coin"), "A-CLARIFIER")


class TestCredits(unittest.TestCase):
    def test_encaissements_ignores(self):
        txs = [tx("Client SAS", 1000, "05-01", op="income", side="credit"),
               tx("Client SAS", 1000, "06-01", op="income", side="credit")]
        res = engine.analyze(txs)
        self.assertIsNone(find(res["abonnements"], "Client SAS"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
