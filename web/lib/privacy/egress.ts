// ---------------------------------------------------------------------------
// Filtre de sortie anti-PII — application de la règle 3 (« zéro PII vers le web »).
//
// Ce module est la DERNIÈRE barrière avant qu'un octet ne quitte Argentier vers
// un tiers (Linkup, Bright Data, tout `fetch` sortant). Vers l'extérieur, seuls
// le NOM DU MARCHAND et la CATÉGORIE ont le droit de sortir. Jamais d'IBAN, de
// BIC, de `transaction_id`, de numéro de compte, d'e-mail, de téléphone, de PAN
// ni de jeton d'authentification.
//
// Quatre outils, du plus contraint au plus général :
//   1. `sanitizeMerchantQuery` — construit la SEULE charge utile autorisée.
//   2. `scanForPii`            — inspecte récursivement n'importe quelle valeur.
//   3. `assertNoPii`           — lève (fail-closed) si quoi que ce soit est trouvé.
//   4. `redactForLogs`         — copie profonde caviardée, pour logs et erreurs.
//
// Deux invariants de sécurité, tenus par les tests :
//   • Un signalement ne contient JAMAIS la valeur détectée — ni son type, ni son
//     chemin, ni le message d'erreur ne doivent fuiter la donnée (un chemin peut
//     contenir un nom de clé : il est donc caviardé lui aussi).
//   • En cas de doute (structure trop profonde, cycle), on signale plutôt que de
//     se taire : le filtre échoue bruyamment, jamais silencieusement.
//
// Bibliothèque PURE : aucune dépendance à Qonto, à Next.js ni au runtime. Elle
// tourne telle quelle sur Cloudflare Workers.
// ---------------------------------------------------------------------------

/** Types de signalement produits par le détecteur. */
export type PiiType =
  | "IBAN"
  | "BIC"
  | "UUID"
  | "PAN"
  | "EMAIL"
  | "TELEPHONE_FR"
  /** Le NOM de la clé est sensible (`iban`, `access_token`…), quelle que soit sa valeur. */
  | "CLE_SENSIBLE"
  /** Sentinelle : sous-arbre non inspecté (trop profond / cycle). On échoue fermé. */
  | "INSPECTION_INCOMPLETE";

/**
 * Un signalement. Volontairement SANS la valeur détectée : on ne recopie jamais
 * une PII dans un objet destiné aux logs ou aux messages d'erreur.
 */
export interface PiiFinding {
  /** Chemin dans la valeur inspectée : `$`, `$.debtor.iban`, `$.items[2]`. */
  readonly path: string;
  /** Nature de ce qui a été détecté. */
  readonly type: PiiType;
  /** `value` = trouvé dans un contenu ; `key` = trouvé dans un nom de clé. */
  readonly origin: "value" | "key";
}

/** Charge utile maximale autorisée vers un tiers (règle 3). */
export interface SanitizedMerchantQuery {
  readonly merchant: string;
  readonly category: string;
}

/** Longueur max du nom de marchand transmis à un tiers. */
export const MAX_LONGUEUR_MARCHAND = 64;
/** Longueur max de la catégorie transmise à un tiers. */
export const MAX_LONGUEUR_CATEGORIE = 48;
/** Profondeur d'inspection maximale : au-delà, on signale `INSPECTION_INCOMPLETE`. */
export const PROFONDEUR_MAX = 32;

/** Marqueur posé à la place d'une valeur dont la CLÉ est sensible. */
const MARQUEUR_MASQUE = "[MASQUÉ]";
/** Marqueur posé à la place d'un sous-arbre non inspecté. */
const MARQUEUR_INCOMPLET = "[INSPECTION_INCOMPLETE]";
/** Marqueur posé à la place d'une référence circulaire. */
const MARQUEUR_CYCLE = "[CYCLE]";

// ---------------------------------------------------------------------------
// Erreur dédiée
// ---------------------------------------------------------------------------

/** Levée par `assertNoPii`. Porte les signalements, jamais les valeurs. */
export class PiiDetectedError extends Error {
  readonly findings: readonly PiiFinding[];
  readonly contexte: string;

  constructor(message: string, findings: readonly PiiFinding[], contexte: string) {
    super(message);
    this.name = "PiiDetectedError";
    this.findings = findings;
    this.contexte = contexte;
  }
}

// ---------------------------------------------------------------------------
// Détecteurs de motifs (sur chaîne)
// ---------------------------------------------------------------------------

