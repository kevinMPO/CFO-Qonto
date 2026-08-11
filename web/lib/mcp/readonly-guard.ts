// ---------------------------------------------------------------------------
// Allowlist read-only Qonto — LA frontière de sécurité du produit.
//
// Le jeton OAuth obtenu via mcp.qonto.com porte des scopes d'ÉCRITURE qu'on ne
// peut pas refuser : le serveur d'autorisation ignore le paramètre `scope`
// envoyé et impose sa propre liste (request_transfers.write, card.write…).
// Autrement dit, la lecture seule n'est plus garantie par le jeton : elle est
// garantie ICI, et nulle part ailleurs. Ce module est le seul rempart entre
// Argentier et un mouvement d'argent (règle non négociable n°1 du CLAUDE.md).
//
// Deux verrous cumulatifs, en « deny by default » :
//   (a) méthode HTTP — GET seul, HEAD toléré. Tout le reste est rejeté.
//   (b) chemin — liste blanche exhaustive de motifs de la Business API. Un
//       chemin absent de la liste est rejeté MÊME en GET. Jamais de blacklist :
//       une blacklist oublie toujours un endpoint, une allowlist non.
//
// Règle d'or : on n'ajoute JAMAIS un motif dans `CHEMINS_AUTORISES` sans qu'il
// soit strictement en lecture. Le test `__tests__/readonly-guard.test.ts` fige
// la liste caractère par caractère : toute modification fait échouer la suite,
// bruyamment. C'est voulu — c'est le point de contrôle humain.
// ---------------------------------------------------------------------------

/** Longueur maximale d'un chemin accepté (garde-fou anti-abus). */
const LONGUEUR_MAX = 2048;

/** Méthodes HTTP tolérées. GET lit, HEAD ne rapatrie même pas le corps. */
export const METHODES_AUTORISEES = Object.freeze(["GET", "HEAD"] as const);

/**
 * Liste blanche des chemins de la Business API Qonto (base `/v2` exclue).
 * `:id` désigne un unique segment d'identifiant (UUID ou slug).
 *
 * Volontairement ABSENTS, même s'ils se lisent en GET :
 *  - `/requests`   : surface d'approbation des virements, hors périmètre.
 *  - `/beneficiaries`, `/external_transfers` : surface de paiement.
 *  - `/client_invoices`, `/supplier_invoices` : hors périmètre de l'audit,
 *    et jumelés à des endpoints d'écriture faciles à atteindre par erreur.
 * Ne pas les rajouter « au cas où » : chaque ligne ici élargit la surface.
 */
export const CHEMINS_AUTORISES = Object.freeze([
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
] as const);

/** Un segment de chemin sain : lettres, chiffres, tiret, souligné. Rien d'autre. */
const MOTIF_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Un chemin sain dans son ensemble. Ce seul motif neutralise, avant même de
 * regarder l'allowlist : le chemin vide, `/`, la barre finale, `..`, `//`,
 * `\`, les espaces, les caractères de contrôle, le `#`, et tout ce qui est
 * pourcent-encodé (donc `%2e%2e%2f`) — un vrai chemin Qonto n'en a pas besoin.
 * Un chemin absolu (`https://evil.test/x`) échoue faute de `/` initial.
 */
const MOTIF_CHEMIN = /^(?:\/[A-Za-z0-9_-]{1,128})+$/;

/**
 * Caractères tolérés dans la query string. Le `%` est admis (les valeurs sont
 * pourcent-encodées par URLSearchParams) mais la chaîne est ensuite DÉCODÉE et
 * re-contrôlée : voir `analyserQuery`. Ni `/`, ni `?`, ni `#`, ni `\`.
 */
const MOTIF_QUERY = /^[A-Za-z0-9_.\-=&%:,+~*]*$/;

/** Séquences interdites une fois la query entièrement décodée. */
const SEQUENCES_INTERDITES = Object.freeze(["/", "\\", "?", "#", ".."] as const);

