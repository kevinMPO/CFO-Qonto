// ---------------------------------------------------------------------------
// Tests du filtre de sortie anti-PII (règle 3 : « zéro PII vers le web »).
//
// Ce module est une frontière de sécurité : ses tests doivent échouer
// BRUYAMMENT. On teste donc trois choses avec la même exigence :
//   • les vrais positifs (une PII ne doit jamais passer) ;
//   • les faux positifs (un nom de marchand légitime ne doit jamais être
//     confondu avec une PII, sinon le benchmark casse en production) ;
//   • la non-fuite (un message d'erreur ou un log ne recopie jamais la valeur).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import {
  MAX_LONGUEUR_MARCHAND,
  PROFONDEUR_MAX,
  PiiDetectedError,
  assertNoPii,
  estCleSensible,
  redactForLogs,
  sanitizeMerchantQuery,
  scanForPii,
  type PiiFinding,
  type PiiType,
} from "@/lib/privacy/egress";

/** IBAN d'exemple public (BNP), clé modulo 97 valide. Aucune donnée réelle. */
const IBAN_COMPACT = "FR7630006000011234567890189";
const IBAN_ESPACES = "FR76 3000 6000 0112 3456 7890 189";
const UUID_V4 = "550e8400-e29b-41d4-a716-446655440000";

/** Raccourci de lecture : la liste des types signalés. */
const types = (findings: PiiFinding[]): PiiType[] => findings.map((f) => f.type);

describe("scanForPii — vrais positifs", () => {
  it("détecte un IBAN compact", () => {
    expect(scanForPii(IBAN_COMPACT)).toEqual([
      { path: "$", type: "IBAN", origin: "value" },
    ]);
  });

  it("détecte un IBAN groupé par 4 (espaces)", () => {
    expect(types(scanForPii(IBAN_ESPACES))).toContain("IBAN");
  });

  it("détecte un IBAN en minuscules", () => {
    expect(types(scanForPii(IBAN_COMPACT.toLowerCase()))).toContain("IBAN");
  });

  it("détecte un IBAN espacé noyé dans une phrase", () => {
    const findings = scanForPii(`Virement reçu sur ${IBAN_ESPACES} chez BNP Paribas`);
    expect(types(findings)).toContain("IBAN");
  });

  it("détecte un IBAN imbriqué à trois niveaux", () => {
    const charge = { niveau1: { niveau2: { niveau3: { note: IBAN_COMPACT } } } };
    expect(scanForPii(charge)).toEqual([
      { path: "$.niveau1.niveau2.niveau3.note", type: "IBAN", origin: "value" },
    ]);
  });

  it("détecte un IBAN dans un élément de tableau", () => {
    const charge = { refs: ["Notion", IBAN_ESPACES, "Slack"] };
    expect(scanForPii(charge)).toEqual([
      { path: "$.refs[1]", type: "IBAN", origin: "value" },
    ]);
  });

  it("détecte un UUID v4 (les transaction_id Qonto en sont)", () => {
    expect(scanForPii(UUID_V4)).toEqual([{ path: "$", type: "UUID", origin: "value" }]);
  });

  it("détecte une adresse e-mail", () => {
    const findings = scanForPii({ note: "écrire à kevin.mameri+qonto@example.com stp" });
    expect(findings).toEqual([{ path: "$.note", type: "EMAIL", origin: "value" }]);
  });

  it("détecte un numéro de carte valide au sens de Luhn, groupé ou non", () => {
    expect(types(scanForPii("4242 4242 4242 4242"))).toEqual(["PAN"]);
    expect(types(scanForPii("4111111111111111"))).toEqual(["PAN"]);
  });

  it("détecte un téléphone français dans ses formats courants", () => {
    const numeros = [
      "+33 6 12 34 56 78",
      "0612345678",
      "06 12 34 56 78",
      "06.12.34.56.78",
      "+33612345678",
      "+33 (0)6 12 34 56 78",
      "0033 6 12.34 56 78", // séparateurs panachés, rattrapés par l'indicatif
      "0148000000", // ligne fixe
    ];
    for (const numero of numeros) {
      expect(types(scanForPii(numero))).toContain("TELEPHONE_FR");
    }
  });

  it("détecte un BIC isolé ou annoncé", () => {
    expect(types(scanForPii("BNPAFRPPXXX"))).toContain("BIC");
    expect(types(scanForPii("BIC : BNPAFRPP"))).toContain("BIC");
  });

  it("signale un cycle plutôt que de boucler (échec fermé)", () => {
    const charge: Record<string, unknown> = { marchand: "Notion" };
    charge.soi = charge;
    expect(types(scanForPii(charge))).toContain("INSPECTION_INCOMPLETE");
  });

  it("signale une structure trop profonde plutôt que de la laisser passer", () => {
    let noeud: Record<string, unknown> = { note: IBAN_COMPACT };
    for (let i = 0; i < PROFONDEUR_MAX + 8; i++) noeud = { sous: noeud };
    expect(types(scanForPii(noeud))).toContain("INSPECTION_INCOMPLETE");
    expect(() => assertNoPii(noeud, "test profondeur")).toThrow(PiiDetectedError);
  });

  it("inspecte deux fois un même sous-objet partagé (ce n'est pas un cycle)", () => {
    const partage = { note: IBAN_COMPACT };
    const findings = scanForPii({ a: partage, b: partage });
    expect(findings.map((f) => f.path).sort()).toEqual(["$.a.note", "$.b.note"]);
    expect(types(findings)).not.toContain("INSPECTION_INCOMPLETE");
  });
});

