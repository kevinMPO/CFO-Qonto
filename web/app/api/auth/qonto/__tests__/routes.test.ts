// ---------------------------------------------------------------------------
// Tests des routes du flux OAuth Qonto.
//
// Ce qu'ils protègent, dans l'ordre d'importance :
//   1. la PROTECTION CSRF du callback — un `state` absent ou différent doit
//      faire échouer la connexion. Sans elle, un tiers fait brancher son compte
//      (ou celui de la victime) dans une session qui n'est pas la sienne ;
//   2. le fait que le `code_verifier` PKCE ne soit jamais lisible par un script
//      de page (httpOnly) ni envoyé hors du flux (chemin restreint) ;
//   3. l'EFFET de la révocation — pas seulement son corps JSON. L'ancien test
//      d'idempotence n'assérait que `{revoked:true}` deux fois de suite, sans
//      jamais poser de jeton dans le store : il passait à l'identique si la
//      ligne qui supprime le jeton disparaissait, c'est-à-dire si la révocation
//      ne révoquait plus rien. Ici, le jeton est posé AVANT et son absence est
//      vérifiée APRÈS ;
//   4. le fait que `/status` ne laisse jamais fuiter un jeton — en exerçant la
//      branche réellement risquée, `connected = true`, qui lit le store et
//      l'organisation. Sans jeton stocké, les assertions « ne contient pas
//      Bearer » portaient sur trois booléens et étaient vacantes ;
//   5. l'UNICITÉ DE LA CLÉ DE LOCATAIRE au callback : jetons, cookie et journal
//      d'audit doivent partir sous le MÊME identifiant, celui de la base ;
//   6. le fait qu'une panne de base ne puisse pas empêcher une connexion.
//
// Les cas 1 à 4 ne font aucun appel réseau. Les cas 5 et 6 en simulent deux (le
// token endpoint et `/organization`) avec un faux `fetch`.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as callback } from "@/app/api/auth/qonto/callback/route";
import { POST as revoke } from "@/app/api/auth/qonto/revoke/route";
import { GET as start } from "@/app/api/auth/qonto/start/route";
import { GET as status } from "@/app/api/auth/qonto/status/route";
import type { TokenSet } from "@/lib/auth/oauth-client";
import { QONTO_MCP_PROXY } from "@/lib/auth/providers";
import {
  NOM_COOKIE_SESSION,
  NOM_COOKIE_STATE,
  NOM_COOKIE_VERIFIER,
  deriverOrgId,
  lireSession,
  signerSession,
  verifierSession,
} from "@/lib/auth/session";
import { __resetTokenStoreForTests, getTokenStore } from "@/lib/auth/token-store";
import { QONTO_API_BASE } from "@/lib/mcp/qonto-read-client";

const SECRET = "un-secret-de-test-suffisamment-long-0123456789";
const BASE = "https://argentier.test";

let secretInitial: string | undefined;
let baseInitiale: string | undefined;
let fetchInitial: typeof fetch;
const fauxFetch = vi.fn<typeof fetch>();

beforeEach(() => {
  secretInitial = process.env.ARGENTIER_SESSION_SECRET;
  baseInitiale = process.env.ARGENTIER_BASE_URL;
  process.env.ARGENTIER_SESSION_SECRET = SECRET;
  process.env.ARGENTIER_BASE_URL = BASE;

  // Filet de sécurité : si un test provoquait un appel réseau, il échouerait
  // au lieu de sortir vraiment sur Internet.
  fetchInitial = globalThis.fetch;
  fauxFetch.mockReset();
  fauxFetch.mockRejectedValue(new Error("aucun appel réseau attendu dans ces tests"));
  globalThis.fetch = fauxFetch as unknown as typeof fetch;

  // Store de jetons neuf à chaque cas : aucun cas ne doit dépendre de l'ordre.
  __resetTokenStoreForTests();
});

afterEach(() => {
  globalThis.fetch = fetchInitial;
  const global = globalThis as { ARGENTIER_TOKENS?: unknown; ARGENTIER_DB?: unknown };
  delete global.ARGENTIER_TOKENS;
  delete global.ARGENTIER_DB;
  __resetTokenStoreForTests();
  if (secretInitial === undefined) delete process.env.ARGENTIER_SESSION_SECRET;
  else process.env.ARGENTIER_SESSION_SECRET = secretInitial;
  if (baseInitiale === undefined) delete process.env.ARGENTIER_BASE_URL;
  else process.env.ARGENTIER_BASE_URL = baseInitiale;
});

