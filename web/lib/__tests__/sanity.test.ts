// ---------------------------------------------------------------------------
// Test sentinelle du harnais de tests.
// Rôle : prouver que Vitest tourne et que l'alias "@/" résout vers la racine de
// `web/`. Si ce fichier échoue, aucun autre test du paquet n'est fiable —
// c'est la config qui est cassée, pas le code métier.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

// Résolution de l'alias côté TypeScript : "@/lib/types" doit être typé.
import type { Lang, Nature } from "@/lib/types";

describe("harnais de tests", () => {
  it("exécute bien les tests", () => {
    expect(1 + 1).toBe(2);
  });

  it("résout l'alias \"@/\" à la compilation (types)", () => {
    // `lib/types.ts` n'exporte que des types : on les exerce ici, ce qui
    // échouerait au typecheck si l'alias n'était pas résolu.
    const langue: Lang = "fr";
    const nature: Nature = "pilotable";

    expect(langue).toBe("fr");
    expect(nature).toBe("pilotable");
  });

  it("résout l'alias \"@/\" à l'exécution (résolveur Vite)", async () => {
    // Import dynamique : contrairement à `import type`, il n'est PAS effacé par
    // le transpileur, donc le résolveur de Vitest doit vraiment trouver le
    // fichier. C'est la preuve qu'un "@/lib/..." fonctionne dans un test.
    const moduleTypes = await import("@/lib/types");

    expect(moduleTypes).toBeDefined();
  });
});
