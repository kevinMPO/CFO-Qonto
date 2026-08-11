// ---------------------------------------------------------------------------
// Tests du jeu de démonstration (`lib/mock.ts`).
//
// Ce jeu est servi par /api/analyze SANS authentification : il est public. Deux
// familles de garde-fous, également non négociables :
//
//  1. ANONYMAT — aucune donnée d'un compte bancaire réel. Le fondateur avait sa
//     raison sociale, son solde et sa ligne « perso » en ligne : plus jamais.
//     Le test échoue sur toute réapparition de l'identité réelle.
//  2. JUSTESSE — Argentier vend la rigueur des chiffres. Une démo dont le total
//     ne tombe pas juste détruit l'argument de vente, et la cascade
//     `NatureWaterfall` (app/Argentier.tsx) afficherait une barre fausse. Les
//     invariants ci-dessous sont ceux que `lib/engine.ts` produit sur de vraies
//     données ; le mock doit s'y tenir.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { MOCK } from "@/lib/mock";
import type { Nature } from "@/lib/types";

/** Identité réelle du fondateur — interdite de séjour dans le code servi. */
const IDENTITES_INTERDITES = [/mamforma/i];

/** Montant d'une nature, par clé. */
function nature(cle: Nature): number {
  const trouvee = MOCK.natures.find((n) => n.key === cle);
  expect(trouvee, `nature ${cle} absente du jeu de démo`).toBeDefined();
  return trouvee!.amount;
}

describe("anonymat du jeu de démo public", () => {
  it("ne porte AUCUNE identité réelle dans le compte affiché", () => {
    for (const interdite of IDENTITES_INTERDITES) {
      expect(MOCK.account.name, `identité réelle exposée : ${interdite}`).not.toMatch(
        interdite,
      );
    }
  });

  it("ne porte AUCUNE identité réelle nulle part dans le module", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../mock.ts", import.meta.url)),
      "utf8",
    );

    for (const interdite of IDENTITES_INTERDITES) {
      expect(source, `identité réelle dans lib/mock.ts : ${interdite}`).not.toMatch(
        interdite,
      );
    }
  });

  it("annonce une source « mock » : le front sait qu'il montre une démo", () => {
    expect(MOCK.meta?.source).toBe("mock");
  });

  it("garde un nom de compte non vide (l'anonymat n'est pas l'absence)", () => {
    expect(MOCK.account.name.trim().length).toBeGreaterThan(0);
    expect(MOCK.account.bank).toBe("Qonto");
  });
});

describe("justesse arithmétique du jeu de démo", () => {
  it("totals.out = somme des natures (la cascade doit tomber juste)", () => {
    const somme = MOCK.natures.reduce((s, n) => s + n.amount, 0);

    expect(MOCK.totals.out).toBe(somme);
  });

  it("la cascade du relevé au pilotable retombe exactement sur le pilotable", () => {
    // Reproduit `NatureWaterfall` : out − perso − ponctuel − structurel.
    const reste =
      MOCK.totals.out - nature("perso") - nature("ponctuel") - nature("structurel");

    expect(reste).toBe(nature("pilotable"));
  });

  it("totals.runRate = nature pilotable", () => {
    expect(MOCK.totals.runRate).toBe(nature("pilotable"));
  });

  it("somme des pôles = run-rate (les pôles découpent le pilotable)", () => {
    const somme = MOCK.poles.reduce((s, p) => s + p.amount, 0);

    expect(somme).toBe(MOCK.totals.runRate);
  });

  it("les pôles sont triés par montant décroissant, comme le fait le moteur", () => {
    const montants = MOCK.poles.map((p) => p.amount);

    expect(montants).toEqual([...montants].sort((a, b) => b - a));
  });

  it("TVA récupérable = base TTC × 20/120", () => {
    expect(MOCK.tvaPerdue).toBeDefined();
    const { baseTtcEur, tvaRecuperableEur } = MOCK.tvaPerdue!;

    expect(tvaRecuperableEur).toBe(Math.round(((baseTtcEur * 20) / 120) * 100) / 100);
  });

  it("le score annoncé = 100 − les pénalités qu'il énumère", () => {
    const penalites = MOCK.score.drivers.reduce((s, d) => {
      const trouve = /−(\d+)/.exec(d.fr);
      return s + (trouve ? Number(trouve[1]) : 0);
    }, 0);

    expect(MOCK.score.value).toBe(100 - penalites);
  });

  it("les économies affichées restent sous le run-rate qu'elles optimisent", () => {
    const actives = MOCK.levers
      .filter((l) => l.active)
      .reduce((s, l) => s + l.saving, 0);

    expect(actives).toBeGreaterThan(0);
    expect(actives).toBeLessThan(MOCK.totals.runRate);
  });

  it("un levier de hausse annonce le bon pourcentage et la bonne économie", () => {
    for (const levier of MOCK.levers) {
      if (!levier.hausse) continue;
      const { pct, avantEur, apresEur } = levier.hausse;

      // Même formule que `detectHausse` dans lib/engine.ts.
      expect(pct, levier.label).toBe(
        Math.round((apresEur / avantEur - 1) * 1000) / 10,
      );
      expect(levier.saving, levier.label).toBe(Math.round(apresEur - avantEur));
      if (levier.monthly !== undefined) {
        expect(levier.saving, levier.label).toBeLessThanOrEqual(levier.monthly);
      }
    }
  });

  it("tous les montants sont des nombres finis et positifs", () => {
    const montants = [
      MOCK.account.balance,
      MOCK.totals.out,
      MOCK.totals.runRate,
      MOCK.runway.months,
      ...MOCK.natures.map((n) => n.amount),
      ...MOCK.poles.map((p) => p.amount),
      ...MOCK.levers.map((l) => l.saving),
    ];

    for (const montant of montants) {
      expect(Number.isFinite(montant)).toBe(true);
      expect(montant).toBeGreaterThan(0);
    }
  });
});