/** Cookies posés par une réponse, indexés par nom. */
function cookiesPoses(reponse: Response): Map<string, string> {
  const entetes = reponse.headers.getSetCookie?.() ?? [];
  const table = new Map<string, string>();
  for (const brut of entetes) {
    const nom = brut.slice(0, brut.indexOf("="));
    table.set(nom, brut);
  }
  return table;
}

function requeteCallback(query: string, cookie?: string): Request {
  return new Request(`${BASE}/api/auth/qonto/callback${query}`, {
    headers: cookie ? { cookie } : {},
  });
}

/** Jeu de jetons de test, valide une heure. */
function jeuDeJetons(surcharge: Partial<TokenSet> = {}): TokenSet {
  return {
    accessToken: "acces-du-visiteur",
    refreshToken: "rafraichissement-du-visiteur",
    expiresAt: Date.now() + 3_600_000,
    tokenType: "Bearer",
    ...surcharge,
  };
}

/** Réponse HTTP minimale, suffisante pour oauth-client et qonto-read-client. */
function reponseHttp(corps: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => corps,
    text: async () => JSON.stringify(corps),
  } as unknown as Response;
}

/** Valeur d'un cookie posé par une réponse (sans ses attributs). */
function valeurCookie(reponse: Response, nom: string): string {
  const brut = cookiesPoses(reponse).get(nom) ?? "";
  return decodeURIComponent(brut.slice(brut.indexOf("=") + 1).split(";")[0]);
}

describe("GET /api/auth/qonto/start", () => {
  it("redirige vers le serveur d'autorisation en PKCE S256", async () => {
    const reponse = await start();

    expect(reponse.status).toBe(302);
    const url = new URL(reponse.headers.get("location") ?? "");
    expect(url.origin + url.pathname).toBe("https://mcp.qonto.com/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${BASE}/api/auth/qonto/callback`,
    );
  });

  it("ne demande que des scopes en lecture", async () => {
    const url = new URL((await start()).headers.get("location") ?? "");
    const scopes = (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean);

    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) expect(scope.endsWith(".read")).toBe(true);
  });

  it("dépose verifier et state en httpOnly, hors de portée des scripts", async () => {
    const cookies = cookiesPoses(await start());

    for (const nom of [NOM_COOKIE_VERIFIER, NOM_COOKIE_STATE]) {
      const cookie = cookies.get(nom);
      expect(cookie, `cookie ${nom} absent`).toBeTruthy();
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=lax");
      // Le secret PKCE ne doit voyager que sur les routes du flux.
      expect(cookie).toContain("Path=/api/auth/qonto");
    }
  });

  it("pose le même state que celui envoyé au serveur d'autorisation", async () => {
    const reponse = await start();
    const url = new URL(reponse.headers.get("location") ?? "");
    const cookie = cookiesPoses(reponse).get(NOM_COOKIE_STATE) ?? "";
    const valeur = decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1).split(";")[0]);

    expect(valeur).toBe(url.searchParams.get("state"));
  });

  it("tire un state et un verifier différents à chaque appel", async () => {
    const premier = cookiesPoses(await start());
    const second = cookiesPoses(await start());

    expect(premier.get(NOM_COOKIE_STATE)).not.toBe(second.get(NOM_COOKIE_STATE));
    expect(premier.get(NOM_COOKIE_VERIFIER)).not.toBe(second.get(NOM_COOKIE_VERIFIER));
  });
});