/** La chaîne contient-elle un caractère de contrôle (octet nul, CR/LF…) ? */
function contientControle(valeur: string): boolean {
  for (let i = 0; i < valeur.length; i++) {
    const code = valeur.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Allowlist précompilée en segments, une fois pour toutes au chargement. */
const CHEMINS_COMPILES: ReadonlyArray<readonly string[]> = CHEMINS_AUTORISES.map(
  (motif) => Object.freeze(motif.slice(1).split("/")),
);

/**
 * Erreur levée quand une requête sort du périmètre lecture seule.
 * Elle n'est jamais rattrapable « par erreur » : la seule bonne réaction est
 * de corriger l'appelant.
 */
export class ReadOnlyViolationError extends Error {
  /** Méthode HTTP fautive, telle que fournie par l'appelant. */
  readonly method: string;
  /** Chemin fautif, tel que fourni par l'appelant. */
  readonly path: string;
  /** Motif du refus, en français. */
  readonly raison: string;

  constructor(method: string, path: string, raison: string) {
    super(
      `Violation lecture seule Qonto : « ${method} ${path} » refusé — ${raison}. ` +
        `Seules les opérations de la liste blanche read-only sont autorisées.`,
    );
    this.name = "ReadOnlyViolationError";
    this.method = method;
    this.path = path;
    this.raison = raison;
  }
}

/**
 * Nombre maximal de passes de décodage. Une query légitime se stabilise en
 * DEUX passes (une qui décode, une qui confirme) ; trois laisse de la marge.
 */
const PASSES_DECODAGE_MAX = 3;

/**
 * Décode une chaîne pourcent-encodée jusqu'à stabilité (3 passes max), pour
 * démasquer le double encodage (`%252e%252e%252f` → `%2e%2e%2f` → `../`).
 *
 * Renvoie `null` dans DEUX cas, tous deux traités comme un refus :
 *  - l'encodage est malformé (`%zz`, `%2`) — ce n'est pas une donnée à
 *    interpréter ;
 *  - l'encodage ne se stabilise pas en `PASSES_DECODAGE_MAX` passes. Rendre
 *    ici la valeur partiellement décodée serait un « fail open » : un `../`
 *    encodé quatre fois ressortirait encore masqué, donc jugé sain par
 *    `SEQUENCES_INTERDITES`. Un empilement d'encodages plus profond que ce
 *    qu'une query Qonto peut légitimement porter est une anomalie, et une
 *    anomalie se refuse (« deny by default », cf. en-tête du module).
 */
function decoderEnProfondeur(valeur: string): string | null {
  let courant = valeur;
  for (let passe = 0; passe < PASSES_DECODAGE_MAX; passe++) {
    let suivant: string;
    try {
      suivant = decodeURIComponent(courant);
    } catch {
      return null;
    }
    if (suivant === courant) return courant;
    courant = suivant;
  }
  return null;
}

/** Contrôle de la query string. Renvoie le motif de refus, ou `null` si saine. */
function analyserQuery(query: string): string | null {
  if (query === "") return null;
  if (query.includes("?")) {
    return "paramètres de requête contenant un second « ? »";
  }
  if (!MOTIF_QUERY.test(query)) {
    return `paramètres de requête « ${query} » : caractère interdit`;
  }

  const decode = decoderEnProfondeur(query);
  if (decode === null) {
    return `paramètres de requête « ${query} » : encodage pourcent invalide, ou empilé sur plus de ${PASSES_DECODAGE_MAX} niveaux`;
  }
  if (contientControle(decode)) {
    return `paramètres de requête « ${query} » : caractère de contrôle encodé`;
  }
  for (const sequence of SEQUENCES_INTERDITES) {
    if (decode.includes(sequence)) {
      return `paramètres de requête « ${query} » : séquence « ${sequence} » interdite une fois décodée (tentative d'injection de chemin)`;
    }
  }
  return null;
}

/** Un chemin découpé correspond-il au motif d'allowlist donné ? */
function correspond(motif: readonly string[], segments: readonly string[]): boolean {
  if (motif.length !== segments.length) return false;
  return motif.every((attendu, i) =>
    attendu.startsWith(":")
      ? MOTIF_SEGMENT.test(segments[i])
      : // Comparaison SENSIBLE À LA CASSE : « /TRANSACTIONS » n'est pas
        // « /transactions ». On ne normalise rien, on refuse.
        attendu === segments[i],
  );
}

/**
 * Cœur de la vérification. Renvoie le motif du refus en français, ou `null`
 * si l'opération est autorisée. Pure : n'écrit rien, ne lève rien.
 */
function analyser(method: string, path: string): string | null {
  if (typeof method !== "string" || method.trim() === "") {
    return "méthode HTTP absente ou invalide";
  }
  const methode = method.trim().toUpperCase();
  if (!(METHODES_AUTORISEES as readonly string[]).includes(methode)) {
    return `méthode « ${methode} » interdite (seuls GET et HEAD le sont)`;
  }

  if (typeof path !== "string" || path === "") {
    return "chemin absent ou vide";
  }
  if (path.length > LONGUEUR_MAX) {
    return `chemin trop long (${path.length} caractères, maximum ${LONGUEUR_MAX})`;
  }

  const coupure = path.indexOf("?");
  const chemin = coupure === -1 ? path : path.slice(0, coupure);
  const query = coupure === -1 ? "" : path.slice(coupure + 1);

  if (!MOTIF_CHEMIN.test(chemin)) {
    return `chemin « ${chemin} » malformé (attendu : /segment[/segment], caractères A-Z a-z 0-9 _ -)`;
  }

  const refusQuery = analyserQuery(query);
  if (refusQuery !== null) return refusQuery;

  const segments = chemin.slice(1).split("/");
  const autorise = CHEMINS_COMPILES.some((motif) => correspond(motif, segments));
  if (!autorise) {
    return `chemin « ${chemin} » hors de la liste blanche lecture seule`;
  }

  return null;
}

/**
 * Prédicat pur : cette opération est-elle dans le périmètre lecture seule ?
 * N'écrit RIEN dans la console et ne lève rien — c'est `assertReadOnly` qui
 * fait du bruit. Utile pour tester ou filtrer sans provoquer d'incident.
 */
export function isAllowed(method: string, path: string): boolean {
  return analyser(method, path) === null;
}

/**
 * Barrière obligatoire avant TOUT appel réseau vers Qonto.
 * Lève `ReadOnlyViolationError` et journalise en `console.error` : un refus
 * doit être visible dans les logs, pas silencieusement rattrapé.
 */
export function assertReadOnly(method: string, path: string): void {
  const raison = analyser(method, path);
  if (raison === null) return;

  const methodeAffichee = typeof method === "string" ? method : String(method);
  const cheminAffiche = typeof path === "string" ? path : String(path);

  console.error(
    `[argentier][read-only] REFUS « ${methodeAffichee} ${cheminAffiche} » — ${raison}.`,
  );
  throw new ReadOnlyViolationError(methodeAffichee, cheminAffiche, raison);
}
