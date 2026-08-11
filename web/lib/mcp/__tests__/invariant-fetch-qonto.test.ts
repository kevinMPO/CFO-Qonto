// ---------------------------------------------------------------------------
// INVARIANT DE DÉPÔT — aucune sortie réseau vers Qonto hors de la garde.
//
// Le produit repose sur UNE seule frontière de sécurité : `assertReadOnly`
// (lib/mcp/readonly-guard.ts), traversée avant chaque appel à l'API Qonto. Le
// jeton, lui, porte des droits d'écriture que le serveur d'autorisation refuse
// de restreindre — l'allowlist applicative est donc la seule chose qui empêche
// Argentier de bouger de l'argent.
//
// Cet invariant a déjà été enfreint une fois, et personne ne l'a vu : `lib/qonto.ts`
// appelait `fetch("https://thirdparty.qonto.com/v2" + path)` avec une clé API
// write-capable, sans jamais passer par la garde. Le seul test d'invariance de
// l'époque ne scannait qu'UN fichier (`qonto-read-client.ts`), donc il ne voyait
// pas le module fautif. C'est exactement le trou que ce fichier bouche.
//
// Ce test scanne TOUT `lib/` et TOUT `app/` : tout module qui désigne un hôte
// Qonto ET appelle `fetch` doit importer ET appeler `assertReadOnly`. Il est
// volontairement TEXTUEL et un peu large : un faux positif ne coûte qu'un import
// de garde en trop, un faux négatif coûterait un virement.
//
// UNE seule précision au scan : les lignes ENTIÈREMENT commentées sont ignorées.
// Sans elle, `app/Landing.tsx` — un composant client dont le seul lien avec la
// banque est un commentaire de palette (« inspirée de qonto.com ») et dont le
// `fetch` va vers sa propre route d'attente — serait exigé de porter la garde.
// Y importer `assertReadOnly` embarquerait la frontière serveur dans un bundle
// client sans rien filtrer : ce serait obéir au test contre l'intention. Le
// retrait est fait par LIGNE, jamais par motif `//` isolé, précisément pour ne
// pas amputer les littéraux d'URL (`"https://thirdparty.qonto.com/v2"` contient
// `//`). Un commentaire de FIN de ligne reste donc scanné : dans le doute, on
// garde le faux positif.
//
// Ce que le scan ne couvre pas, et pourquoi : `lib/auth/oauth-client.ts` appelle
// `fetch(provider.tokenEndpoint)` — l'échange de jetons OAuth. Ce n'est pas
// l'API de données bancaires, et l'allowlist de `readonly-guard.ts` ne décrit
// que des chemins de lecture Qonto (`/organization`, `/transactions`…). Lui
// imposer la garde n'aurait aucun sens : l'hôte y arrive par configuration
// (`lib/auth/providers.ts`), jamais en littéral.
//
// Comment ajouter un endpoint Qonto : élargir l'allowlist de `readonly-guard.ts`
// et passer par `lib/mcp/qonto-read-client.ts`. Jamais par un `fetch` ailleurs.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Racine du paquet `web/` (ce fichier est dans web/lib/mcp/__tests__/). */
const RACINE = fileURLToPath(new URL("../../..", import.meta.url));

/** Les deux arbres de code applicatif. Rien d'autre n'est servi au visiteur. */
const ARBRES = ["lib", "app"];

/** Artefacts de build : des copies compilées, pas du code source à auditer. */
const DOSSIERS_IGNORES = new Set([
  "node_modules",
  ".next",
  ".open-next",
  ".vercel",
  "__tests__",
]);

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

/** Hôtes et constantes qui désignent l'API bancaire Qonto. */
const MARQUEURS_QONTO = [/qonto\.com/i, /\bQONTO_API_BASE\b/];

/**
 * Sites d'appel réseau. `fetch(` couvre l'appel direct ; `executer(` couvre
 * l'indirection utilisée par `qonto-read-client.ts` (`options?.fetch ?? globalThis.fetch`),
 * pour qu'un copier-coller de ce motif ailleurs soit vu lui aussi.
 */