describe("GET /api/auth/qonto/callback — protection CSRF", () => {
  it("refuse un retour sans cookie de state", async () => {
    const reponse = await callback(requeteCallback("?code=abc&state=xyz"));

    expect(reponse.status).toBe(400);
    await expect(reponse.json()).resolves.toMatchObject({ error: "state_invalide" });
    expect(fauxFetch).not.toHaveBeenCalled();
  });

  it("refuse un state qui ne correspond pas au cookie", async () => {
    const reponse = await callback(
      requeteCallback("?code=abc&state=state-attaquant", `${NOM_COOKIE_STATE}=state-legitime`),
    );

    expect(reponse.status).toBe(400);
    await expect(reponse.json()).resolves.toMatchObject({ error: "state_invalide" });
    expect(fauxFetch).not.toHaveBeenCalled();
  });

  it("refuse un state faux même quand tout le reste est en place", async () => {
    // Le cas de l'attaque réelle : code valide, cookie PKCE valide, seul le
    // `state` a été forgé. Rien ne doit partir vers le serveur d'autorisation.
    const reponse = await callback(
      requeteCallback(
        "?code=code-attaquant&state=state-attaquant",
        `${NOM_COOKIE_STATE}=state-legitime; ${NOM_COOKIE_VERIFIER}=` +
          "verifier-legitime-de-longueur-suffisante-pour-la-rfc-7636",
      ),
    );

    expect(reponse.status).toBe(400);
    await expect(reponse.json()).resolves.toMatchObject({ error: "state_invalide" });
    expect(fauxFetch).not.toHaveBeenCalled();
  });

  it("refuse un state vide même si le cookie l'est aussi", async () => {
    const reponse = await callback(requeteCallback("?code=abc&state=", `${NOM_COOKIE_STATE}=`));

    expect(reponse.status).toBe(400);
    await expect(reponse.json()).resolves.toMatchObject({ error: "state_invalide" });
  });

  it("refuse un callback sans code, state pourtant valide", async () => {
    const reponse = await callback(
      requeteCallback("?state=bon-state", `${NOM_COOKIE_STATE}=bon-state`),
    );

    expect(reponse.status).toBe(400);
    await expect(reponse.json()).resolves.toMatchObject({ error: "callback_incomplet" });
    expect(fauxFetch).not.toHaveBeenCalled();
  });

  it("refuse un callback sans cookie verifier (PKCE amputé)", async () => {
    const reponse = await callback(
      requeteCallback("?code=abc&state=bon-state", `${NOM_COOKIE_STATE}=bon-state`),
    );

    expect(reponse.status).toBe(400);
    expect(fauxFetch).not.toHaveBeenCalled();
  });

  it("efface les cookies temporaires même quand il refuse", async () => {
    const reponse = await callback(requeteCallback("?code=abc&state=xyz"));
    const cookies = cookiesPoses(reponse);

    for (const nom of [NOM_COOKIE_VERIFIER, NOM_COOKIE_STATE]) {
      expect(cookies.get(nom)).toContain("Max-Age=0");
    }
  });

  it("n'ouvre aucune session en cas de refus", async () => {
    const reponse = await callback(requeteCallback("?code=abc&state=xyz"));
    expect(cookiesPoses(reponse).has("argentier_session")).toBe(false);
  });
});

describe("GET /api/auth/qonto/callback — refus de l'utilisateur", () => {
  it("renvoie vers /demo sans rien stocker", async () => {
    const reponse = await callback(requeteCallback("?error=access_denied"));

    expect(reponse.status).toBe(302);
    expect(reponse.headers.get("location")).toBe(`${BASE}/demo?qonto=refus`);
    expect(cookiesPoses(reponse).has("argentier_session")).toBe(false);
    expect(fauxFetch).not.toHaveBeenCalled();
  });

  it("distingue une erreur serveur d'un refus", async () => {
    const reponse = await callback(requeteCallback("?error=server_error"));

    expect(reponse.headers.get("location")).toBe(`${BASE}/demo?qonto=erreur`);
  });
});

