// ---------------------------------------------------------------------------
// Tests de l'allowlist read-only — la suite la plus importante du dépôt.
//
// Ce que ces tests protègent : le jeton OAuth porte des droits d'écriture
// (virements, cartes, factures) qu'on ne peut pas refuser côté serveur
// d'autorisation. Si un seul de ces tests casse, on doit considérer que le
// produit peut déplacer de l'argent. Il n'y a pas de « petit » échec ici.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CHEMINS_AUTORISES,
  METHODES_AUTORISEES,
  ReadOnlyViolationError,
  assertReadOnly,
  isAllowed,
} from "@/lib/mcp/readonly-guard";

/** Espion sur console.error : un refus DOIT être bruyant. */
function poserEspion() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}
let espionErreur: ReturnType<typeof poserEspion>;

beforeEach(() => {
  espionErreur = poserEspion();
});

afterEach(() => {
  espionErreur.mockRestore();
});

/** Raccourci : l'appel est-il refusé (exception + journal) ? */
function estRefuse(method: string, path: string): boolean {
  let refuse = false;
  try {
    assertReadOnly(method, path);
  } catch (e) {
    refuse = e instanceof ReadOnlyViolationError;
  }
  return refuse && !isAllowed(method, path);
}

describe("liste blanche — contenu figé", () => {
  // Ce test échoue dès qu'on touche à la liste. C'est le point de contrôle
  // humain : si vous êtes ici, c'est que vous élargissez la surface d'attaque.
  // Relisez le nouveau motif, prouvez qu'il est en lecture seule, puis mettez
  // à jour cette liste EN CONSCIENCE.
  it("contient exactement les motifs attendus, dans l'ordre", () => {
    expect([...CHEMINS_AUTORISES]).toEqual([
      "/organization",
      "/bank_accounts",
      "/transactions",
      "/transactions/:id",
      "/transactions/:id/attachments",
      "/attachments/:id",
      "/statements",
      "/statements/:id",
      "/cards",
      "/cards/:id",
      "/labels",
      "/labels/:id",
      "/memberships",
      "/memberships/:id",
      "/teams",
    ]);
  });

  it("n'autorise que GET et HEAD", () => {
    expect([...METHODES_AUTORISEES]).toEqual(["GET", "HEAD"]);
  });

  it("ne contient aucun motif évoquant une surface d'écriture ou de paiement", () => {
    const suspects = [
      "transfer",
      "beneficiar",
      "block",
      "invoice",
      "credit_note",
      "quote",
      "payment",
      "request",
      "direct_debit",
      "payout",
      "mandate",
      "client",
      "supplier",
    ];
    for (const motif of CHEMINS_AUTORISES) {
      for (const suspect of suspects) {
        expect(motif.includes(suspect), `${motif} contient « ${suspect} »`).toBe(false);
      }
    }
  });

  it("est gelée à l'exécution (Object.freeze)", () => {
    expect(Object.isFrozen(CHEMINS_AUTORISES)).toBe(true);
    expect(Object.isFrozen(METHODES_AUTORISEES)).toBe(true);
  });
});