/** Un segment de chaîne reconnu comme PII. */
interface Span {
  readonly start: number;
  readonly end: number;
  readonly type: PiiType;
}

/**
 * Longueurs officielles d'IBAN par pays. Sert à découper proprement un IBAN
 * collé à du texte (« FR76 … 189 chez BNP ») et à durcir la détection.
 */
const LONGUEURS_IBAN: Record<string, number> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29,
  BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29,
  ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28,
  HR: 21, HU: 28, IE: 22, IL: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28,
  LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31,
  MU: 30, NL: 18, NO: 15, PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22,
  SA: 24, SE: 24, SI: 19, SK: 24, SM: 27, TN: 24, TR: 26, UA: 29, VG: 24, XK: 20,
};

/** Codes pays ISO 3166-1 alpha-2 assignés — durcit la détection de BIC. */
const CODES_PAYS = new Set(
  ("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ " +
    "BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM " +
    "DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS " +
    "GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN " +
    "KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ " +
    "MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM " +
    "PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV " +
    "SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI " +
    "VN VU WF WS XK YE YT ZA ZM ZW").split(" "),
);

/**
 * Mots courants tout en majuscules qui ressemblent structurellement à un BIC
 * (8 lettres dont un faux code pays en position 5-6). Sans cette liste, un
 * libellé de marchand en capitales (« BUSINESS », « LOGICIEL ») serait signalé.
 */
const FAUX_BIC = new Set([
  "VIREMENT", "PAIEMENT", "BUSINESS", "SOFTWARE", "HARDWARE", "STANDARD", "DELIVERY",
  "CUSTOMER", "PLATFORM", "SOLUTION", "DOCUMENT", "LOGICIEL", "CLEANING", "TRAINING",
  "SHIPPING", "ADVISORY", "TELECOMS", "PARTNERS", "SUPPLIER", "MOBILITY", "ANALYSER",
  "PRESTATION", "ABONNEMENTS", "REMBOURSER", "COMMERCIAL",
]);

const CANDIDAT_IBAN = /(?<![A-Za-z0-9])[A-Za-z]{2}[0-9]{2}(?:[ \u00a0]?[A-Za-z0-9]){11,32}/g;
const CANDIDAT_UUID =
  /(?<![0-9A-Za-z-])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9A-Za-z-])/g;