describe("scanForPii — clés sensibles par leur nom", () => {
  it("signale les clés sensibles même quand la valeur est anodine", () => {
    const charge = {
      login: "ok",
      transaction_id: "abc",
      account_id: 1,
      secret_key: "x",
      authorization: "y",
      access_token: "z",
      refresh_token: "z",
      attachment_ids: [],
      iban: "",
    };

    const findings = scanForPii(charge);
    const clesSignalees = findings
      .filter((f) => f.type === "CLE_SENSIBLE")
      .map((f) => f.path)
      .sort();

    expect(clesSignalees).toEqual(
      [
        "$.access_token",
        "$.account_id",
        "$.attachment_ids",
        "$.authorization",
        "$.iban",
        "$.login",
        "$.refresh_token",
        "$.secret_key",
        "$.transaction_id",
      ].sort(),
    );
  });

  it("reconnaît les variantes d'écriture d'une même clé", () => {
    for (const cle of ["transactionId", "TRANSACTION_ID", "transaction-id", "accessToken"]) {
      expect(estCleSensible(cle)).toBe(true);
    }
  });

  it("ne considère pas comme sensibles les clés que l'on a le droit d'envoyer", () => {
    for (const cle of ["merchant", "category", "name", "amount", "date", "unit", "paid"]) {
      expect(estCleSensible(cle)).toBe(false);
    }
  });
});

describe("scanForPii — faux positifs (ce qui doit passer)", () => {
  const valeursSaines: unknown[] = [
    "Notion Labs, Inc.",
    "Google Workspace",
    "OVHcloud SAS",
    "Qonto Business",
    "BUSINESS",
    "2026-08-11",
    "2026-08-11T09:30:00Z",
    "1 234,56 €",
    1234.56,
    -89.9,
    "saas_tools",
    "IA & Dev",
    "12,90 €/utilisateur/mois",
    "1234567890123456", // 16 chiffres, mais échoue au test de Luhn
    "2026-08-11 2026-08-12", // suites de chiffres mal groupées : pas une carte
    "https://www.notion.com/pricing",
  ];

  for (const valeur of valeursSaines) {
    it(`ne signale rien pour ${JSON.stringify(valeur)}`, () => {
      expect(scanForPii(valeur)).toEqual([]);
    });
  }

  it("ne signale rien sur la charge utile autorisée", () => {
    expect(scanForPii({ merchant: "Notion Labs, Inc.", category: "IA & Dev" })).toEqual([]);
  });

  it("ne prend pas une chaîne de 16 chiffres non-Luhn pour une carte", () => {
    expect(types(scanForPii({ reference: "1234567890123456" }))).not.toContain("PAN");
  });
});