describe("chemins autorisés", () => {
  const exemples = [
    "/organization",
    "/bank_accounts",
    "/transactions",
    "/transactions/7f3a9c1e-1234-4bcd-8ef0-0123456789ab",
    "/transactions/7f3a9c1e-1234-4bcd-8ef0-0123456789ab/attachments",
    "/attachments/aa11bb22",
    "/statements",
    "/statements/2026-07",
    "/cards",
    "/cards/card_123",
    "/labels",
    "/labels/lbl-1",
    "/memberships",
    "/memberships/mbr_9",
    "/teams",
  ];

  it.each(exemples)("accepte GET %s", (chemin) => {
    expect(isAllowed("GET", chemin)).toBe(true);
    expect(() => assertReadOnly("GET", chemin)).not.toThrow();
  });

  it.each(exemples)("accepte HEAD %s", (chemin) => {
    expect(isAllowed("HEAD", chemin)).toBe(true);
  });

  it("accepte la query string réelle produite par listTransactions", () => {
    const params = new URLSearchParams({
      sort_by: "settled_at:desc",
      per_page: "100",
      current_page: "1",
      settled_at_from: "2026-05-13T10:00:00.000Z",
      iban: "FR7616798000010000012345019",
    });
    expect(isAllowed("GET", `/transactions?${params.toString()}`)).toBe(true);
  });

  it("tolère la casse de la méthode mais jamais celle du chemin", () => {
    expect(isAllowed("get", "/transactions")).toBe(true);
    expect(isAllowed("Get", "/transactions")).toBe(true);
    expect(isAllowed(" GET ", "/transactions")).toBe(true);
    expect(isAllowed("GET", "/Transactions")).toBe(false);
    expect(isAllowed("GET", "/TRANSACTIONS")).toBe(false);
  });

  it("chaque motif de la liste blanche est réellement accepté", () => {
    for (const motif of CHEMINS_AUTORISES) {
      const concret = motif.replace(/:id/g, "abc-123");
      expect(isAllowed("GET", concret), `${motif} rejeté`).toBe(true);
    }
  });
});

describe("verrou (a) — méthodes d'écriture", () => {
  const methodesInterdites = [
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
    "TRACE",
    "CONNECT",
    "post",
    "Delete",
    "pAtCh",
  ];

  // Le chemin est POURTANT autorisé : c'est bien la méthode qui refuse.
  it.each(methodesInterdites)("refuse %s sur /transactions (chemin autorisé)", (m) => {
    expect(isAllowed(m, "/transactions")).toBe(false);
    expect(() => assertReadOnly(m, "/transactions")).toThrow(ReadOnlyViolationError);
  });

  it.each(methodesInterdites)("refuse %s sur /organization (chemin autorisé)", (m) => {
    expect(isAllowed(m, "/organization")).toBe(false);
  });

  it("refuse une méthode vide, absente ou non textuelle", () => {
    expect(isAllowed("", "/transactions")).toBe(false);
    expect(isAllowed("   ", "/transactions")).toBe(false);
    expect(isAllowed(undefined as unknown as string, "/transactions")).toBe(false);
    expect(isAllowed(null as unknown as string, "/transactions")).toBe(false);
    expect(isAllowed(42 as unknown as string, "/transactions")).toBe(false);
    expect(isAllowed({ toString: () => "GET" } as unknown as string, "/transactions")).toBe(
      false,
    );
  });

  it("refuse une méthode qui tente une injection d'en-tête", () => {
    expect(isAllowed("GET\r\nX-Injected: 1", "/transactions")).toBe(false);
    expect(isAllowed("GET /transfers HTTP/1.1", "/transactions")).toBe(false);
  });
});

describe("verrou (b) — chemins hors liste blanche, même en GET", () => {
  const cheminsRefuses: Array<[string, string]> = [
    ["virement sortant", "/transfers"],
    ["virement externe", "/external_transfers"],
    ["blocage de carte", "/cards/xxx/block"],
    ["facture client", "/client_invoices"],
    ["facture fournisseur", "/supplier_invoices"],
    ["administration", "/admin"],
    ["approbation de demande", "/requests"],
    ["bénéficiaires", "/beneficiaries"],
    ["chemin vide", ""],
    ["racine", "/"],
    ["barre finale", "/transactions/"],
    ["segment vide", "/transactions//1"],
    ["double barre initiale", "//transactions"],
    ["segment surnuméraire", "/organization/1"],
    ["sous-ressource inconnue", "/teams/1"],
    ["collection sans identifiant", "/attachments"],
    ["chemin arbitraire", "/quelque/chose/au/hasard"],
    ["chemin sans barre initiale", "transactions"],
    ["chemin numérique", "/1234"],
  ];

  it.each(cheminsRefuses)("refuse GET %s (%s)", (_nom, chemin) => {
    expect(isAllowed("GET", chemin)).toBe(false);
    expect(() => assertReadOnly("GET", chemin)).toThrow(ReadOnlyViolationError);
  });

  it("refuse un chemin non textuel ou absent", () => {
    expect(isAllowed("GET", undefined as unknown as string)).toBe(false);
    expect(isAllowed("GET", null as unknown as string)).toBe(false);
    expect(isAllowed("GET", 12 as unknown as string)).toBe(false);
    expect(isAllowed("GET", ["/transactions"] as unknown as string)).toBe(false);
  });

  it("refuse un chemin démesuré (garde-fou de longueur)", () => {
    const enorme = `/transactions/${"a".repeat(4000)}`;
    expect(isAllowed("GET", enorme)).toBe(false);
  });

  it("refuse un identifiant de plus de 128 caractères", () => {
    expect(isAllowed("GET", `/transactions/${"a".repeat(129)}`)).toBe(false);
    expect(isAllowed("GET", `/transactions/${"a".repeat(128)}`)).toBe(true);
  });
});