const CANDIDAT_EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}(?![A-Za-z0-9-])/g;
const CANDIDAT_PAN = /(?<![0-9])[0-9](?:[ -]?[0-9]){12,18}(?![0-9])/g;
const CANDIDAT_BIC =
  /(?<![A-Za-z0-9])[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?(?![A-Za-z0-9])/g;
// Le séparateur des paires est CAPTURÉ puis imposé identique aux suivantes
// (backréférence \1) : sans cela, « 2026-08-11 2026-08-12 » passerait pour un
// numéro de téléphone en piochant « 08-11 2026-08 ».
const CANDIDAT_TELEPHONE_FR =
  /(?<![0-9+])(?:(?:\+|00)33[ .-]?(?:\(0\)[ .-]?)?[1-9]|0[1-9])([ .-]?)[0-9]{2}(?:\1[0-9]{2}){3}(?![0-9])/g;
// L'indicatif « +33 » / « 0033 » est à lui seul un signal sans ambiguïté :
// on y tolère donc des séparateurs panachés, qu'aucune date ne peut produire.
const CANDIDAT_TELEPHONE_FR_INDICATIF =
  /(?<![0-9+])(?:\+|00)33[ .()-]{0,4}[1-9](?:[ .-]?[0-9]{2}){4}(?![0-9])/g;

/** Contexte immédiat annonçant un BIC (« BIC : … », « swift= … »). */
const AVANT_BIC = /(?:bic|swift)\W{0,8}$/i;

/** Reste de la division modulo 97 d'un IBAN compacté (norme ISO 13616). */
function mod97(iban: string): number {
  const reordonne = iban.slice(4) + iban.slice(0, 4);
  let reste = 0;
  for (let i = 0; i < reordonne.length; i++) {
    const code = reordonne.charCodeAt(i);
    // A→10 … Z→35 ; les chiffres gardent leur valeur.
    const valeur = code >= 65 ? code - 55 : code - 48;
    reste = (valeur > 9 ? reste * 100 + valeur : reste * 10 + valeur) % 97;
  }
  return reste;
}

/** Test de Luhn — limite drastiquement les faux positifs sur les PAN. */
function luhn(chiffres: string): boolean {
  let somme = 0;
  let double = false;
  for (let i = chiffres.length - 1; i >= 0; i--) {
    let d = chiffres.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    somme += d;
    double = !double;
  }
  return somme % 10 === 0;
}

function compterChiffres(texte: string): number {
  let n = 0;
  for (let i = 0; i < texte.length; i++) {
    const c = texte.charCodeAt(i);
    if (c >= 48 && c <= 57) n++;
  }
  return n;
}

/**
 * IBAN, avec ou sans espaces, en minuscules ou en majuscules, éventuellement
 * collé à du texte. On valide par la clé modulo 97 ; à défaut, une forme
 * compacte de la bonne longueur pays et majoritairement chiffrée suffit (un
 * IBAN anonymisé ou mal recopié reste une PII).
 */
function spansIban(texte: string): Span[] {
  const spans: Span[] = [];

  for (const m of texte.matchAll(CANDIDAT_IBAN)) {
    const brut = m[0];
    const debut = m.index ?? 0;

    // Compactage + mémorisation de l'index d'origine de chaque caractère
    // conservé : c'est ce qui permet de rendre un span exact malgré les espaces.
    let compacte = "";
    const indexOrigine: number[] = [];
    for (let i = 0; i < brut.length; i++) {
      const c = brut[i];
      if (c === " " || c === "\u00a0") continue;
      compacte += c.toUpperCase();
      indexOrigine.push(debut + i);
    }

    const attendue = LONGUEURS_IBAN[compacte.slice(0, 2)];
    const longueurs: number[] = [];
    if (attendue !== undefined) {
      longueurs.push(attendue);
    } else {
      for (let l = Math.min(34, compacte.length); l >= 15; l--) longueurs.push(l);
    }

    for (const l of longueurs) {
      if (l < 15 || l > 34 || l > compacte.length) continue;
      const extrait = compacte.slice(0, l);
      if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(extrait)) break;

      const sansEspace = indexOrigine[l - 1] - indexOrigine[0] === l - 1;
      const plausible =
        mod97(extrait) === 1 ||
        (attendue !== undefined && sansEspace && compterChiffres(extrait) >= 10);

      if (plausible) {
        spans.push({ start: indexOrigine[0], end: indexOrigine[l - 1] + 1, type: "IBAN" });
        break;
      }
    }
  }

  return spans;
}

/** UUID (8-4-4-4-12) — les `transaction_id` Qonto en sont. */
function spansUuid(texte: string): Span[] {
  const spans: Span[] = [];
  for (const m of texte.matchAll(CANDIDAT_UUID)) {
    spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, type: "UUID" });
  }
  return spans;
}

function spansEmail(texte: string): Span[] {
  const spans: Span[] = [];
  for (const m of texte.matchAll(CANDIDAT_EMAIL)) {
    spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, type: "EMAIL" });
  }
  return spans;
}

/**
 * Numéro de carte (PAN) : 13 à 19 chiffres validés par Luhn. Si des séparateurs
 * sont présents, ils doivent former des groupes de 4 — sinon « 2026-08-11
 * 2026-08-12 » passerait pour une carte une fois sur dix.
 */
function spansPan(texte: string): Span[] {
  const spans: Span[] = [];

  for (const m of texte.matchAll(CANDIDAT_PAN)) {
    const brut = m[0];
    const chiffres = brut.replace(/[ -]/g, "");
    if (chiffres.length < 13 || chiffres.length > 19) continue;

    if (/[ -]/.test(brut)) {
      const groupes = brut.split(/[ -]/);
      const bienGroupe = groupes.every(
        (g, i) => (i === groupes.length - 1 ? g.length >= 1 && g.length <= 4 : g.length === 4),
      );
      if (!bienGroupe) continue;
    }

    if (!luhn(chiffres)) continue;
    spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + brut.length, type: "PAN" });
  }

  return spans;
}

/**
 * BIC/SWIFT. Heuristique volontairement prudente : la structure seule
 * (8 ou 11 caractères) confond trop de mots en capitales. On exige un code pays
 * réel, l'absence de la liste des faux amis, et l'un de ces trois indices :
 * le candidat est toute la valeur, il contient un chiffre, ou il est annoncé
 * par « BIC »/« SWIFT ». Les BIC transportés dans un champ nommé `bic` sont de
 * toute façon attrapés par la détection de clés sensibles.
 */
