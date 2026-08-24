import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sum_ledger  # noqa: E402


class TestSumLedger(unittest.TestCase):
    def test_empty_ledger(self):
        self.assertEqual(sum_ledger.compute_totals([]), (0, 0))

    def test_prouve_and_approuve_and_refuse(self):
        decisions = [
            {"marchand": "A", "montant_annualise": 480, "statut": "prouve"},
            {"marchand": "B", "montant_annualise": 240, "statut": "approuve"},
            {"marchand": "C", "montant_annualise": 999, "statut": "refuse"},
        ]
        # prouvees = 480, en_attente = 240, refuse ignore
        self.assertEqual(sum_ledger.compute_totals(decisions), (480, 240))

    def test_statut_accents_and_case_insensitive(self):
        decisions = [
            {"montant_annualise": 100, "statut": "Prouve"},
            {"montant_annualise": 50, "statut": "APPROUVE"},
        ]
        self.assertEqual(sum_ledger.compute_totals(decisions), (100, 50))

    def test_missing_or_bad_amount_and_rounding(self):
        decisions = [
            {"statut": "prouve"},  # pas de montant -> 0
            {"montant_annualise": "abc", "statut": "prouve"},  # non numerique -> 0
            {"montant_annualise": 120.4, "statut": "prouve"},  # arrondi -> 120
        ]
        self.assertEqual(sum_ledger.compute_totals(decisions), (120, 0))

    def test_alt_amount_key(self):
        decisions = [{"montant_annuel_eur": 300, "statut": "prouve"}]
        self.assertEqual(sum_ledger.compute_totals(decisions), (300, 0))

    def test_check_detects_drift_then_fixes(self):
        ledger = {
            "decisions": [{"montant_annualise": 300, "statut": "prouve"}],
            "economies_prouvees_eur_an": 9999,  # faux : aurait ete gonfle a la main
            "economies_en_attente_eur_an": 0,
        }
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(ledger, handle)
            path = handle.name
        try:
            # --check detecte la derive
            self.assertEqual(sum_ledger.recompute(path, check=True), 1)
            # recompute reecrit
            self.assertEqual(sum_ledger.recompute(path, check=False), 0)
            # --check repasse a 0 (plus de derive)
            self.assertEqual(sum_ledger.recompute(path, check=True), 0)
            with open(path) as reader:
                fixed = json.load(reader)
            self.assertEqual(fixed["economies_prouvees_eur_an"], 300)
            self.assertEqual(fixed["economies_en_attente_eur_an"], 0)
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