describe("POST /api/auth/qonto/revoke", () => {
  const ORG = "org_test";

  /** Requête de révocation portant une session signée pour `ORG`. */
  async function requeteRevoke(): Promise<Request> {
    const cookie = `${NOM_COOKIE_SESSION}=${await signerSession(ORG)}`;
    return new Request(`${BASE}/api/auth/qonto/revoke`, { method: "POST", headers: { cookie } });
  }

  it("efface le cookie de session, même sans session", async () => {
    const reponse = await revoke(new Request(`${BASE}/api/auth/qonto/revoke`, { method: "POST" }));

    expect(reponse.status).toBe(200);
    await expect(reponse.json()).resolves.toEqual({ revoked: true });
    expect(cookiesPoses(reponse).get("argentier_session")).toContain("Max-Age=0");
  });

  it("SUPPRIME RÉELLEMENT le jeton du store", async () => {
    // Le cœur du sujet : sans ce cas, la route pouvait ne rien révoquer du tout
    // et rester verte. Le jeton est posé avant, son absence exigée après.
    await getTokenStore().put(ORG, jeuDeJetons());

    const reponse = await revoke(await requeteRevoke());

    expect(reponse.status).toBe(200);
    await expect(reponse.json()).resolves.toEqual({ revoked: true });
    await expect(getTokenStore().get(ORG)).resolves.toBeNull();
  });

  it("est idempotent : le second appel reste 200, le jeton reste absent", async () => {
    await getTokenStore().put(ORG, jeuDeJetons());

    await expect((await revoke(await requeteRevoke())).json()).resolves.toEqual({ revoked: true });
    const second = await revoke(await requeteRevoke());

    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ revoked: true });
    await expect(getTokenStore().get(ORG)).resolves.toBeNull();
  });

  it("ne touche pas au jeton d'un AUTRE locataire", async () => {
    await getTokenStore().put(ORG, jeuDeJetons());
    await getTokenStore().put("org_voisin", jeuDeJetons({ accessToken: "acces-du-voisin" }));

    await revoke(await requeteRevoke());

    await expect(getTokenStore().get("org_voisin")).resolves.toMatchObject({
      accessToken: "acces-du-voisin",
    });
  });

  it("REFUSE de prétendre au succès quand la session est illisible", async () => {
    // Erreur de CONFIGURATION : secret absent ou trop court (rotation en cours,
    // variable mal renseignée). Avant correctif, `.catch(() => null)` la
    // confondait avec « pas de session » : la route sautait la suppression et
    // répondait 200 {revoked:true}. Le DAF croyait son accès coupé ; son jeton,
    // porteur de request_transfers.write, vivait encore 30 jours.
    const requete = await requeteRevoke();
    await getTokenStore().put(ORG, jeuDeJetons());
    process.env.ARGENTIER_SESSION_SECRET = "trop-court";

    const reponse = await revoke(requete);
    const corps = (await reponse.json()) as { revoked: boolean; error?: string };

    expect(reponse.status).toBe(500);
    expect(corps.revoked).toBe(false);
    expect(corps.error).toBe("revocation_impossible");
    // Et l'on n'a surtout pas menti : le jeton est bel et bien encore là.
    process.env.ARGENTIER_SESSION_SECRET = SECRET;
    await expect(getTokenStore().get(ORG)).resolves.not.toBeNull();
  });

  it("dit la vérité et GARDE le cookie quand le store refuse la suppression", async () => {
    // Sans le cookie, l'utilisateur perdrait le seul moyen de réessayer.
    (globalThis as { ARGENTIER_TOKENS?: unknown }).ARGENTIER_TOKENS = {
      get: async () => null,
      put: async () => {},
      delete: async () => {
        throw new Error("KV indisponible");
      },
    };

    const reponse = await revoke(await requeteRevoke());
    const corps = (await reponse.json()) as { revoked: boolean; error?: string };

    expect(reponse.status).toBe(503);
    expect(corps.revoked).toBe(false);
    expect(corps.error).toBe("revocation_incomplete");
    expect(cookiesPoses(reponse).has("argentier_session")).toBe(false);
  });

  it("horodate la révocation en base, pour que les cookies antérieurs meurent", async () => {
    // `revoked_at` n'est pas de la décoration : c'est ce que relit `lireSession`.
    const lignes = new Map<string, Record<string, unknown>>([
      [ORG, { id: ORG, qonto_org_id: "q1", legal_name: null, created_at: 1, connected_at: 1, revoked_at: null }],
    ]);
    const emis: string[] = [];
    (globalThis as { ARGENTIER_DB?: unknown }).ARGENTIER_DB = {
      prepare(requete: string) {
        const sql = requete.replace(/\s+/g, " ").trim();
        let bindings: unknown[] = [];
        const statement = {
          bind(...valeurs: unknown[]) {
            bindings = valeurs;
            emis.push(sql);
            return statement;
          },
          async first() {
            return null;
          },
          async all() {
            return { results: [], success: true };
          },
          async run() {
            if (sql.startsWith("UPDATE organizations SET revoked_at")) {
              const ligne = lignes.get(String(bindings[1]));
              if (!ligne) return { results: [], success: true, meta: { changes: 0 } };
              ligne.revoked_at = bindings[0];
              return { results: [{ id: ligne.id }], success: true, meta: { changes: 1 } };
            }
            return { results: [], success: true, meta: { changes: 1 } };
          },
        };
        return statement;
      },
    };
    await getTokenStore().put(ORG, jeuDeJetons());

    await expect((await revoke(await requeteRevoke())).json()).resolves.toEqual({ revoked: true });

    expect(lignes.get(ORG)?.revoked_at).toEqual(expect.any(Number));
    expect(emis.some((sql) => sql.startsWith("INSERT INTO audit_log"))).toBe(true);
  });
});