function spansBic(texte: string): Span[] {
  const spans: Span[] = [];
  const seul = texte.trim();

  for (const m of texte.matchAll(CANDIDAT_BIC)) {
    const brut = m[0];
    const debut = m.index ?? 0;
    if (!CODES_PAYS.has(brut.slice(4, 6))) continue;
    if (FAUX_BIC.has(brut)) continue;

    const indice =
      brut === seul || /[0-9]/.test(brut) || AVANT_BIC.test(texte.slice(0, debut));
    if (!indice) continue;

    spans.push({ start: debut, end: debut + brut.length, type: "BIC" });
  }

  return spans;
}

function spansTelephoneFr(texte: string): Span[] {
  const spans: Span[] = [];
  for (const motif of [CANDIDAT_TELEPHONE_FR, CANDIDAT_TELEPHONE_FR_INDICATIF]) {
    for (const m of texte.matchAll(motif)) {
      spans.push({
        start: m.index ?? 0,
        end: (m.index ?? 0) + m[0].length,
        type: "TELEPHONE_FR",
      });
    }
  }
  return spans;
}

/**
 * Détecteurs par ordre de PRIORITÉ décroissante : en cas de chevauchement, le
 * premier gagne (un IBAN n'est pas redécoupé en PAN, un UUID pas en carte).
 */
const DETECTEURS: ReadonlyArray<(texte: string) => Span[]> = [
  spansIban,
  spansUuid,
  spansEmail,
  spansPan,
  spansBic,
  spansTelephoneFr,
];

/** Tous les segments PII d'une chaîne, sans chevauchement, triés par position. */
function detecterSpans(texte: string): Span[] {
  if (!texte) return [];

  const retenus: Span[] = [];
  for (const detecteur of DETECTEURS) {
    for (const span of detecteur(texte)) {
      const chevauche = retenus.some((r) => span.start < r.end && r.start < span.end);
      if (!chevauche) retenus.push(span);
    }
  }

  return retenus.sort((a, b) => a.start - b.start);
}

/** Remplace chaque segment PII par son marqueur (`[IBAN]`, `[UUID]`…). */
function caviarderChaine(texte: string): string {
  const spans = detecterSpans(texte);
  if (spans.length === 0) return texte;

  let sortie = "";
  let curseur = 0;
  for (const span of spans) {
    sortie += texte.slice(curseur, span.start) + `[${span.type}]`;
    curseur = span.end;
  }
  return sortie + texte.slice(curseur);
}

/** Supprime purement et simplement les segments PII (pas de marqueur). */
function retirerPii(texte: string): string {
  const spans = detecterSpans(texte);
  if (spans.length === 0) return texte;

  let sortie = "";
  let curseur = 0;
  for (const span of spans) {
    sortie += texte.slice(curseur, span.start) + " ";
    curseur = span.end;
  }
  return sortie + texte.slice(curseur);
}

// ---------------------------------------------------------------------------
// Clés sensibles (détection par le NOM, indépendamment de la valeur)
// ---------------------------------------------------------------------------