describe("résistance aux contournements", () => {
  const contournements: Array<[string, string]> = [
    ["traversée simple", "/transactions/../transfers"],
    ["traversée multiple", "/organization/../../transfers"],
    ["traversée depuis une sous-ressource", "/labels/1/../../transfers"],
    ["traversée encodée", "/transactions/..%2ftransfers"],
    ["traversée encodée majuscules", "/transactions/..%2Ftransfers"],
    ["point-point encodé", "/%2e%2e%2ftransfers"],
    ["double encodage", "/transactions/%252e%252e%252ftransfers"],
    ["casse mixte", "/TRANSFERS"],
    ["casse mixte partielle", "/Transfers"],
    ["chemin absolu https", "https://evil.test/x"],
    ["chemin absolu http", "http://evil.test/transactions"],
    ["chemin protocole-relatif", "//evil.test/x"],
    ["hôte injecté après un chemin valide", "/transactions@evil.test"],
    ["antislash windows", "\\transfers"],
    ["antislash mêlé", "/transactions\\..\\transfers"],
    ["octet nul", "/transactions%00"],
    // Octet nul construit à l'exécution : on évite un vrai octet de
    // contrôle dans le source, mais l'attaque testée est bien réelle.
    ["octet nul brut", `/transactions${String.fromCharCode(0)}/transfers`],
    ["retour chariot", "/transactions\r\n/transfers"],
    ["espace de tête", " /transactions"],
    ["espace de queue", "/transactions "],
    ["fragment", "/transactions#/../transfers"],
    ["point simple", "/transactions/."],
    ["point-point nu", "/.."],
    ["unicode homoglyphe", "/transactiоns"], // le « о » est cyrillique
    ["espace insécable", "/transactions "],
    ["tabulation", "/transactions\t/transfers"],
  ];

  it.each(contournements)("refuse %s : %j", (_nom, chemin) => {
    expect(isAllowed("GET", chemin)).toBe(false);
    expect(() => assertReadOnly("GET", chemin)).toThrow(ReadOnlyViolationError);
  });

  const queriesRefusees: Array<[string, string]> = [
    ["barre brute dans la query", "/transactions?next=/transfers"],
    ["barre encodée", "/transactions?next=%2Ftransfers"],
    ["barre doublement encodée", "/transactions?next=%252Ftransfers"],
    ["traversée dans la query", "/transactions?path=../transfers"],
    ["traversée encodée dans la query", "/transactions?path=%2e%2e%2ftransfers"],
    ["second point d'interrogation", "/transactions?a=b?c=/d"],
    ["fragment après query", "/transactions?a=b#/../transfers"],
    ["antislash dans la query", "/transactions?path=..\\transfers"],
    ["octet nul encodé dans la query", "/transactions?x=%00"],
    ["CRLF encodé dans la query", "/transactions?x=%0d%0aHost:+evil"],
    ["encodage pourcent malformé", "/transactions?x=%zz"],
    ["encodage pourcent tronqué", "/transactions?x=%2"],
    // Empilements PROFONDS : le décodeur ne fait que 3 passes. Au-delà, il doit
    // REFUSER, et surtout pas rendre la valeur encore masquée — sinon la barre
    // et le « .. » ressortent après coup sans que personne ne les ait vus.
    ["barre triplement encodée", "/transactions?next=%25252Ftransfers"],
    ["barre quadruplement encodée", "/transactions?next=%2525252Ftransfers"],
    ["barre quintuplement encodée", "/transactions?next=%252525252Ftransfers"],
    ["point-point quadruplement encodé", "/transactions?x=%2525252e%2525252e%2525252f"],
    ["point-point quintuplement encodé", "/transactions?x=%252525252e%252525252e%252525252f"],
    ["pourcent seul empilé quatre fois", "/transactions?x=%2525252f"],
    ["espace brut dans la query", "/transactions?x=a b"],
    ["chevron dans la query", "/transactions?x=<script>"],
    ["query sur un chemin non autorisé", "/transfers?iban=FR76"],
  ];

  it.each(queriesRefusees)("refuse %s : %j", (_nom, chemin) => {
    expect(isAllowed("GET", chemin)).toBe(false);
    expect(() => assertReadOnly("GET", chemin)).toThrow(ReadOnlyViolationError);
  });

  it("refuse toute combinaison méthode d'écriture × contournement", () => {
    for (const methode of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const [, chemin] of contournements) {
        expect(isAllowed(methode, chemin), `${methode} ${chemin}`).toBe(false);
      }
    }
  });
});

