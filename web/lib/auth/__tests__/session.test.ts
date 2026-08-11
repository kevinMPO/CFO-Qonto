// ---------------------------------------------------------------------------
// Tests du cookie de session signé.
//
// Ce qu'ils protègent : le cookie de session est ce qui dit « cette requête a
// le droit de lire CE compte bancaire ». Une signature contournable, une
// session éternelle ou un identifiant lisible en clair, et c'est le compte d'un
// tiers qui s'ouvre. D'où quatre familles de cas : altération, secret changé,
// expiration, et absence de donnée identifiante dans le cookie.
//
// CINQUIÈME FAMILLE, ajoutée après l'audit : la RÉVOCABILITÉ. Une signature
// valide et une date fraîche ne disent rien de la révocation. `deriverOrgId`
// étant déterministe, un cookie capturé puis « débranché » redevenait
// pleinement valide dès que la victime reconnectait son compte : mêmes octets,
// même clé de locataire, jetons neufs rangés dessous. Les cas de
// « lireSession — génération » exigent qu'un cookie d'avant la révocation ou
// d'avant le dernier consentement soit REFUSÉ, et que `revoked_at` soit enfin
// consulté par un chemin de production.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CHEMIN_COOKIES_OAUTH,
  DUREE_SESSION_SECONDES,
  NOM_COOKIE_SESSION,
  deriverOrgId,
  egalTempsConstant,
  lireCookie,
  lireSession,
  lireSessionSignee,
  optionsCookieOAuth,
  optionsCookieSession,
  optionsEffacement,
  sessionEncoreValide,
  signerSession,
  verifierSession,
} from "@/lib/auth/session";

const SECRET = "un-secret-de-test-suffisamment-long-0123456789";
const AUTRE_SECRET = "un-AUTRE-secret-de-test-tout-aussi-long-987654";
const ORG = "org_LzKQ0v8w2m1p";
const T0 = 1_760_000_000_000;

let secretInitial: string | undefined;
let baseInitiale: string | undefined;

beforeEach(() => {
  secretInitial = process.env.ARGENTIER_SESSION_SECRET;
  baseInitiale = process.env.ARGENTIER_BASE_URL;
  process.env.ARGENTIER_SESSION_SECRET = SECRET;
  delete process.env.ARGENTIER_BASE_URL;
});

afterEach(() => {
  if (secretInitial === undefined) delete process.env.ARGENTIER_SESSION_SECRET;
  else process.env.ARGENTIER_SESSION_SECRET = secretInitial;
  if (baseInitiale === undefined) delete process.env.ARGENTIER_BASE_URL;
  else process.env.ARGENTIER_BASE_URL = baseInitiale;
});

