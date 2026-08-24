// ---------------------------------------------------------------------------
// Comptes utilisateurs — inscription / connexion sécurisées (Web Crypto only).
//
// Règles de sécurité (produit fintech qui se connecte à une banque) :
//   • Mot de passe JAMAIS stocké ni renvoyé en clair : PBKDF2-SHA256, 210k
//     itérations, sel aléatoire par utilisateur.
//   • JAMAIS de mot de passe envoyé par email. L'utilisateur le choisit et est
//     connecté immédiatement ; l'email (à venir) ne sert qu'à vérifier l'adresse.
//   • Session = jeton aléatoire 256 bits stocké en KV (TTL 30 j), révocable.
//   • Comparaison de hash en temps constant.
//
// Stockage : KV `WAITLIST` (partagée), préfixes `user:<email>` et `session:<token>`.
// ---------------------------------------------------------------------------

interface Env {
  WAITLIST: KVNamespace;
}

const ITERATIONS = 210_000;
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 jours

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

const enc = new TextEncoder();

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function derive(password: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: ITERATIONS, hash: "SHA-256" },
    key,
    256,
  );
  return bytesToB64(new Uint8Array(bits));
}

async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { salt: bytesToB64(salt), hash: await derive(password, salt) };
}
async function verifyPassword(password: string, saltB64: string, hashB64: string): Promise<boolean> {
  const hash = await derive(password, b64ToBytes(saltB64));
  return timingSafeEqual(hash, hashB64);
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function newToken(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

interface UserRecord {
  email: string;
  tel: string;
  nom: string;
  prenom: string;
  salt: string;
  hash: string;
  createdAt: string;
}
interface SafeUser {
  email: string;
  nom: string;
  prenom: string;
  tel: string;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function createSession(env: Env, email: string): Promise<string> {
  const token = newToken();
  await env.WAITLIST.put(
    `session:${token}`,
    JSON.stringify({ email, at: new Date().toISOString() }),
    { expirationTtl: SESSION_TTL },
  );
  return token;
}

function safe(u: UserRecord): SafeUser {
  return { email: u.email, nom: u.nom, prenom: u.prenom, tel: u.tel };
}

export async function handleSignup(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid_body" }, 400);
  }
  const email = String(body.email ?? "").trim().toLowerCase();
  const tel = String(body.tel ?? "").trim().slice(0, 40);
  const nom = String(body.nom ?? "").trim().slice(0, 80);
  const prenom = String(body.prenom ?? "").trim().slice(0, 80);
  const password = String(body.password ?? "");
  const cgv = body.cgv === true;

  if (!EMAIL_RE.test(email) || email.length > 200) return json({ ok: false, error: "invalid_email" }, 400);
  if (!nom || !prenom) return json({ ok: false, error: "missing_name" }, 400);
  if (password.length < 8 || password.length > 200) return json({ ok: false, error: "weak_password" }, 400);
  if (!cgv) return json({ ok: false, error: "cgv_required" }, 400);

  const existing = await env.WAITLIST.get(`user:${email}`);
  if (existing) return json({ ok: false, error: "email_taken" }, 409);

  const { salt, hash } = await hashPassword(password);
  const user: UserRecord = { email, tel, nom, prenom, salt, hash, createdAt: new Date().toISOString() };
  await env.WAITLIST.put(`user:${email}`, JSON.stringify(user));

  const token = await createSession(env, email);
  return json({ ok: true, token, user: safe(user) });
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid_body" }, 400);
  }
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!EMAIL_RE.test(email) || !password) return json({ ok: false, error: "invalid_credentials" }, 401);

  const raw = await env.WAITLIST.get(`user:${email}`);
  if (!raw) return json({ ok: false, error: "invalid_credentials" }, 401);
  const user = JSON.parse(raw) as UserRecord;

  const ok = await verifyPassword(password, user.salt, user.hash);
  if (!ok) return json({ ok: false, error: "invalid_credentials" }, 401);

  const token = await createSession(env, email);
  return json({ ok: true, token, user: safe(user) });
}

function bearer(request: Request): string | null {
  const h = request.headers.get("Authorization") ?? "";
  const m = h.match(/^Bearer\s+([a-f0-9]{64})$/i);
  return m ? m[1] : null;
}

export async function handleMe(request: Request, env: Env): Promise<Response> {
  const token = bearer(request);
  if (!token) return json({ ok: false, error: "no_token" }, 401);
  const sess = await env.WAITLIST.get(`session:${token}`);
  if (!sess) return json({ ok: false, error: "expired" }, 401);
  const { email } = JSON.parse(sess) as { email: string };
  const raw = await env.WAITLIST.get(`user:${email}`);
  if (!raw) return json({ ok: false, error: "no_user" }, 401);
  return json({ ok: true, user: safe(JSON.parse(raw) as UserRecord) });
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const token = bearer(request);
  if (token) await env.WAITLIST.delete(`session:${token}`);
  return json({ ok: true });
}

export function authCors(): Response {
  return new Response(null, { headers: CORS });
}