const MARQUEURS_RESEAU = [/(?<![.\w])fetch\s*\(/, /(?<![.\w])executer\s*\(/];

/** Tous les fichiers source des arbres scannés, chemins relatifs à `web/`. */
function fichiersSource(): string[] {
  const trouves: string[] = [];

  const descendre = (relatif: string): void => {
    for (const entree of readdirSync(join(RACINE, relatif))) {
      if (DOSSIERS_IGNORES.has(entree)) continue;
      const chemin = join(relatif, entree);
      if (statSync(join(RACINE, chemin)).isDirectory()) descendre(chemin);
      else if (EXTENSIONS.some((ext) => entree.endsWith(ext))) trouves.push(chemin);
    }
  };

  for (const arbre of ARBRES) descendre(arbre);
  return trouves.sort();
}

/**
 * Reconnaît une ligne entièrement commentée : celles qui commencent par deux
 * barres obliques, par une ouverture de bloc, ou par l'astérisque de
 * continuation d'un bloc. Ce sont les seules retirées avant analyse.
 *
 * Le retrait est délibérément fait ligne par ligne, et JAMAIS en effaçant le
 * motif de commentaire où qu'il apparaisse : un littéral d'URL
 * (`"https://…qonto.com"`) en contient un, serait alors tronqué, et le module
 * deviendrait invisible au scan — un faux négatif, exactement ce que ce fichier
 * existe pour empêcher.
 */
const LIGNE_COMMENTAIRE = /^\s*(\/\/|\/\*|\*)/;

/** Le code d'un module, ses lignes de commentaire mises de côté. */
export function codeSansCommentaires(source: string): string {
  return source
    .split("\n")
    .filter((ligne) => !LIGNE_COMMENTAIRE.test(ligne))
    .join("\n");
}

interface Module {
  chemin: string;
  /** Source intégrale — sert aux contrôles qui visent aussi la prose. */
  source: string;
  /** Source sans les lignes de commentaire — sert à détecter les appels réels. */
  code: string;
}

const MODULES: Module[] = fichiersSource().map((chemin) => {
  const source = readFileSync(join(RACINE, chemin), "utf8");
  return { chemin, source, code: codeSansCommentaires(source) };
});

/** Modules qui désignent Qonto ET émettent du réseau : les seuls concernés. */
const SORTIES_QONTO = MODULES.filter(
  (m) =>
    MARQUEURS_QONTO.some((motif) => motif.test(m.code)) &&
    MARQUEURS_RESEAU.some((motif) => motif.test(m.code)),
);

describe("invariant de dépôt : tout fetch Qonto traverse assertReadOnly", () => {
  it("scanne réellement lib/ et app/ (le scan lui-même ne doit pas mourir en silence)", () => {
    // Un scan qui ne trouve plus rien serait vert pour la pire des raisons.
    expect(MODULES.length).toBeGreaterThan(20);
    for (const arbre of ARBRES) {
      expect(
        MODULES.some((m) => m.chemin.startsWith(`${arbre}/`)),
        `aucun fichier scanné dans ${arbre}/`,
      ).toBe(true);
    }
  });

  it("voit bien le client Qonto lecture seule (le témoin du scan)", () => {
    // Si ce module cesse d'être détecté, c'est la DÉTECTION qui est cassée,
    // pas le code : les autres cas seraient alors verts pour rien.
    expect(SORTIES_QONTO.map((m) => m.chemin)).toContain("lib/mcp/qonto-read-client.ts");
  });

  it("n'autorise AUCUN module à appeler Qonto sans importer la garde", () => {
    const sansImport = SORTIES_QONTO.filter(
      (m) => !/from\s+["']@\/lib\/mcp\/readonly-guard["']/.test(m.code),
    ).map((m) => m.chemin);

    expect(
      sansImport,
      `Ces modules émettent un appel réseau vers Qonto sans importer ` +
        `assertReadOnly. Passe par lib/mcp/qonto-read-client.ts, ou élargis ` +
        `l'allowlist de lib/mcp/readonly-guard.ts — n'appelle jamais fetch ` +
        `directement sur l'API bancaire.`,
    ).toEqual([]);
  });

  it("exige que la garde soit APPELÉE, pas seulement importée", () => {
    const sansAppel = SORTIES_QONTO.filter(
      (m) => !/assertReadOnly\s*\(/.test(m.code),
    ).map((m) => m.chemin);

    expect(
      sansAppel,
      `Ces modules importent la garde sans jamais l'appeler : un import ne ` +
        `filtre rien.`,
    ).toEqual([]);
  });

  it("ne laisse subsister aucun client Qonto par clé API statique", () => {
    // `lib/qonto.ts` a été supprimé avec le repli sur la clé du fondateur.
    // Ces variables ne doivent plus réapparaître dans le code applicatif :
    // une clé « login:secret_key » est partagée par tous les visiteurs et
    // porte les droits d'écriture complets.
    // Sur le CODE, pas sur la prose : un commentaire qui RACONTE la suppression
    // (comme celui en tête de app/api/analyze/route.ts) doit rester possible.
    const residus = MODULES.filter((m) =>
      /\bQONTO_(LOGIN|SECRET_KEY|IBAN)\b/.test(m.code),
    ).map((m) => m.chemin);

    expect(
      residus,
      `Clé API statique Qonto réintroduite. Le seul mode d'authentification ` +
        `admis est le jeton OAuth du visiteur (lib/auth/*).`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Le scan ignore les lignes de commentaire. Cette mise à l'écart est la seule
// façon d'aveugler l'invariant sans toucher à ses assertions : elle a donc ses
// propres tests. Le cas nº2 est le vrai piège — un littéral d'URL contient la
// même paire de barres obliques qu'un commentaire, et une implémentation qui
// effacerait le motif au lieu de filtrer la ligne rendrait le client Qonto
// invisible tout en gardant l'invariant au vert.
// ---------------------------------------------------------------------------

describe("codeSansCommentaires", () => {
  it("écarte les lignes de commentaire, simple barre comme bloc", () => {
    const code = codeSansCommentaires(
      ["// Palette inspirée de qonto.com", "/**", " * encore qonto.com", " */", "const a = 1;"].join(
        "\n",
      ),
    );

    expect(code).not.toMatch(/qonto\.com/);
    expect(code).toContain("const a = 1;");
  });

  it("PRÉSERVE un littéral d'URL Qonto : les barres d'un https:// ne sont pas un commentaire", () => {
    const code = codeSansCommentaires('const base = "https://thirdparty.qonto.com/v2";');

    // Si cette ligne disparaissait, lib/mcp/qonto-read-client.ts sortirait du
    // périmètre scanné et tout module fautif deviendrait indétectable.
    expect(code).toContain("https://thirdparty.qonto.com/v2");
    expect(MARQUEURS_QONTO.some((motif) => motif.test(code))).toBe(true);
  });

  it("garde un appel réseau suivi d'un commentaire de fin de ligne", () => {
    const code = codeSansCommentaires(
      'await fetch(`${QONTO_API_BASE}${path}`); // lecture seule\n',
    );

    expect(MARQUEURS_RESEAU.some((motif) => motif.test(code))).toBe(true);
    expect(MARQUEURS_QONTO.some((motif) => motif.test(code))).toBe(true);
  });

  it("laisse le client Qonto réel dans le périmètre du scan", () => {
    // Contrôle de bout en bout sur le fichier réel, pas sur une chaîne forgée.
    const client = MODULES.find((m) => m.chemin === "lib/mcp/qonto-read-client.ts");

    expect(client, "lib/mcp/qonto-read-client.ts introuvable").toBeDefined();
    expect(MARQUEURS_QONTO.some((motif) => motif.test(client!.code))).toBe(true);
    expect(MARQUEURS_RESEAU.some((motif) => motif.test(client!.code))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// La clé statique ne doit pas revenir par la DOCUMENTATION non plus. Un
// `.env.example` qui propose encore `QONTO_LOGIN=` est une invitation à la
// reposer dans un secret store d'hébergeur — et le code, lui, ne la lit plus :
// l'exploitant croirait configurer un repli qui n'existe pas, tout en laissant
// traîner une clé write-capable exfiltrable.
//
// Le contrôle porte sur les lignes d'AFFECTATION (`QONTO_LOGIN=…` en début de
// ligne), jamais sur la prose : raconter la suppression est exactement ce qu'on
// attend de ces deux fichiers, et le second cas l'exige.
// ---------------------------------------------------------------------------

describe("documentation : la clé API statique reste retirée", () => {
  const DOCS = [".env.example", "README.md"];
  const AFFECTATION = /^\s*QONTO_(LOGIN|SECRET_KEY|IBAN)\s*=/m;

  for (const doc of DOCS) {
    it(`${doc} ne propose plus la clé statique du fondateur`, () => {
      const contenu = readFileSync(join(RACINE, doc), "utf8");

      expect(
        AFFECTATION.test(contenu),
        `${doc} redonne une valeur à QONTO_LOGIN / QONTO_SECRET_KEY / ` +
          `QONTO_IBAN. Ces variables ne sont plus lues par le code : les ` +
          `proposer pousse à déposer chez l'hébergeur une clé Qonto partagée, ` +
          `dotée des droits d'écriture.`,
      ).toBe(false);
    });

    it(`${doc} documente la suppression au lieu de la taire`, () => {
      const contenu = readFileSync(join(RACINE, doc), "utf8");

      // Retirer les variables sans expliquer pourquoi laisserait le prochain
      // lecteur les « remettre, elles manquent ».
      expect(
        /QONTO_LOGIN/.test(contenu) && /supprim|SUPPRIM|retir|RETIR/.test(contenu),
        `${doc} doit expliquer que la clé statique a été supprimée, et pourquoi.`,
      ).toBe(true);
    });
  }
});
