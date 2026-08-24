import { describe, it, expect } from "vitest";
import { classifyJugement, bodaccRecordsToSignals } from "../bodacc";

describe("classifyJugement", () => {
  it("détecte une ouverture de liquidation", () => {
    expect(classifyJugement({ nature: "Jugement d'ouverture d'une procédure de liquidation judiciaire" }))
      .toEqual({ kind: "liquidation" });
  });
  it("détecte un redressement", () => {
    expect(classifyJugement({ nature: "Jugement prononçant le redressement judiciaire" }))
      .toEqual({ kind: "redressement" });
  });
  it("détecte une sauvegarde", () => {
    expect(classifyJugement({ nature: "Ouverture d'une procédure de sauvegarde" }))
      .toEqual({ kind: "sauvegarde" });
  });
  it("ignore une clôture (fin de procédure, pas un événement négatif)", () => {
    expect(classifyJugement({ nature: "Jugement de clôture pour extinction du passif" })).toBeNull();
  });
  it("ignore un plan de continuation", () => {
    expect(classifyJugement({ nature: "Jugement arrêtant le plan de redressement" })).toBeNull();
  });
  it("ignore un jugement générique sans procédure", () => {
    expect(classifyJugement({ nature: "Autre jugement et ordonnance" })).toBeNull();
  });
});

describe("bodaccRecordsToSignals", () => {
  it("transforme une ouverture en signal procedure de confiance haute", () => {
    const records = [
      {
        registre: ["803214634"],
        jugement: JSON.stringify({
          nature: "Jugement d'ouverture d'une procédure de liquidation judiciaire",
          date: "2026-06-14",
          complementJugement: "Débiteur défaillant.",
        }),
        dateparution: "2026-06-20",
        tribunal: "Tribunal de commerce de Paris",
      },
    ];
    const sig = bodaccRecordsToSignals(records, "803214634");
    expect(sig).toHaveLength(1);
    expect(sig[0].type).toBe("procedure");
    expect(sig[0].procedureKind).toBe("liquidation");
    expect(sig[0].confidence).toBe("high");
    expect(sig[0].sourceUrl).toContain("803214634");
    expect(sig[0].date).toBe("2026-06-14");
  });

  it("ignore un jugement non exploitable / une clôture", () => {
    const records = [
      { registre: ["1"], jugement: "pas du json" },
      { registre: ["1"], jugement: JSON.stringify({ nature: "Jugement de clôture" }) },
    ];
    expect(bodaccRecordsToSignals(records, "1")).toHaveLength(0);
  });
});
