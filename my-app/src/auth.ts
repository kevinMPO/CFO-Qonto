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
  /** Clé API Resend (secret). Absente ⇒ pas d'email envoyé, l'inscription marche quand même. */
  RESEND_API_KEY?: string;
  /** Expéditeur, ex. « Argentier <noreply@getargentier.com> ». Défaut : bac à sable Resend. */
  RESEND_FROM?: string;
  /** Base publique pour le lien de confirmation. Défaut : www.getargentier.com. */
  APP_BASE_URL?: string;
}

// Cloudflare Workers PLAFONNE PBKDF2 à 100 000 itérations (au-delà : « iteration
// counts above 100000 are not supported »). C'est le maximum de la plateforme —
// en deçà de l'idéal OWASP (600k), mais compensé par un sel aléatoire par
// utilisateur et un mot de passe choisi (≥ 8 caractères). Ne pas remonter : le
// runtime lèverait et l'inscription échouerait.
const ITERATIONS = 100_000;
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 jours
const VERIFY_TTL = 60 * 60 * 24; // lien de confirmation valable 24 h

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
  /** Email confirmé via le lien de vérification. Absent ⇒ anciens comptes = non vérifiés. */
  verified?: boolean;
}
interface SafeUser {
  email: string;
  nom: string;
  prenom: string;
  tel: string;
  verified: boolean;
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
  return { email: u.email, nom: u.nom, prenom: u.prenom, tel: u.tel, verified: u.verified === true };
}

// --- Vérification d'email (Resend) -----------------------------------------

/** Échappe le texte injecté dans le HTML de l'email (nom/prénom de l'utilisateur). */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/**
 * Envoie l'email de confirmation via Resend (REST, pas de SDK). Best-effort :
 * sans `RESEND_API_KEY`, on NE bloque PAS l'inscription — on renvoie `false` et
 * l'utilisateur pourra redemander l'email plus tard. Jamais de mot de passe dans
 * l'email : uniquement un lien de confirmation à usage unique.
 */
async function sendVerificationEmail(
  env: Env,
  to: string,
  prenom: string,
  token: string,
): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  const base = (env.APP_BASE_URL || "https://www.getargentier.com").replace(/\/$/, "");
  const link = `${base}/verify?token=${token}`;
  const from = env.RESEND_FROM || "Argentier <onboarding@resend.dev>";
  const nom = escapeHtml(prenom || "");
  const html = `<!doctype html><html><body style="margin:0;background:#111110;font-family:Inter,Arial,sans-serif;color:#fff;padding:32px">
    <div style="max-width:480px;margin:0 auto;background:#1b1b19;border:1px solid rgba(255,255,255,.14);border-radius:18px;padding:32px">
      <h1 style="font-size:20px;margin:0 0 12px">Confirme ton email</h1>
      <p style="color:#B4B2AC;font-size:15px;line-height:1.6;margin:0 0 24px">Bonjour ${nom}, confirme ton adresse pour activer ton compte Argentier et connecter Qonto en lecture seule.</p>
      <a href="${link}" style="display:inline-block;background:#F5D312;color:#111110;font-weight:700;text-decoration:none;padding:14px 26px;border-radius:99px">Confirmer mon email →</a>
      <p style="color:#7d7b76;font-size:12px;line-height:1.6;margin:24px 0 0">Ou copie ce lien : ${link}<br/>Ce lien expire dans 24 h. Si tu n'es pas à l'origine de cette inscription, ignore cet email.</p>
    </div></body></html>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        subject: "Confirme ton email · Argentier",
        html,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Crée un token de vérification en KV (TTL 24 h) et déclenche l'envoi de l'email. */
async function issueVerification(env: Env, email: string, prenom: string): Promise<void> {
  const token = newToken();
  await env.WAITLIST.put(`verify:${token}`, JSON.stringify({ email }), { expirationTtl: VERIFY_TTL });
  await sendVerificationEmail(env, email, prenom, token);
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
  const user: UserRecord = {
    email, tel, nom, prenom, salt, hash, createdAt: new Date().toISOString(), verified: false,
  };
  await env.WAITLIST.put(`user:${email}`, JSON.stringify(user));

  // Email de confirmation, best-effort : un échec d'envoi ne fait pas échouer
  // l'inscription (l'utilisateur est connecté et pourra redemander l'email).
  await issueVerification(env, email, prenom);

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

/**
 * Confirme un email depuis le lien reçu. POST { token }. Le token est à usage
 * unique (supprimé après succès). Idempotent côté UX : un token déjà consommé
 * renvoie `already` plutôt qu'une erreur dure, pour ne pas alarmer l'utilisateur
 * qui recharge la page de confirmation.
 */
export async function handleVerify(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid_body" }, 400);
  }
  const token = String(body.token ?? "").trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) return json({ ok: false, error: "invalid_token" }, 400);

  const raw = await env.WAITLIST.get(`verify:${token}`);
  if (!raw) return json({ ok: false, error: "invalid_or_expired" }, 404);
  const { email } = JSON.parse(raw) as { email: string };

  const userRaw = await env.WAITLIST.get(`user:${email}`);
  if (!userRaw) {
    await env.WAITLIST.delete(`verify:${token}`);
    return json({ ok: false, error: "no_user" }, 404);
  }
  const user = JSON.parse(userRaw) as UserRecord;
  if (!user.verified) {
    user.verified = true;
    await env.WAITLIST.put(`user:${email}`, JSON.stringify(user));
  }
  await env.WAITLIST.delete(`verify:${token}`);
  return json({ ok: true, user: safe(user) });
}

/** Renvoie un nouvel email de confirmation à l'utilisateur connecté (Bearer). */
export async function handleResendVerification(request: Request, env: Env): Promise<Response> {
  const token = bearer(request);
  if (!token) return json({ ok: false, error: "no_token" }, 401);
  const sess = await env.WAITLIST.get(`session:${token}`);
  if (!sess) return json({ ok: false, error: "expired" }, 401);
  const { email } = JSON.parse(sess) as { email: string };
  const raw = await env.WAITLIST.get(`user:${email}`);
  if (!raw) return json({ ok: false, error: "no_user" }, 401);
  const user = JSON.parse(raw) as UserRecord;
  if (user.verified) return json({ ok: true, already: true });
  await issueVerification(env, email, user.prenom);
  return json({ ok: true });
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const token = bearer(request);
  if (token) await env.WAITLIST.delete(`session:${token}`);
  return json({ ok: true });
}

export function authCors(): Response {
  return new Response(null, { headers: CORS });
}
