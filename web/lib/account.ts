// ---------------------------------------------------------------------------
// account.ts — client des comptes utilisateurs Argentier (front → Worker).
//
// Parle au Worker Cloudflare (`/auth/*`), déjà déployé : inscription, connexion,
// session. Le mot de passe est CHOISI par l'utilisateur et n'est JAMAIS renvoyé
// ni envoyé par email — le Worker le hache (PBKDF2) et rend un jeton de session
// (256 bits, TTL 30 j). Ce module ne stocke que ce jeton, côté navigateur.
//
// Le jeton de compte est DISTINCT de la session OAuth Qonto (cookie Next) : créer
// un compte est l'étape d'onboarding AVANT de connecter Qonto. La sécurité de la
// connexion bancaire reste, elle, portée par l'OAuth + SCA de Qonto.
// ---------------------------------------------------------------------------

const AUTH_BASE = "https://argentier-mcp.bonjour-e83.workers.dev";
const TOKEN_KEY = "argentier-token";

export interface Account {
  email: string;
  nom: string;
  prenom: string;
  tel: string;
}

export interface SignupInput {
  email: string;
  tel: string;
  nom: string;
  prenom: string;
  password: string;
  cgv: boolean;
}

export type AuthResult =
  | { ok: true; user: Account }
  | { ok: false; error: string };

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* stockage indisponible — la session ne survivra pas au rechargement */
  }
}
export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* noop */
  }
}

async function post(path: string, body: unknown): Promise<AuthResult> {
  let data: { ok?: boolean; error?: string; token?: string; user?: Account };
  try {
    const res = await fetch(`${AUTH_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    data = await res.json();
  } catch {
    return { ok: false, error: "network" };
  }
  if (!data.ok || !data.token || !data.user) {
    return { ok: false, error: data.error || "unknown" };
  }
  setToken(data.token);
  return { ok: true, user: data.user };
}

export function signup(input: SignupInput): Promise<AuthResult> {
  return post("/auth/signup", {
    email: input.email.trim().toLowerCase(),
    tel: input.tel.trim(),
    nom: input.nom.trim(),
    prenom: input.prenom.trim(),
    password: input.password,
    cgv: input.cgv,
  });
}

export function login(email: string, password: string): Promise<AuthResult> {
  return post("/auth/login", { email: email.trim().toLowerCase(), password });
}

/** Rétablit la session au chargement : `null` = pas de session valide. */
export async function me(): Promise<Account | null> {
  const token = getToken();
  if (!token) return null;
  try {
    const res = await fetch(`${AUTH_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as { ok?: boolean; user?: Account };
    if (data.ok && data.user) return data.user;
  } catch {
    /* réseau — on ne connecte pas, sans effacer le jeton (peut-être transitoire) */
  }
  return null;
}

export async function logout(): Promise<void> {
  const token = getToken();
  clearToken();
  if (!token) return;
  try {
    await fetch(`${AUTH_BASE}/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    /* le jeton local est déjà effacé : la déconnexion côté client est faite */
  }
}