/** `transaction_id`, `transactionId`, `TRANSACTION-ID` → `transactionid`. */
function normaliserCle(cle: string): string {
  return cle.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const CLES_SENSIBLES = new Set([
  "id", "ids", "uuid", "iban", "bic", "swift",
  "transactionid", "transactionids", "accountid", "accountids", "bankaccountid",
  "attachmentid", "attachmentids", "attachments", "attachment",
  "secretkey", "secret", "password", "passwd", "pwd", "login", "username",
  "authorization", "auth", "bearer", "accesstoken", "refreshtoken", "idtoken",
  "clientsecret", "apikey", "apitoken", "cookie", "setcookie", "sessionid",
  "email", "emails", "mail", "phone", "phonenumber", "telephone", "mobile",
  "address", "adresse", "firstname", "lastname", "fullname", "holdername",
  "beneficiary", "beneficiaryname", "counterparty", "accountnumber",
  "cardnumber", "pan", "cvv", "cvc", "birthdate", "dateofbirth", "ssn", "nir",
]);

const MOTIFS_CLES_SENSIBLES: readonly RegExp[] = [
  /(token|secret|password|passwd|apikey|credential|cookie|authorization|bearer|privatekey|signature)/,
  /^[a-z]*?(transaction|account|attachment|card|membership|organization|beneficiary|counterparty|client|user|customer|holder|payment|request|invoice|statement|label|team|session)ids?$/,
  /(iban|bic|swift)/,
  /(email|phone|telephone|mobile|address|adresse|birthdate)/,
];

/** Vrai si le NOM de la clé suffit à interdire la sortie de sa valeur. */
export function estCleSensible(cle: string): boolean {
  const n = normaliserCle(cle);
  if (n.length === 0) return false;
  if (CLES_SENSIBLES.has(n)) return true;
  return MOTIFS_CLES_SENSIBLES.some((motif) => motif.test(n));
}

// ---------------------------------------------------------------------------
// Parcours récursif
// ---------------------------------------------------------------------------

const IDENTIFIANT_SIMPLE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Chemin d'un enfant. Le nom de clé est CAVIARDÉ avant d'être concaténé : une
 * clé peut elle-même être un IBAN (`{"FR76…": 1}`), et un chemin finit dans les
 * messages d'erreur et les logs.
 */
function cheminEnfant(base: string, cle: string): string {
  const sure = caviarderChaine(cle);
  return IDENTIFIANT_SIMPLE.test(sure) ? `${base}.${sure}` : `${base}[${JSON.stringify(sure)}]`;
}

function estObjetSimple(valeur: unknown): valeur is Record<string, unknown> {
  if (typeof valeur !== "object" || valeur === null) return false;
  if (Array.isArray(valeur)) return false;
  if (valeur instanceof Date || valeur instanceof RegExp) return false;
  return true;
}

/**
 * Inspecte récursivement une valeur (objet, tableau, chaîne, nombre) et rend la
 * liste des PII trouvées. Ne rend JAMAIS les valeurs elles-mêmes : seulement le
 * chemin (caviardé) et le type.
 */
export function scanForPii(value: unknown): PiiFinding[] {
  const findings: PiiFinding[] = [];
  const vus = new WeakSet<object>();
  const deja = new Set<string>();

  const ajouter = (path: string, type: PiiType, origin: "value" | "key"): void => {
    const cle = `${path}|${type}|${origin}`;
    if (deja.has(cle)) return;
    deja.add(cle);
    findings.push({ path, type, origin });
  };

  const marcher = (valeur: unknown, chemin: string, profondeur: number): void => {
    if (valeur === null || valeur === undefined) return;

    if (typeof valeur === "string") {
      for (const span of detecterSpans(valeur)) ajouter(chemin, span.type, "value");
      return;
    }

    if (typeof valeur === "number" || typeof valeur === "bigint") {
      for (const span of detecterSpans(String(valeur))) ajouter(chemin, span.type, "value");
      return;
    }

    if (typeof valeur === "boolean" || typeof valeur === "function" || typeof valeur === "symbol") {
      return;
    }

    if (valeur instanceof Date || valeur instanceof RegExp) return;

    if (profondeur > PROFONDEUR_MAX) {
      // On n'a pas pu regarder : on échoue fermé plutôt que de laisser passer.
      ajouter(chemin, "INSPECTION_INCOMPLETE", "value");
      return;
    }

    if (typeof valeur === "object") {
      const objet = valeur as object;

      // Cycle : on ne surveille que les ANCÊTRES du chemin courant. Un même
      // sous-objet référencé deux fois côte à côte n'est pas un cycle et doit
      // être inspecté à chaque fois — sinon une PII partagée passerait.
      if (vus.has(objet)) {
        ajouter(chemin, "INSPECTION_INCOMPLETE", "value");
        return;
      }
      vus.add(objet);

      try {
        if (Array.isArray(valeur)) {
          valeur.forEach((element, i) => marcher(element, `${chemin}[${i}]`, profondeur + 1));
          return;
        }

        if (valeur instanceof Map || valeur instanceof Set) {
          // Structures non sérialisables en JSON : on inspecte quand même leur
          // contenu, une PII n'a pas besoin d'être sérialisable pour fuiter.
          const entrees =
            valeur instanceof Map
              ? [...valeur.entries()]
              : [...valeur].map((v) => ["", v] as [unknown, unknown]);

          entrees.forEach(([k, v], i) => {
            if (typeof k === "string" && k.length > 0) {
              const cheminCle = cheminEnfant(chemin, k);
              if (estCleSensible(k)) ajouter(cheminCle, "CLE_SENSIBLE", "key");
              for (const span of detecterSpans(k)) ajouter(cheminCle, span.type, "key");
            }
            marcher(v, `${chemin}[${i}]`, profondeur + 1);
          });
          return;
        }

        for (const [cle, sous] of Object.entries(valeur as Record<string, unknown>)) {
          const cheminSous = cheminEnfant(chemin, cle);
          if (estCleSensible(cle)) ajouter(cheminSous, "CLE_SENSIBLE", "key");
          for (const span of detecterSpans(cle)) ajouter(cheminSous, span.type, "key");
          marcher(sous, cheminSous, profondeur + 1);
        }
      } finally {
        vus.delete(objet);
      }
    }
  };

  marcher(value, "$", 0);
  return findings;
}

// ---------------------------------------------------------------------------
// Garde-fou (fail-closed) et caviardage
// ---------------------------------------------------------------------------

/** Nombre maximal de signalements détaillés dans un message d'erreur. */
const MAX_SIGNALEMENTS_MESSAGE = 8;

/**
 * Lève si la valeur contient la moindre PII. À appeler JUSTE AVANT tout `fetch`
 * sortant. Le message nomme le contexte et les types trouvés — jamais les
 * valeurs (le contexte lui-même est caviardé par précaution).
 */
export function assertNoPii(value: unknown, contexte = "sortie réseau"): void {
  const findings = scanForPii(value);
  if (findings.length === 0) return;

  const contexteSur = caviarderChaine(String(contexte));
  const detail = findings
    .slice(0, MAX_SIGNALEMENTS_MESSAGE)
    .map((f) => `${f.type} (${f.origin === "key" ? "clé" : "valeur"} ${f.path})`)
    .join(", ");
  const reste =
    findings.length > MAX_SIGNALEMENTS_MESSAGE
      ? ` … et ${findings.length - MAX_SIGNALEMENTS_MESSAGE} autre(s)`
      : "";

  const message =
    `PII détectée avant « ${contexteSur} » : ${findings.length} signalement(s) — ` +
    `${detail}${reste}. Rien n'a été transmis (règle 3 : zéro PII vers le web). ` +
    `Utilise redactForLogs() pour journaliser la charge utile.`;

  throw new PiiDetectedError(message, findings, contexteSur);
}

/**
 * Copie profonde caviardée, destinée aux logs et aux messages d'erreur : la
 * structure est préservée, chaque PII est remplacée par son marqueur
 * (`[IBAN]`, `[UUID]`…) et la valeur d'une clé sensible par `[MASQUÉ]`.
 *
 * Les NOMS de clés sensibles sont conservés (c'est la structure, elle est utile
 * au débogage) ; un nom de clé qui contient lui-même une PII est caviardé.
 */
export function redactForLogs(value: unknown): unknown {
  const vus = new WeakSet<object>();

  const copier = (valeur: unknown, profondeur: number): unknown => {
    if (valeur === null || valeur === undefined) return valeur;

    if (typeof valeur === "string") return caviarderChaine(valeur);

    if (typeof valeur === "number" || typeof valeur === "bigint") {
      const texte = String(valeur);
      const caviarde = caviarderChaine(texte);
      return caviarde === texte ? valeur : caviarde;
    }

    if (typeof valeur === "boolean") return valeur;
    if (typeof valeur === "function" || typeof valeur === "symbol") return `[${typeof valeur}]`;
    if (valeur instanceof Date) return new Date(valeur.getTime());
    if (valeur instanceof RegExp) return new RegExp(valeur.source, valeur.flags);

    if (profondeur > PROFONDEUR_MAX) return MARQUEUR_INCOMPLET;

    if (typeof valeur === "object") {
      const objet = valeur as object;
      // Même règle que le scanner : seuls les ancêtres comptent comme cycle.
      if (vus.has(objet)) return MARQUEUR_CYCLE;
      vus.add(objet);

      try {
        if (Array.isArray(valeur)) return valeur.map((e) => copier(e, profondeur + 1));

        if (valeur instanceof Map) {
          const sortie: Record<string, unknown> = {};
          let i = 0;
          for (const [k, v] of valeur.entries()) {
            const cle = typeof k === "string" ? caviarderChaine(k) : `[cle:${i}]`;
            sortie[cle] =
              typeof k === "string" && estCleSensible(k)
                ? MARQUEUR_MASQUE
                : copier(v, profondeur + 1);
            i++;
          }
          return sortie;
        }

        if (valeur instanceof Set) return [...valeur].map((e) => copier(e, profondeur + 1));

        const sortie: Record<string, unknown> = {};
        for (const [cle, sous] of Object.entries(valeur as Record<string, unknown>)) {
          sortie[caviarderChaine(cle)] = estCleSensible(cle)
            ? MARQUEUR_MASQUE
            : copier(sous, profondeur + 1);
        }
        return sortie;
      } finally {
        vus.delete(objet);
      }
    }

    return MARQUEUR_MASQUE;
  };

  return copier(value, 0);
}

// ---------------------------------------------------------------------------
// La seule charge utile autorisée vers un tiers
// ---------------------------------------------------------------------------

/** Caractères tolérés dans un nom de marchand ou une catégorie. */
const CARACTERES_AUTORISES = /[^\p{L}\p{N} &.,'’+()\/-]/gu;
/** Jetons qui sentent l'identifiant : longues suites de chiffres, hachages, tokens. */
const JETONS_IDENTIFIANTS = [
  /\b[\p{L}\p{N}]*[0-9]{6,}[\p{L}\p{N}]*\b/gu, // 6 chiffres consécutifs ou plus
  /\b[0-9a-fA-F]{16,}\b/g, // hachage / jeton hexadécimal
  /\b(?=[\p{L}\p{N}]{20,}\b)[\p{L}\p{N}]*[0-9][\p{L}\p{N}]*\b/gu, // jeton alphanumérique très long
];

/** Nettoie une chaîne destinée à sortir : PII retirée, identifiants retirés, tronquée. */
function nettoyerTexteSortant(brut: string, maxLongueur: number): string {
  let texte = brut.normalize("NFC");

  // 1. Caractères de contrôle et retours à la ligne → espace.
  texte = texte.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, " ");

  // 2. Segments reconnus comme PII → supprimés (pas de marqueur : on n'envoie
  //    pas « [IBAN] » à un moteur de recherche, on envoie un nom de marchand).
  texte = retirerPii(texte);

  // 3. Jetons qui ressemblent à des identifiants → supprimés.
  for (const motif of JETONS_IDENTIFIANTS) texte = texte.replace(motif, " ");

  // 4. Allowlist de caractères, puis normalisation des espaces.
  texte = texte.replace(CARACTERES_AUTORISES, " ").replace(/\s+/g, " ").trim();

  // 5. Troncature sur une frontière de mot quand c'est possible.
  if (texte.length > maxLongueur) {
    const coupe = texte.slice(0, maxLongueur);
    const dernierEspace = coupe.lastIndexOf(" ");
    texte = (dernierEspace > maxLongueur * 0.5 ? coupe.slice(0, dernierEspace) : coupe).trim();
  }

  // 6. Ponctuation résiduelle en bord de chaîne.
  return texte.replace(/^[\s.,'’+()\/-]+|[\s,'’+(\/-]+$/g, "").trim();
}

/**
 * Construit la SEULE charge utile autorisée vers un tiers (Linkup, Bright
 * Data…) : nom du marchand + catégorie, rien d'autre. Tout le reste est
 * jeté, pas masqué — un champ absent ne peut pas fuiter.
 *
 * Lève si le marchand est vide après nettoyage (il ne restait qu'un
 * identifiant : il n'y a alors rien de légitime à demander au tiers).
 */
export function sanitizeMerchantQuery(merchant: unknown, category?: unknown): SanitizedMerchantQuery {
  if (typeof merchant !== "string") {
    throw new TypeError("Marchand invalide : une chaîne est attendue avant tout appel sortant.");
  }

  const marchandPropre = nettoyerTexteSortant(merchant, MAX_LONGUEUR_MARCHAND);
  const categoriePropre =
    typeof category === "string" ? nettoyerTexteSortant(category, MAX_LONGUEUR_CATEGORIE) : "";

  if (marchandPropre.length === 0) {
    throw new Error(
      "Marchand vide après nettoyage anti-PII : rien n'est envoyé au tiers (règle 3).",
    );
  }

  const requete: SanitizedMerchantQuery = { merchant: marchandPropre, category: categoriePropre };

  // Ceinture et bretelles : ce qu'on s'apprête à rendre est re-vérifié. Si un
  // motif échappait au nettoyage, l'appel échoue ici plutôt que sur le réseau.
  assertNoPii(requete, "requête marchand sortante");

  return Object.freeze(requete);
}