describe("assertNoPii", () => {
  it("laisse passer une charge utile propre", () => {
    expect(() =>
      assertNoPii({ merchant: "Notion Labs, Inc.", category: "IA & Dev" }, "benchmark Linkup"),
    ).not.toThrow();
  });

  it("lève une PiiDetectedError en nommant le contexte et le type", () => {
    let erreur: unknown;
    try {
      assertNoPii({ compte: { note: IBAN_COMPACT } }, "benchmark Linkup");
    } catch (e) {
      erreur = e;
    }

    expect(erreur).toBeInstanceOf(PiiDetectedError);
    const message = (erreur as Error).message;
    expect(message).toContain("benchmark Linkup");
    expect(message).toContain("IBAN");
    expect(message).toContain("$.compte.note");
  });

  it("ne fuite JAMAIS la valeur détectée dans son message", () => {
    const charge = {
      compte: { note: IBAN_ESPACES },
      contact: "kevin@example.com",
      id: UUID_V4,
      carte: "4242 4242 4242 4242",
    };

    let message = "";
    try {
      assertNoPii(charge, "appel sortant");
    } catch (e) {
      message = (e as Error).message;
    }

    expect(message).not.toBe("");
    for (const secret of [
      IBAN_ESPACES,
      IBAN_COMPACT,
      "3000600001", // fragment d'IBAN
      "kevin@example.com",
      UUID_V4,
      "4242 4242 4242 4242",
      "4242424242424242",
    ]) {
      expect(message).not.toContain(secret);
    }
  });

  it("ne fuite pas non plus une PII portée par un NOM de clé", () => {
    let message = "";
    try {
      assertNoPii({ [IBAN_COMPACT]: "montant" }, "appel sortant");
    } catch (e) {
      message = (e as Error).message;
    }

    expect(message).toContain("IBAN");
    expect(message).not.toContain(IBAN_COMPACT);
  });

  it("porte les signalements sur l'erreur, sans les valeurs", () => {
    try {
      assertNoPii({ note: UUID_V4 }, "appel sortant");
      throw new Error("aurait dû lever");
    } catch (e) {
      expect(e).toBeInstanceOf(PiiDetectedError);
      const findings = (e as PiiDetectedError).findings;
      expect(findings).toEqual([{ path: "$.note", type: "UUID", origin: "value" }]);
      expect(JSON.stringify(findings)).not.toContain(UUID_V4);
    }
  });
});