describe("comportement du refus", () => {
  it("lève une ReadOnlyViolationError nommant la méthode et le chemin", () => {
    let capturee: unknown;
    try {
      assertReadOnly("DELETE", "/transactions/42");
    } catch (e) {
      capturee = e;
    }

    expect(capturee).toBeInstanceOf(ReadOnlyViolationError);
    const erreur = capturee as ReadOnlyViolationError;
    expect(erreur.name).toBe("ReadOnlyViolationError");
    expect(erreur.method).toBe("DELETE");
    expect(erreur.path).toBe("/transactions/42");
    expect(erreur.message).toContain("DELETE");
    expect(erreur.message).toContain("/transactions/42");
    // Message en français (règle de code du dépôt).
    expect(erreur.message).toContain("Violation lecture seule Qonto");
    expect(erreur.raison).toContain("interdite");
  });

  it("journalise le refus en console.error (refus bruyant)", () => {
    expect(() => assertReadOnly("POST", "/transfers")).toThrow();
    expect(espionErreur).toHaveBeenCalledTimes(1);
    const message = String(espionErreur.mock.calls[0]?.[0]);
    expect(message).toContain("[argentier][read-only]");
    expect(message).toContain("REFUS");
    expect(message).toContain("POST");
    expect(message).toContain("/transfers");
  });

  it("ne journalise rien quand l'appel est autorisé", () => {
    assertReadOnly("GET", "/transactions");
    expect(espionErreur).not.toHaveBeenCalled();
  });

  it("isAllowed est pure : aucun effet de bord, aucun journal", () => {
    expect(isAllowed("POST", "/transfers")).toBe(false);
    expect(isAllowed("GET", "/transactions")).toBe(true);
    expect(espionErreur).not.toHaveBeenCalled();
  });

  it("isAllowed et assertReadOnly sont toujours d'accord", () => {
    const echantillons: Array<[string, string]> = [
      ["GET", "/transactions"],
      ["HEAD", "/organization"],
      ["POST", "/transactions"],
      ["GET", "/transfers"],
      ["GET", "/transactions/../transfers"],
      ["DELETE", "/cards/1"],
      ["GET", "/cards/1"],
    ];
    for (const [methode, chemin] of echantillons) {
      const autorise = isAllowed(methode, chemin);
      let aLeve = false;
      try {
        assertReadOnly(methode, chemin);
      } catch {
        aLeve = true;
      }
      expect(aLeve, `${methode} ${chemin}`).toBe(!autorise);
    }
  });

  it("le helper estRefuse confirme la cohérence sur les cas d'écriture", () => {
    expect(estRefuse("POST", "/transactions")).toBe(true);
    expect(estRefuse("GET", "/transfers")).toBe(true);
  });
});