describe("GET /api/auth/qonto/status", () => {
  it("annonce non connecté sans session, et dit la vérité sur les scopes", async () => {
    const reponse = await status(new Request(`${BASE}/api/auth/qonto/status`));

    await expect(reponse.json()).resolves.toEqual({
      connected: false,
      readOnly: true,
      // Les scopes demandés sont tous en `.read` et Qonto les honore : le
      // jeton lui-même est incapable d'écrire.
      scopesAreWriteCapable: false,
    });
    expect(reponse.headers.get("cache-control")).toBe("no-store");
  });

  it("ne renvoie jamais de jeton, même avec une session CONNECTÉE", async () => {
    // Un jeton est réellement stocké : sans lui, `connected` valait false, le
    // corps ne contenait que trois booléens et les assertions ci-dessous
    // portaient sur du vide — la branche risquée (lecture du store, puis de
    // l'organisation) n'était jamais exécutée.
    await getTokenStore().put("org_test", jeuDeJetons({ accessToken: "acces-tres-secret" }));
    const cookie = `${NOM_COOKIE_SESSION}=${await signerSession("org_test")}`;
    const reponse = await status(
      new Request(`${BASE}/api/auth/qonto/status`, { headers: { cookie } }),
    );

    const charge = (await reponse.json()) as { connected: boolean };
    expect(charge.connected).toBe(true);

    const corps = JSON.stringify(charge);
    for (const interdit of [
      "accessToken",
      "access_token",
      "refresh",
      "Bearer",
      "acces-tres-secret",
      "expiresAt",
    ]) {
      expect(corps).not.toContain(interdit);
    }
  });
});

// --- Callback : une seule clé de locataire, et une base qui ne bloque rien ---
//
// Ces cas vont jusqu'au bout du flux : échange du code, lecture de
// `/organization`, persistance. Deux sorties réseau sont simulées, aucune n'est
// réelle.

