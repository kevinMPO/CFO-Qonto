// ---------------------------------------------------------------------------
// Invariant de dépôt : le front ne doit JAMAIS confondre un refus HTTP avec une
// analyse.
//
// Le bug que ce test interdit était réel et il a été observé en conditions
// réelles. `Argentier.tsx` faisait :
//
//     fetch("/api/analyze").then((r) => r.json()).then(setData)
//
// sans regarder `r.ok`. Sur un 401 « reconnecte ton compte », le corps d'erreur
// était parsé comme une analyse, l'écran retombait silencieusement sur MOCK, et
// l'utilisateur lisait des montants FICTIFS en croyant qu'ils étaient les
// siens — avec l'URL affichant `?qonto=connecte`.
//
// Sur un produit dont l'argument est la justesse des chiffres, c'est le défaut
// le plus grave possible : il ne casse rien, il ment.
//
// Le test est STATIQUE (il lit la source) plutôt que monté dans un DOM :
// l'écran fait ~2000 lignes et son rendu complet exigerait jsdom et une
// bibliothèque de test supplémentaire. Ce qu'on veut garantir tient en une
// propriété du code, pas du rendu.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const RACINE = fileURLToPath(new URL("../..", import.meta.url));

function source(chemin: string): string {
  return readFileSync(`${RACINE}/${chemin}`, "utf8");
}

/** Écrans qui consomment /api/analyze et doivent donc traiter les refus. */
const ECRANS = ["app/Argentier.tsx"];

describe("invariant de dépôt : un refus HTTP n'est pas une analyse", () => {
  it("trouve bien l'appel à /api/analyze (sinon le test ne garde rien)", () => {
    // Témoin : si l'appel est renommé ou déplacé, ce test doit tomber plutôt
    // que de passer au vert en ne vérifiant plus rien.
    for (const ecran of ECRANS) {
      expect(source(ecran), `${ecran} n'appelle plus /api/analyze`).toContain(
        'fetch("/api/analyze")',
      );
    }
  });

  it("vérifie le statut de la réponse avant de l'interpréter", () => {
    for (const ecran of ECRANS) {
      const code = source(ecran);
      const depart = code.indexOf('fetch("/api/analyze")');
      // La chaîne de promesses qui suit l'appel. 1200 caractères couvrent
      // largement le `.then()` de traitement sans mordre sur le reste.
      const chaine = code.slice(depart, depart + 1200);

      expect(
        /\br\.ok\b|\bres\.ok\b|\bresponse\.ok\b|\.status\b/.test(chaine),
        `${ecran} interprète la réponse de /api/analyze sans regarder son ` +
          `statut HTTP : un 401 serait parsé comme une analyse et l'écran ` +
          `afficherait des montants de démonstration en les faisant passer ` +
          `pour ceux du client.`,
      ).toBe(true);
    }
  });

  it("ne conserve aucun `.then((r) => r.json())` nu sur cet appel", () => {
    for (const ecran of ECRANS) {
      const code = source(ecran);
      const depart = code.indexOf('fetch("/api/analyze")');
      const chaine = code.slice(depart, depart + 400).replace(/\s+/g, " ");

      // Le motif exact du bug d'origine.
      expect(
        /\.then\(\s*\(\s*r\s*\)\s*=>\s*r\.json\(\)\s*\)/.test(chaine),
        `${ecran} est revenu au motif fautif « .then((r) => r.json()) », qui ` +
          `avale les refus HTTP.`,
      ).toBe(false);
    }
  });

  it("prévoit un état de refus distinct des données", () => {
    for (const ecran of ECRANS) {
      const code = source(ecran);
      expect(
        /refusApi|setRefus|erreurApi/.test(code),
        `${ecran} n'expose aucun état de refus : un échec ne peut donc pas ` +
          `être signalé à l'utilisateur, il ne peut qu'être masqué.`,
      ).toBe(true);
    }
  });
});
