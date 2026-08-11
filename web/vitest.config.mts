// ---------------------------------------------------------------------------
// Configuration Vitest du paquet web.
// Rôle : faire tourner les tests unitaires des modules `lib/` (moteur, auth,
// allowlist read-only, privacy…) hors de Next.js, en environnement Node.
//
// Deux points non négociables :
//  1. L'alias "@/" doit résoudre vers la racine de `web/`, exactement comme le
//     `paths` du tsconfig.json — le code source importe via "@/lib/...".
//  2. Les artefacts de build (.next, .open-next, .vercel) sont exclus : ils
//     contiennent des copies compilées qui feraient tourner des tests fantômes.
// ---------------------------------------------------------------------------

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** Racine du paquet `web/` — la cible de l'alias "@/". */
const racine = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": racine,
    },
  },
  test: {
    environment: "node",
    include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: [
      "**/node_modules/**",
      "**/.next/**",
      "**/.open-next/**",
      "**/.vercel/**",
    ],
  },
});