describe("redactForLogs", () => {
  const charge = {
    marchand: "Notion Labs, Inc.",
    montant: 129.9,
    compte: { titulaire: "note interne", note: `virement vers ${IBAN_ESPACES}` },
    contacts: ["support@notion.com", "0612345678"],
    transaction_id: UUID_V4,
    horodatage: "2026-08-11T09:30:00Z",
  };

  it("préserve la structure", () => {
    const caviarde = redactForLogs(charge) as Record<string, unknown>;

    expect(Object.keys(caviarde).sort()).toEqual(Object.keys(charge).sort());
    expect(Array.isArray(caviarde.contacts)).toBe(true);
    expect((caviarde.contacts as unknown[]).length).toBe(2);
    expect(caviarde.marchand).toBe("Notion Labs, Inc.");
    expect(caviarde.montant).toBe(129.9);
    expect(caviarde.horodatage).toBe("2026-08-11T09:30:00Z");
    expect((caviarde.compte as Record<string, unknown>).titulaire).toBe("note interne");
  });

  it("remplace chaque PII par un marqueur typé", () => {
    const caviarde = redactForLogs(charge) as Record<string, unknown>;
    const compte = caviarde.compte as Record<string, unknown>;
    const contacts = caviarde.contacts as string[];

    expect(compte.note).toBe("virement vers [IBAN]");
    expect(contacts[0]).toBe("[EMAIL]");
    expect(contacts[1]).toBe("[TELEPHONE_FR]");
    expect(caviarde.transaction_id).toBe("[MASQUÉ]");
  });

  it("ne laisse aucune PII derrière lui", () => {
    const caviarde = redactForLogs(charge);
    const serialise = JSON.stringify(caviarde);

    for (const secret of [IBAN_ESPACES, IBAN_COMPACT, UUID_V4, "support@notion.com", "0612345678"]) {
      expect(serialise).not.toContain(secret);
    }
    // Après caviardage, plus aucun signalement portant sur une VALEUR : seuls
    // les noms de clés sensibles subsistent, volontairement (c'est la structure).
    expect(scanForPii(caviarde).filter((f) => f.origin === "value")).toEqual([]);
  });

  it("caviarde aussi les noms de clés qui contiennent une PII", () => {
    const caviarde = redactForLogs({ [IBAN_COMPACT]: 12 }) as Record<string, unknown>;
    expect(Object.keys(caviarde)).toEqual(["[IBAN]"]);
  });

  it("ne modifie pas la valeur d'origine (copie profonde)", () => {
    const original = { compte: { note: IBAN_COMPACT } };
    redactForLogs(original);
    expect(original.compte.note).toBe(IBAN_COMPACT);
  });

  it("ne boucle pas sur une référence circulaire", () => {
    const cyclique: Record<string, unknown> = { marchand: "Notion" };
    cyclique.soi = cyclique;
    const caviarde = redactForLogs(cyclique) as Record<string, unknown>;
    expect(caviarde.marchand).toBe("Notion");
    expect(caviarde.soi).toBe("[CYCLE]");
  });
});

describe("le cas réel : une transaction Qonto ne sort jamais telle quelle", () => {
  /** Forme représentative d'une transaction Qonto. Valeurs inventées. */
  const transaction = {
    transaction_id: UUID_V4,
    amount: 129.9,
    currency: "EUR",
    settled_at: "2026-08-11T09:30:00Z",
    label: "NOTION LABS INC",
    clean_counterparty_name: "Notion Labs, Inc.",
    counterparty_iban: IBAN_COMPACT,
    attachment_ids: [UUID_V4],
    initiator: { email: "kevin@example.com", phone: "+33 6 12 34 56 78" },
  };

  it("refuse la transaction brute en sortie", () => {
    expect(() => assertNoPii(transaction, "benchmark Linkup")).toThrow(PiiDetectedError);
  });

  it("laisse passer la charge utile réduite au marchand et à la catégorie", () => {
    const requete = sanitizeMerchantQuery(transaction.clean_counterparty_name, "IA & Dev");
    expect(requete).toEqual({ merchant: "Notion Labs, Inc.", category: "IA & Dev" });
    expect(() => assertNoPii(requete, "benchmark Linkup")).not.toThrow();
  });

  it("journalise la transaction sans en fuiter une seule PII", () => {
    const serialise = JSON.stringify(redactForLogs(transaction));
    for (const secret of [UUID_V4, IBAN_COMPACT, "kevin@example.com", "+33 6 12 34 56 78"]) {
      expect(serialise).not.toContain(secret);
    }
    expect(serialise).toContain("Notion Labs, Inc."); // le marchand reste lisible
    expect(serialise).toContain("2026-08-11T09:30:00Z"); // la date aussi
  });

  it("inspecte aussi les Map et les Set", () => {
    expect(types(scanForPii(new Map([["note", IBAN_COMPACT]])))).toContain("IBAN");
    expect(types(scanForPii(new Map([["iban", "anodin"]])))).toContain("CLE_SENSIBLE");
    expect(types(scanForPii(new Set([UUID_V4])))).toContain("UUID");
  });
});