describe("GET /api/auth/qonto/callback — clé de locataire", () => {
  const STATE = "state-legitime";
  const VERIFIER = "verifier-legitime-de-longueur-suffisante-pour-la-rfc-7636";
  const QONTO_ORG_ID = "qonto-org-1";
  /** Id interne que la base porte DÉJÀ pour cette organisation Qonto. */
  const CANONIQUE = "org_canonique_deja_en_base";

  /**
   * Faux D1 : upsert (RETURNING), audit, instructions de migration, et RELECTURE
   * de la ligne écrite — c'est cette relecture qui permet de vérifier que le
   * cookie émis par le callback est bien de la génération que la base enregistre.
   */
  class FauxD1Callback {
    readonly emis: string[] = [];
    /** Ligne `organizations` telle que l'upsert l'a écrite. */
    ligne: Record<string, unknown> | null = null;
    /** Erreur levée par `run()` tant qu'elle n'est pas consommée. */
    panne: Error | null = null;
    /** `true` dès que la migration a été rejouée. */
    migre = false;
    /** Id rendu par l'upsert — la clé canonique du locataire. */
    idCanonique = CANONIQUE;

    prepare(requete: string) {
      // Les instructions de migration conservent leurs commentaires `--` en
      // tête (decouperSql les garde volontairement) : on les retire pour
      // reconnaître l'instruction.
      const sql = requete
        .split("\n")
        .filter((ligne) => !/^\s*--/.test(ligne))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const base = this;
      let bindings: unknown[] = [];
      const statement = {
        bind(...valeurs: unknown[]) {
          bindings = valeurs;
          return statement;
        },
        async first() {
          if (!/^SELECT .+ FROM organizations WHERE id = \?$/.test(sql)) {
            throw new Error(`FauxD1 : SELECT non gere → « ${sql} ».`);
          }
          return base.ligne && base.ligne.id === bindings[0] ? base.ligne : null;
        },
        async all() {
          return { results: [], success: true };
        },
        async run() {
          base.emis.push(sql);
          if (sql.startsWith("CREATE ")) {
            base.migre = true;
            return { results: [], success: true, meta: { changes: 0 } };
          }
          // Une panne de schéma disparaît dès que la migration est passée : la
          // seconde tentative doit réussir, sinon le test ne prouverait pas la
          // réparation.
          if (base.migre) base.panne = null;
          if (base.panne) throw base.panne;
          if (sql.startsWith("INSERT INTO organizations")) {
            // Ordre des colonnes : id, qonto_org_id, legal_name, created_at,
            // connected_at, revoked_at. L'id rendu est celui que la base porte
            // DÉJÀ (résolution du conflit sur qonto_org_id), pas celui bindé.
            base.ligne = {
              id: base.idCanonique,
              qonto_org_id: String(bindings[1]),
              legal_name: bindings[2] ?? null,
              created_at: Number(bindings[3]),
              connected_at: bindings[4] ?? null,
              revoked_at: bindings[5] ?? null,
            };
            return { results: [base.ligne], success: true, meta: { changes: 1 } };
          }
          return { results: [], success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    }
  }

  let db: FauxD1Callback;

  beforeEach(() => {
    db = new FauxD1Callback();
    (globalThis as { ARGENTIER_DB?: unknown }).ARGENTIER_DB = db;

    fauxFetch.mockImplementation(async (entree: RequestInfo | URL) => {
      const url = String(entree);
      if (url === QONTO_MCP_PROXY.tokenEndpoint) {
        return reponseHttp({
          access_token: "acces-neuf",
          refresh_token: "rafraichissement-neuf",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (url === `${QONTO_API_BASE}/organization`) {
        return reponseHttp({
          organization: {
            id: QONTO_ORG_ID,
            legal_name: "MAMFORMA",
            bank_accounts: [{ iban: "FR7616798000010000012345070", balance: 7646.5 }],
          },
        });
      }
      throw new Error(`Appel réseau inattendu : ${url}`);
    });
  });

  /** Retour de consentement complet et légitime. */
  function retourLegitime(): Request {
    return requeteCallback(
      `?code=code-legitime&state=${STATE}`,
      `${NOM_COOKIE_STATE}=${STATE}; ${NOM_COOKIE_VERIFIER}=${VERIFIER}`,
    );
  }

  it("signe le cookie et range les jetons sous l'id de la BASE, pas sous le dérivé", async () => {
    const derive = await deriverOrgId(QONTO_ORG_ID);
    expect(derive).not.toBe(CANONIQUE);

    const reponse = await callback(retourLegitime());

    expect(reponse.headers.get("location")).toBe(`${BASE}/demo?qonto=connecte`);
    // 1. Le cookie porte la clé canonique...
    const session = await verifierSession(valeurCookie(reponse, NOM_COOKIE_SESSION));
    expect(session?.orgId).toBe(CANONIQUE);
    // 2. ...les jetons sont rangés sous la MÊME clé...
    await expect(getTokenStore().get(CANONIQUE)).resolves.toMatchObject({
      accessToken: "acces-neuf",
    });
    // 3. ...et plus rien ne subsiste sous le dérivé. Avant correctif, les jetons
    // et le cookie partaient sous le dérivé tandis que le journal d'audit et
    // toutes les lectures ultérieures visaient l'id de la base : une rotation du
    // secret de session scindait le journal et rendait `revoked_at` inatteignable.
    await expect(getTokenStore().get(derive)).resolves.toBeNull();
  });

  it("journalise la connexion sous cette même clé", async () => {
    await callback(retourLegitime());

    expect(db.emis.some((sql) => sql.startsWith("INSERT INTO organizations"))).toBe(true);
    expect(db.emis.some((sql) => sql.startsWith("INSERT INTO audit_log"))).toBe(true);
  });

  it("connecte quand même si la base est en panne (la traçabilité ne bloque pas)", async () => {
    db.panne = new Error("D1_ERROR: database is locked");

    const reponse = await callback(retourLegitime());

    // Avant correctif : la moindre erreur D1 sautait au catch général AVANT le
    // stockage du jeton → `?qonto=erreur`, et personne ne pouvait se connecter.
    expect(reponse.headers.get("location")).toBe(`${BASE}/demo?qonto=connecte`);
    const derive = await deriverOrgId(QONTO_ORG_ID);
    const session = await verifierSession(valeurCookie(reponse, NOM_COOKIE_SESSION));
    // Repli sur le dérivé, et le token store est indexé sur la MÊME valeur.
    expect(session?.orgId).toBe(derive);
    await expect(getTokenStore().get(derive)).resolves.not.toBeNull();
  });

  it("applique la migration puis réessaie quand le schéma n'existe pas", async () => {
    // Le cas « on a provisionné D1 en oubliant wrangler d1 execute » : il rendait
    // toute connexion impossible, avec `?qonto=erreur` pour seul diagnostic.
    db.panne = new Error("D1_ERROR: no such table: organizations");

    const reponse = await callback(retourLegitime());

    expect(reponse.headers.get("location")).toBe(`${BASE}/demo?qonto=connecte`);
    expect(db.emis.some((sql) => sql.startsWith("CREATE TABLE IF NOT EXISTS organizations"))).toBe(
      true,
    );
    // Et l'organisation a bien fini par être persistée : la clé retenue est celle
    // de la base.
    const session = await verifierSession(valeurCookie(reponse, NOM_COOKIE_SESSION));
    expect(session?.orgId).toBe(CANONIQUE);
  });

  it("émet un cookie de la génération courante, accepté par lireSession", async () => {
    // Garde-fou anti-tir-dans-le-pied : le cookie et `connected_at` doivent
    // porter le MÊME instant. Sinon le callback émettrait une session que
    // `lireSession` refuserait aussitôt comme antérieure au consentement — la
    // connexion « réussirait » et rien ne fonctionnerait ensuite.
    const reponse = await callback(retourLegitime());
    const cookie = valeurCookie(reponse, NOM_COOKIE_SESSION);

    const emisA = (await verifierSession(cookie))?.emisA ?? 0;
    expect(emisA).toBe(db.ligne?.connected_at);

    const lue = await lireSession({
      headers: {
        get: (nom: string) =>
          nom.toLowerCase() === "cookie" ? `${NOM_COOKIE_SESSION}=${cookie}` : null,
      },
    });
    expect(lue?.orgId).toBe(CANONIQUE);
  });

  it("une reconnexion périme les cookies de la connexion précédente", async () => {
    // Bout à bout, sur les deux routes : c'est l'attaque du cookie capturé.
    const ancien = valeurCookie(await callback(retourLegitime()), NOM_COOKIE_SESSION);
    const entete = (valeur: string) => ({
      headers: {
        get: (nom: string) =>
          nom.toLowerCase() === "cookie" ? `${NOM_COOKIE_SESSION}=${valeur}` : null,
      },
    });
    await expect(lireSession(entete(ancien))).resolves.toMatchObject({ orgId: CANONIQUE });

    // Une seconde connexion, plus tard : nouvelle génération.
    const apres = Date.now() + 5_000;
    vi.spyOn(Date, "now").mockReturnValue(apres);
    const neuf = valeurCookie(await callback(retourLegitime()), NOM_COOKIE_SESSION);
    vi.restoreAllMocks();

    await expect(lireSession(entete(neuf))).resolves.toMatchObject({ orgId: CANONIQUE });
    // Et l'ancien ne vaut plus rien, alors qu'il est signé et dans ses 30 jours.
    await expect(lireSession(entete(ancien))).resolves.toBeNull();
  });
});