describe("signerSession / verifierSession", () => {
  it("fait l'aller-retour sur l'identifiant de locataire", async () => {
    const cookie = await signerSession(ORG, T0);
    await expect(verifierSession(cookie, T0)).resolves.toEqual({
      orgId: ORG,
      emisA: T0,
    });
  });

  it("produit un jeton en trois parties, versionné", async () => {
    const cookie = await signerSession(ORG, T0);
    const morceaux = cookie.split(".");
    expect(morceaux).toHaveLength(3);
    expect(morceaux[0]).toBe("v1");
  });

  it("refuse un identifiant de locataire vide", async () => {
    await expect(signerSession("   ", T0)).rejects.toThrow(/orgId vide/);
  });

  it("refuse une signature altérée d'un seul caractère", async () => {
    const cookie = await signerSession(ORG, T0);
    const [version, charge, signature] = cookie.split(".");
    const premier = signature[0] === "A" ? "B" : "A";
    const falsifiee = `${version}.${charge}.${premier}${signature.slice(1)}`;

    expect(falsifiee).not.toBe(cookie);
    await expect(verifierSession(falsifiee, T0)).resolves.toBeNull();
  });

  it("refuse une charge utile modifiée (changement de locataire)", async () => {
    const cookie = await signerSession(ORG, T0);
    const autre = await signerSession("org_UNE_AUTRE_ORGANISATION", T0);
    // On recolle la charge utile de l'autre organisation sur notre signature.
    const hybride = `v1.${autre.split(".")[1]}.${cookie.split(".")[2]}`;

    await expect(verifierSession(hybride, T0)).resolves.toBeNull();
  });

  it("refuse un jeton signé avec un autre secret", async () => {
    const cookie = await signerSession(ORG, T0);
    process.env.ARGENTIER_SESSION_SECRET = AUTRE_SECRET;

    await expect(verifierSession(cookie, T0)).resolves.toBeNull();
  });

  it("refuse une session expirée", async () => {
    const cookie = await signerSession(ORG, T0);
    const apres = T0 + (DUREE_SESSION_SECONDES + 1) * 1000;

    await expect(verifierSession(cookie, apres)).resolves.toBeNull();
  });

  it("accepte une session juste avant l'échéance", async () => {
    const cookie = await signerSession(ORG, T0);
    const juste = T0 + (DUREE_SESSION_SECONDES - 60) * 1000;

    await expect(verifierSession(cookie, juste)).resolves.not.toBeNull();
  });

  it("refuse une session horodatée dans le futur", async () => {
    const cookie = await signerSession(ORG, T0 + 3_600_000);

    await expect(verifierSession(cookie, T0)).resolves.toBeNull();
  });

  it.each([
    ["chaîne vide", ""],
    ["absente", undefined],
    ["nulle", null],
    ["sans séparateur", "abcdef"],
    ["mauvaise version", "v2.abc.def"],
    ["quatre morceaux", "v1.a.b.c"],
    ["charge utile non base64", "v1.@@@@.signature"],
  ])("refuse un cookie %s", async (_cas, valeur) => {
    await expect(verifierSession(valeur as string | null | undefined, T0)).resolves.toBeNull();
  });

  it("échoue bruyamment si le secret est absent ou trop court", async () => {
    delete process.env.ARGENTIER_SESSION_SECRET;
    await expect(signerSession(ORG, T0)).rejects.toThrow(/ARGENTIER_SESSION_SECRET est absente/);

    process.env.ARGENTIER_SESSION_SECRET = "trop-court";
    await expect(signerSession(ORG, T0)).rejects.toThrow(/32 au minimum/);
  });

  it("ne laisse lire aucune donnée identifiante dans le cookie", async () => {
    // La charge utile est en base64url, donc LISIBLE : elle ne doit donc
    // contenir que l'identifiant opaque, jamais le compte Qonto ni un nom.
    const orgId = await deriverOrgId("croissant-9134");
    const cookie = await signerSession(orgId, T0);
    const charge = cookie.split(".")[1];
    const clair = Buffer.from(charge.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();

    expect(clair).not.toContain("croissant-9134");
    expect(clair).toContain(orgId);
  });
});

describe("lireSession", () => {
  const requete = (cookie: string | null) => ({
    headers: { get: (nom: string) => (nom.toLowerCase() === "cookie" ? cookie : null) },
  });

  it("lit la session portée par l'en-tête Cookie", async () => {
    const cookie = await signerSession(ORG, T0);
    const entete = `theme=sombre; ${NOM_COOKIE_SESSION}=${cookie}; lang=fr`;

    await expect(lireSession(requete(entete), T0)).resolves.toEqual({
      orgId: ORG,
      emisA: T0,
    });
  });

  it("rend null sans cookie de session", async () => {
    await expect(lireSession(requete("lang=fr"), T0)).resolves.toBeNull();
    await expect(lireSession(requete(null), T0)).resolves.toBeNull();
  });
});

// --- Génération de session --------------------------------------------------
//
// `lireSession` confronte la date d'émission du cookie à `connected_at` et
// `revoked_at`. Le faux D1 ci-dessous ne comprend QUE le SELECT que
// `getOrganizationById` émet ; toute autre requête explose, ce qui interdit à ce
// chemin de se mettre à lire ou écrire autre chose sans qu'on le voie.

interface LigneOrg extends Record<string, unknown> {
  id: string;
  qonto_org_id: string;
  legal_name: string | null;
  created_at: number;
  connected_at: number | null;
  revoked_at: number | null;
}

/** Faux D1 posé sur `globalThis`, exactement là où `bindingsArgentier()` regarde. */
class FauxD1 {
  readonly lignes = new Map<string, LigneOrg>();
  /** Erreur à lever au lieu de répondre (panne, schéma absent). */
  panne: Error | null = null;
  selects = 0;

  prepare(requete: string) {
    const sql = requete.replace(/\s+/g, " ").trim();
    const base = this;
    let bindings: unknown[] = [];
    const statement = {
      bind(...valeurs: unknown[]) {
        bindings = valeurs;
        return statement;
      },
      async first<T>(): Promise<T | null> {
        if (base.panne) throw base.panne;
        if (!/^SELECT .+ FROM organizations WHERE id = \?$/.test(sql)) {
          throw new Error(`FauxD1 : SELECT non gere → « ${sql} ».`);
        }
        base.selects += 1;
        return (base.lignes.get(String(bindings[0])) as T | undefined) ?? null;
      },
      async all() {
        throw new Error("FauxD1 : all() non attendu sur ce chemin.");
      },
      async run() {
        throw new Error("FauxD1 : aucune ÉCRITURE n'est attendue sur ce chemin.");
      },
    };
    return statement;
  }
}

describe("sessionEncoreValide", () => {
  const session = { orgId: ORG, emisA: T0 };

  it("accepte quand la base ne sait rien du locataire", () => {
    // L'état en base ne peut que RETIRER un accès, jamais en accorder un.
    expect(sessionEncoreValide(session, null)).toBe(true);
  });

  it("accepte un cookie de la génération courante", () => {
    expect(sessionEncoreValide(session, { connectedAt: T0, revokedAt: null })).toBe(true);
  });

  it("refuse un cookie antérieur au dernier consentement", () => {
    expect(sessionEncoreValide(session, { connectedAt: T0 + 1, revokedAt: null })).toBe(false);
  });

  it("refuse toute session d'une organisation actuellement révoquée", () => {
    expect(sessionEncoreValide(session, { connectedAt: T0, revokedAt: T0 })).toBe(false);
    expect(sessionEncoreValide(session, { connectedAt: null, revokedAt: T0 - 1 })).toBe(false);
  });

  it("laisse passer après une reconnexion postérieure à la révocation", () => {
    // Cas du DAF qui débranche puis rebranche : son cookie NEUF doit vivre.
    expect(
      sessionEncoreValide({ orgId: ORG, emisA: T0 + 10 }, { connectedAt: T0 + 10, revokedAt: T0 }),
    ).toBe(true);
  });
});

describe("lireSession — génération", () => {
  const requete = (cookie: string) => ({
    headers: { get: (nom: string) => (nom.toLowerCase() === "cookie" ? cookie : null) },
  });
  const global = globalThis as { ARGENTIER_DB?: unknown };
  let db: FauxD1;

  beforeEach(() => {
    db = new FauxD1();
    global.ARGENTIER_DB = db;
  });

  afterEach(() => {
    delete global.ARGENTIER_DB;
  });

  /** En-tête Cookie portant une session signée à `emisA`. */
  async function cookieEmisA(emisA: number): Promise<string> {
    return `${NOM_COOKIE_SESSION}=${await signerSession(ORG, emisA)}`;
  }

  function organisation(surcharge: Partial<LigneOrg> = {}): void {
    db.lignes.set(ORG, {
      id: ORG,
      qonto_org_id: "qonto-org-1",
      legal_name: "MAMFORMA",
      created_at: T0,
      connected_at: T0,
      revoked_at: null,
      ...surcharge,
    });
  }

  it("accepte le cookie émis au moment du consentement", async () => {
    organisation({ connected_at: T0 });

    await expect(lireSession(requete(await cookieEmisA(T0)), T0 + 1000)).resolves.toEqual({
      orgId: ORG,
      emisA: T0,
    });
    expect(db.selects).toBe(1);
  });

  it("REFUSE le cookie capturé avant la révocation, une fois le compte reconnecté", async () => {
    // Le scénario complet de l'audit :
    //  1. la victime connecte son compte à T0, son cookie C part ;
    //  2. un tiers obtient C (profil partagé, export HAR, log de proxy) ;
    //  3. la victime clique « débrancher » : jetons supprimés, revoked_at écrit ;
    //  4. la victime se reconnecte 3 jours plus tard : MÊME clé de locataire
    //     (deriverOrgId est déterministe), jetons neufs rangés dessous ;
    //  5. le tiers rejoue C — toujours signé, toujours dans ses 30 jours.
    const capture = await cookieEmisA(T0);
    const reconnexion = T0 + 3 * 86_400_000;
    organisation({ connected_at: reconnexion, revoked_at: null });

    // Avant correctif : la session était rendue, et /api/analyze servait le
    // solde, la raison sociale et 60 jours de transactions de la victime.
    await expect(lireSession(requete(capture), reconnexion + 1000)).resolves.toBeNull();
  });

  it("refuse toute session pendant que l'accès est révoqué", async () => {
    const cookie = await cookieEmisA(T0);
    organisation({ connected_at: T0, revoked_at: T0 + 60_000 });

    // `revoked_at` était écrit par la route de révocation et relu par personne.
    await expect(lireSession(requete(cookie), T0 + 120_000)).resolves.toBeNull();
  });

  it("laisse la RÉVOCATION lire un cookie de génération périmée", async () => {
    // Sinon on ne pourrait plus débrancher un compte précisément quand il le faut.
    const capture = await cookieEmisA(T0);
    organisation({ connected_at: T0 + 5_000, revoked_at: null });

    await expect(lireSessionSignee(requete(capture), T0 + 6_000)).resolves.toEqual({
      orgId: ORG,
      emisA: T0,
    });
  });

  it("accepte quand l'organisation est inconnue de la base", async () => {
    // Base provisionnée, locataire jamais persisté (écriture D1 tombée au
    // callback) : aucune révocation n'a pu y être écrite, donc rien à opposer.
    await expect(lireSession(requete(await cookieEmisA(T0)), T0)).resolves.toMatchObject({
      orgId: ORG,
    });
  });

  it("accepte quand le schéma n'a jamais été appliqué", async () => {
    db.panne = new Error("D1_ERROR: no such table: organizations");

    await expect(lireSession(requete(await cookieEmisA(T0)), T0)).resolves.toMatchObject({
      orgId: ORG,
    });
  });

  it("laisse remonter toute AUTRE panne de base plutôt que de conclure « c'est bon »", async () => {
    db.panne = new Error("D1_ERROR: database is locked");

    await expect(lireSession(requete(await cookieEmisA(T0)), T0)).rejects.toThrow(/locked/);
  });

  it("ne consulte pas la base quand le cookie est déjà invalide", async () => {
    const altere = `${NOM_COOKIE_SESSION}=v1.charge-bidon.signature-bidon`;

    await expect(lireSession(requete(altere), T0)).resolves.toBeNull();
    expect(db.selects).toBe(0);
  });
});

describe("lireCookie", () => {
  it("ne confond pas un cookie avec un autre dont il est le suffixe", () => {
    expect(lireCookie("autre_argentier_session=piege; argentier_session=vrai", NOM_COOKIE_SESSION)).toBe(
      "vrai",
    );
  });

  it("décode les valeurs pourcent-encodées", () => {
    expect(lireCookie("x=a%20b", "x")).toBe("a b");
  });

  it("rend null sur un en-tête absent ou sans la clé", () => {
    expect(lireCookie(null, "x")).toBeNull();
    expect(lireCookie("y=1", "x")).toBeNull();
  });
});

describe("options de cookie", () => {
  it("verrouille le cookie de session (httpOnly, Secure, Lax, 30 jours)", () => {
    const options = optionsCookieSession();
    expect(options.httpOnly).toBe(true);
    expect(options.secure).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/");
    expect(options.maxAge).toBe(DUREE_SESSION_SECONDES);
  });

  it("limite les cookies OAuth au chemin du flux et à 10 minutes", () => {
    const options = optionsCookieOAuth();
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe(CHEMIN_COOKIES_OAUTH);
    expect(options.maxAge).toBe(600);
  });

  it("efface avec une durée nulle, sur la même portée", () => {
    expect(optionsEffacement("/").maxAge).toBe(0);
    expect(optionsEffacement(CHEMIN_COOKIES_OAUTH).path).toBe(CHEMIN_COOKIES_OAUTH);
  });

  it("ne retire le drapeau Secure qu'en développement local en clair", () => {
    process.env.ARGENTIER_BASE_URL = "http://localhost:3000";
    expect(optionsCookieSession().secure).toBe(false);

    process.env.ARGENTIER_BASE_URL = "https://getargentier.com";
    expect(optionsCookieSession().secure).toBe(true);
  });
});

describe("deriverOrgId", () => {
  it("est stable pour une même organisation Qonto", async () => {
    await expect(deriverOrgId("croissant-9134")).resolves.toBe(
      await deriverOrgId("croissant-9134"),
    );
  });

  it("sépare deux organisations différentes", async () => {
    expect(await deriverOrgId("org-a")).not.toBe(await deriverOrgId("org-b"));
  });

  it("ne laisse pas remonter à l'identifiant Qonto", async () => {
    const derive = await deriverOrgId("croissant-9134");
    expect(derive.startsWith("org_")).toBe(true);
    expect(derive).not.toContain("croissant");
    expect(derive).not.toContain("9134");
  });

  it("change si le secret change (une rotation invalide les sessions)", async () => {
    const avant = await deriverOrgId("croissant-9134");
    process.env.ARGENTIER_SESSION_SECRET = AUTRE_SECRET;
    expect(await deriverOrgId("croissant-9134")).not.toBe(avant);
  });

  it("refuse un identifiant Qonto vide", async () => {
    await expect(deriverOrgId("  ")).rejects.toThrow(/vide/);
  });
});

describe("egalTempsConstant", () => {
  // Titre corrigé après l'audit. L'ancien (« compare sans court-circuit sur la
  // longueur ni le contenu ») affirmait une propriété que le code n'a pas et que
  // ce test ne mesure pas : `egalTempsConstant` court-circuite bel et bien sur
  // la longueur, et quatre assertions booléennes ne prouvent aucune propriété
  // temporelle — elles passeraient sur un `a === b` naïf, c'est-à-dire sur
  // l'implémentation que cette fonction existe pour éviter. Ce qui EST vérifié
  // ici, c'est le résultat ; la propriété temporelle, elle, est documentée et
  // argumentée dans session.ts (la longueur fuit volontairement).
  it("rend le bon booléen : égalité, un caractère près, longueurs différentes, vide", () => {
    expect(egalTempsConstant("abcdef", "abcdef")).toBe(true);
    expect(egalTempsConstant("abcdef", "abcdeg")).toBe(false);
    expect(egalTempsConstant("abcdef", "abcde")).toBe(false);
    expect(egalTempsConstant("", "")).toBe(true);
  });

  it("parcourt toute la chaîne : un écart au dernier caractère est vu comme au premier", () => {
    const reference = "a".repeat(64);
    expect(egalTempsConstant(reference, `b${reference.slice(1)}`)).toBe(false);
    expect(egalTempsConstant(reference, `${reference.slice(0, -1)}b`)).toBe(false);
  });
});