describe("sanitizeMerchantQuery", () => {
  it("ne laisse sortir que le marchand et la catégorie", () => {
    const requete = sanitizeMerchantQuery("Notion Labs, Inc.", "IA & Dev");
    expect(Object.keys(requete)).toEqual(["merchant", "category"]);
    expect(requete).toEqual({ merchant: "Notion Labs, Inc.", category: "IA & Dev" });
    expect(Object.isFrozen(requete)).toBe(true);
  });

  it("préserve un nom de marchand normal", () => {
    for (const nom of ["Notion Labs, Inc.", "OVHcloud SAS", "Google Workspace", "1Password"]) {
      expect(sanitizeMerchantQuery(nom, "saas").merchant).toBe(nom);
    }
  });

  it("retire les identifiants collés au libellé", () => {
    expect(sanitizeMerchantQuery("AWS 4242424242424242", "infra").merchant).toBe("AWS");
    expect(sanitizeMerchantQuery("OVH ref 123456789", "infra").merchant).toBe("OVH ref");
    expect(sanitizeMerchantQuery(`Virement ${IBAN_ESPACES}`, "banque").merchant).toBe("Virement");
    expect(sanitizeMerchantQuery(`Stripe ${UUID_V4}`, "paiement").merchant).toBe("Stripe");
  });

  it("aplatit les retours à la ligne et les espaces multiples", () => {
    expect(sanitizeMerchantQuery("Notion\n\tLabs,   Inc.", "saas").merchant).toBe(
      "Notion Labs, Inc.",
    );
  });

  it("tronque un libellé trop long sur une frontière de mot", () => {
    const long =
      "Compagnie Generale des Services Numeriques et Cloud Europeens Reunis Associes";
    const { merchant } = sanitizeMerchantQuery(long, "infra");
    expect(merchant.length).toBeLessThanOrEqual(MAX_LONGUEUR_MARCHAND);
    expect(long.startsWith(merchant)).toBe(true);
    expect(merchant.endsWith(" ")).toBe(false);
  });

  it("tronque aussi la catégorie et tolère une catégorie absente", () => {
    expect(sanitizeMerchantQuery("Notion", undefined).category).toBe("");
    expect(sanitizeMerchantQuery("Notion", { code: "saas" }).category).toBe("");
    expect(sanitizeMerchantQuery("Notion", "x".repeat(200)).category.length).toBeLessThanOrEqual(48);
  });

  it("refuse d'appeler un tiers s'il ne reste qu'un identifiant", () => {
    expect(() => sanitizeMerchantQuery(IBAN_COMPACT, "banque")).toThrow(/rien n'est envoyé/i);
    expect(() => sanitizeMerchantQuery(UUID_V4, "banque")).toThrow(/vide après nettoyage/i);
    expect(() => sanitizeMerchantQuery("   ", "banque")).toThrow(Error);
  });

  it("refuse une entrée qui n'est pas une chaîne", () => {
    expect(() => sanitizeMerchantQuery(42 as unknown as string)).toThrow(TypeError);
    expect(() => sanitizeMerchantQuery(null as unknown as string)).toThrow(TypeError);
  });

  it("produit toujours une sortie que le scanner juge propre", () => {
    const entrees: Array<[string, string]> = [
      ["Notion Labs, Inc.", "IA & Dev"],
      ["Virement SEPA Notion", "saas"],
      ["Uber Eats Paris", "repas"],
      ["SNCF Connect", "voyage"],
    ];

    for (const [marchand, categorie] of entrees) {
      const requete = sanitizeMerchantQuery(marchand, categorie);
      expect(scanForPii(requete)).toEqual([]);
    }
  });
});
