"use client";

/**
 * Landing — page principale du site (le pitch, façon page marketing).
 * Palette inspirée de qonto.com : fond quasi-noir, texte blanc, accent jaune.
 * Bouton « Voir la démo » → l'app Argentier, sur le jeu de démonstration
 * anonymisé de `lib/mock.ts` (société fictive, montants fictifs).
 */

import React, { useEffect, useState } from "react";
import type { Lang } from "@/lib/types";
import { detectLang, PITCH } from "@/lib/i18n";
import { signup, login, me, logout, resendVerification, type Account } from "@/lib/account";

// Rend **gras** dans un texte.
function emph(text: string, key: string): React.ReactNode[] {
  return text.split("**").map((seg, i) =>
    i % 2 === 1 ? <strong key={`${key}-${i}`}>{seg}</strong> : <React.Fragment key={`${key}-${i}`}>{seg}</React.Fragment>,
  );
}

const FLAGS: Record<Lang, string> = { fr: "🇫🇷", en: "🇬🇧", de: "🇩🇪", es: "🇪🇸", it: "🇮🇹" };
const L = (lang: Lang, m: Record<Lang, string>) => m[lang] ?? m.en;

export default function Landing({ onDemo }: { onDemo: () => void }) {
  const [lang, setLang] = useState<Lang>("fr");
  const [joined, setJoined] = useState(false);
  const [email, setEmail] = useState("");
  // Demande d'accès Slack (Claude Tag) — même stockage KV, source « slack ».
  const [slackJoined, setSlackJoined] = useState(false);
  const [slackEmail, setSlackEmail] = useState("");
  // Gate email au clic « Tester gratuitement » → stocké dans Cloudflare KV.
  const [gate, setGate] = useState(false);
  const [demoEmail, setDemoEmail] = useState("");
  const [sending, setSending] = useState(false);
  // Compte utilisateur (onboarding AVANT Qonto) — jeton géré par lib/account.
  const [user, setUser] = useState<Account | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [fEmail, setFEmail] = useState("");
  const [fPass, setFPass] = useState("");
  const [fPass2, setFPass2] = useState("");
  const [fTel, setFTel] = useState("");
  const [fNom, setFNom] = useState("");
  const [fPrenom, setFPrenom] = useState("");
  const [fCgv, setFCgv] = useState(false);
  const [resent, setResent] = useState(false);

  const WAITLIST_URL = "https://argentier-mcp.bonjour-e83.workers.dev/waitlist";
  const storeEmail = async (address: string, source: string) => {
    try {
      await fetch(WAITLIST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: address.trim().toLowerCase(), lang, source }),
      });
    } catch {
      /* réseau — on ne bloque pas l'utilisateur */
    }
  };
  const submitDemo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!demoEmail.includes("@")) return;
    setSending(true);
    await storeEmail(demoEmail, "voir-demo");
    setSending(false);
    onDemo();
  };

  // --- Compte utilisateur --------------------------------------------------
  const openAuth = (mode: "login" | "signup") => {
    setAuthMode(mode);
    setAuthError("");
    setAuthOpen(true);
  };
  // Gate : un compte AVANT de connecter Qonto. Connecté → on lance l'OAuth
  // Qonto (dont la sécurité reste portée par l'OAuth + SCA de Qonto).
  const openQonto = () => {
    if (user) window.location.href = "/api/auth/qonto/start";
    else openAuth("signup");
  };
  const errorText = (code: string): string => {
    const map: Record<string, Record<Lang, string>> = {
      email_taken: { fr: "Un compte existe déjà avec cet email.", en: "An account already exists for this email.", de: "Für diese E-Mail existiert bereits ein Konto.", es: "Ya existe una cuenta con este email.", it: "Esiste già un account con questa email." },
      invalid_credentials: { fr: "Email ou mot de passe incorrect.", en: "Wrong email or password.", de: "E-Mail oder Passwort falsch.", es: "Email o contraseña incorrectos.", it: "Email o password errati." },
      weak_password: { fr: "Mot de passe trop court (8 caractères min).", en: "Password too short (min 8 characters).", de: "Passwort zu kurz (mind. 8 Zeichen).", es: "Contraseña demasiado corta (mín. 8).", it: "Password troppo corta (min 8)." },
      cgv_required: { fr: "Tu dois accepter les CGV.", en: "You must accept the terms.", de: "Du musst die AGB akzeptieren.", es: "Debes aceptar las condiciones.", it: "Devi accettare i termini." },
      network: { fr: "Réseau indisponible, réessaie.", en: "Network unavailable, try again.", de: "Netzwerk nicht verfügbar, erneut versuchen.", es: "Red no disponible, inténtalo de nuevo.", it: "Rete non disponibile, riprova." },
    };
    return (map[code] && L(lang, map[code])) || L(lang, { fr: "Une erreur est survenue.", en: "Something went wrong.", de: "Ein Fehler ist aufgetreten.", es: "Ha ocurrido un error.", it: "Si è verificato un errore." });
  };
  const submitAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    if (authMode === "signup") {
      if (fPass.length < 8) return setAuthError(errorText("weak_password"));
      if (fPass !== fPass2)
        return setAuthError(L(lang, { fr: "Les mots de passe ne correspondent pas.", en: "Passwords don't match.", de: "Passwörter stimmen nicht überein.", es: "Las contraseñas no coinciden.", it: "Le password non corrispondono." }));
      if (!fCgv) return setAuthError(errorText("cgv_required"));
    }
    setAuthBusy(true);
    const res =
      authMode === "signup"
        ? await signup({ email: fEmail, tel: fTel, nom: fNom, prenom: fPrenom, password: fPass, cgv: fCgv })
        : await login(fEmail, fPass);
    setAuthBusy(false);
    if (res.ok) {
      setUser(res.user);
      setAuthOpen(false);
      setFPass("");
      setFPass2("");
    } else {
      setAuthError(errorText(res.error));
    }
  };
  const doLogout = async () => {
    await logout();
    setUser(null);
  };
  const doResend = async () => {
    const ok = await resendVerification();
    if (ok) setResent(true);
  };

  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem("argentier-lang") : null;
    setLang((["fr", "en", "de", "es", "it"] as Lang[]).includes(saved as Lang) ? (saved as Lang) : detectLang(navigator.language));
  }, []);

  // Rétablit la session de compte au chargement (jeton en localStorage).
  useEffect(() => {
    me().then((u) => {
      if (u) setUser(u);
    });
  }, []);
  const changeLang = (l: Lang) => {
    setLang(l);
    try {
      window.localStorage.setItem("argentier-lang", l);
    } catch {
      /* noop */
    }
  };

  const p = PITCH[lang];

  return (
    <div className="lp">
      <style>{CSS}</style>

      <header className="lp-nav">
        <span className="lp-brand">
          <Mark /> Argentier
        </span>
        <div className="lp-nav-right">
          <div className="lp-langs" role="group" aria-label="Language">
            {(["fr", "en", "de", "es", "it"] as Lang[]).map((l) => (
              <button
                key={l}
                className={"lp-lang" + (lang === l ? " on" : "")}
                onClick={() => changeLang(l)}
                aria-pressed={lang === l}
                title={l.toUpperCase()}
              >
                {FLAGS[l]}
              </button>
            ))}
          </div>
          {user ? (
            <div className="lp-acct">
              <span className="lp-acct-name" title={user.email}>
                {user.prenom || user.email}
              </span>
              <button className="lp-acct-out" onClick={doLogout}>
                {L(lang, { fr: "Déconnexion", en: "Log out", de: "Abmelden", es: "Salir", it: "Esci" })}
              </button>
            </div>
          ) : (
            <button className="lp-acct-in" onClick={() => openAuth("login")}>
              {L(lang, { fr: "Connexion", en: "Log in", de: "Anmelden", es: "Iniciar sesión", it: "Accedi" })}
            </button>
          )}
          <button className="lp-demo-top" onClick={() => setGate(true)}>
            {L(lang, { fr: "Tester gratuitement", en: "Try for free", de: "Kostenlos testen", es: "Probar gratis", it: "Prova gratis" })} →
          </button>
        </div>
      </header>

      {user && !user.verified && (
        <div className="lp-verify-bar">
          <span>
            {L(lang, {
              fr: "Confirme ton email pour activer ton compte (vérifie ta boîte de réception).",
              en: "Confirm your email to activate your account (check your inbox).",
              de: "Bestätige deine E-Mail, um dein Konto zu aktivieren (Posteingang prüfen).",
              es: "Confirma tu email para activar tu cuenta (revisa tu bandeja).",
              it: "Conferma la tua email per attivare l'account (controlla la posta).",
            })}
          </span>
          {resent ? (
            <span className="lp-verify-done">
              ✓ {L(lang, { fr: "Email renvoyé", en: "Email resent", de: "E-Mail erneut gesendet", es: "Email reenviado", it: "Email inviata di nuovo" })}
            </span>
          ) : (
            <button className="lp-verify-btn" onClick={doResend}>
              {L(lang, { fr: "Renvoyer l'email", en: "Resend email", de: "E-Mail erneut senden", es: "Reenviar email", it: "Invia di nuovo" })}
            </button>
          )}
        </div>
      )}

      {/* Hero */}
      <section className="lp-hero">
        <span className="lp-eyebrow">
          {L(lang, {
            fr: "L'agent DAF autonome pour ton compte Qonto",
            en: "The autonomous CFO agent for your Qonto account",
            de: "Der autonome CFO-Agent für dein Qonto-Konto",
            es: "El agente director financiero autónomo para tu cuenta Qonto",
            it: "L'agente CFO autonomo per il tuo conto Qonto",
          })}
        </span>
        <h1 className="lp-title">{p.tagline}</h1>
        <p className="lp-sub">
          {L(lang, {
            fr: "Il lit ton compte en lecture seule, trouve l'argent qui fuit, et prouve chaque euro économisé. Tu approuves en 1 tap — il ne bouge jamais d'argent.",
            en: "It reads your account read-only, finds the money leaking out, and proves every euro saved. You approve in 1 tap — it never moves money.",
            de: "Es liest dein Konto nur lesend, findet das versickernde Geld und beweist jeden gesparten Euro. Du gibst mit einem Tap frei — es bewegt nie Geld.",
            es: "Lee tu cuenta en modo solo lectura, encuentra el dinero que se fuga y demuestra cada euro ahorrado. Apruebas en 1 toque — nunca mueve dinero.",
            it: "Legge il tuo conto in sola lettura, trova i soldi che si disperdono e dimostra ogni euro risparmiato. Approvi in 1 tap — non muove mai denaro.",
          })}
        </p>
        <div className="lp-cta">
          <button className="lp-demo" onClick={() => setGate(true)}>
            {L(lang, { fr: "Tester gratuitement", en: "Try for free", de: "Kostenlos testen", es: "Probar gratis", it: "Prova gratis" })}
          </button>
          <button className="lp-cta-login" onClick={openQonto}>
            {L(lang, {
              fr: "Connecter mon compte Qonto",
              en: "Connect my Qonto account",
              de: "Mein Qonto-Konto verbinden",
              es: "Conectar mi cuenta Qonto",
              it: "Collega il mio conto Qonto",
            })}
          </button>
          {!user && (
            <button className="lp-cta-ghost" onClick={() => openAuth("login")}>
              {L(lang, {
                fr: "Connexion",
                en: "Log in",
                de: "Anmelden",
                es: "Iniciar sesión",
                it: "Accedi",
              })}
            </button>
          )}
        </div>
        <div className="lp-hook">
          <span className="lp-hook-num">{p.hookNum}</span>
          <span className="lp-hook-cap">{p.hookCap}</span>
        </div>
      </section>

      {/* Pitch */}
      <section className="lp-pitch">
        {p.paras.map((para, i) => (
          <p key={i} className="lp-para">
            {emph(para, `p${i}`)}
          </p>
        ))}
      </section>

      {/* 4 règles */}
      <section className="lp-rules">
        {(
          [
            [L(lang, { fr: "Read-only Qonto", en: "Read-only Qonto", de: "Nur-Lesen Qonto", es: "Qonto solo lectura", it: "Qonto sola lettura" }), L(lang, { fr: "Aucune écriture, aucun mouvement d'argent.", en: "No writes, no money movement.", de: "Keine Schreibvorgänge, keine Geldbewegung.", es: "Sin escrituras, sin movimiento de dinero.", it: "Nessuna scrittura, nessun movimento di denaro." })],
            [L(lang, { fr: "Le moteur calcule", en: "The engine computes", de: "Die Engine rechnet", es: "El motor calcula", it: "Il motore calcola" }), L(lang, { fr: "Chaque euro vient d'un code déterministe, jamais du LLM.", en: "Every euro comes from deterministic code, never the LLM.", de: "Jeder Euro stammt aus deterministischem Code, nie vom LLM.", es: "Cada euro viene de código determinista, nunca del LLM.", it: "Ogni euro viene da codice deterministico, mai dall'LLM." })],
            [L(lang, { fr: "Zéro PII vers le web", en: "Zero PII to the web", de: "Keine PII ins Web", es: "Cero PII a la web", it: "Zero PII sul web" }), L(lang, { fr: "Seuls le marchand + la catégorie sortent.", en: "Only merchant + category leave.", de: "Nur Händler + Kategorie gehen raus.", es: "Solo salen comercio + categoría.", it: "Escono solo esercente + categoria." })],
            [L(lang, { fr: "Prix = source + date", en: "Price = source + date", de: "Preis = Quelle + Datum", es: "Precio = fuente + fecha", it: "Prezzo = fonte + data" }), L(lang, { fr: "Sinon : « non vérifié ».", en: 'Otherwise: "not verified".', de: 'Sonst: „nicht verifiziert".', es: 'Si no: "no verificado".', it: 'Altrimenti: "non verificato".' })],
          ] as const
        ).map(([t, d], i) => (
          <div key={i} className="lp-rule">
            <span className="lp-rule-n">{i + 1}</span>
            <div>
              <p className="lp-rule-t">{t}</p>
              <p className="lp-rule-d">{d}</p>
            </div>
          </div>
        ))}
      </section>

      {/* Argentier dans Slack (Claude Tag) — accès qualifié */}
      <section className="lp-slack" id="slack">
        <div className="lp-slack-card">
          <span className="lp-slack-badge">
            {L(lang, {
              fr: "Nouveau · Argentier dans Slack",
              en: "New · Argentier in Slack",
              de: "Neu · Argentier in Slack",
              es: "Nuevo · Argentier en Slack",
              it: "Novità · Argentier in Slack",
            })}
          </span>
          <h2 className="lp-slack-title">
            {L(lang, {
              fr: "Tag @Claude, obtiens ton audit",
              en: "Tag @Claude, get your audit",
              de: "Tagge @Claude, erhalte dein Audit",
              es: "Menciona a @Claude, obtén tu auditoría",
              it: "Tagga @Claude, ottieni il tuo audit",
            })}
          </h2>
          <p className="lp-slack-sub">
            {L(lang, {
              fr: "Depuis ton espace Slack, demande un audit de tes dépenses. Argentier étiquette, le moteur déterministe calcule chaque euro, tu approuves. Toujours en lecture seule.",
              en: "From your Slack workspace, ask for a spend audit. Argentier labels, the deterministic engine computes every euro, you approve. Always read-only.",
              de: "Frag aus deinem Slack-Workspace nach einem Ausgaben-Audit. Argentier etikettiert, die deterministische Engine berechnet jeden Euro, du gibst frei. Immer nur lesend.",
              es: "Desde tu espacio de Slack, pide una auditoría de gastos. Argentier etiqueta, el motor determinista calcula cada euro, tú apruebas. Siempre en solo lectura.",
              it: "Dal tuo spazio Slack, chiedi un audit delle spese. Argentier etichetta, il motore deterministico calcola ogni euro, tu approvi. Sempre in sola lettura.",
            })}
          </p>
          <p className="lp-slack-note">
            {L(lang, {
              fr: "Accès qualifié : on ouvre Slack aux équipes dont l'usage colle (TPE/EI clientes Qonto). Laisse ton email, on revient vers toi.",
              en: "Qualified access: we open Slack to teams whose use fits (small businesses on Qonto). Leave your email, we'll get back to you.",
              de: "Qualifizierter Zugang: Wir öffnen Slack für Teams mit passendem Einsatz (Kleinunternehmen bei Qonto). Hinterlasse deine E-Mail, wir melden uns.",
              es: "Acceso cualificado: abrimos Slack a equipos cuyo uso encaja (pymes en Qonto). Deja tu email y te contactamos.",
              it: "Accesso qualificato: apriamo Slack ai team il cui uso è coerente (piccole imprese su Qonto). Lascia la tua email, ti ricontattiamo.",
            })}
          </p>
          {slackJoined ? (
            <p className="lp-slack-done">
              ✓{" "}
              {L(lang, {
                fr: "Demande envoyée — on te recontacte pour l'accès Slack.",
                en: "Request sent — we'll reach out about Slack access.",
                de: "Anfrage gesendet — wir melden uns wegen des Slack-Zugangs.",
                es: "Solicitud enviada — te contactaremos sobre el acceso a Slack.",
                it: "Richiesta inviata — ti ricontatteremo per l'accesso a Slack.",
              })}
            </p>
          ) : (
            <form
              className="lp-slack-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (slackEmail.includes("@")) {
                  storeEmail(slackEmail, "slack");
                  setSlackJoined(true);
                }
              }}
            >
              <input
                className="lp-slack-input"
                type="email"
                required
                placeholder={L(lang, { fr: "ton@email.com", en: "you@email.com", de: "du@email.com", es: "tu@email.com", it: "tua@email.com" })}
                value={slackEmail}
                onChange={(e) => setSlackEmail(e.target.value)}
                aria-label="email"
              />
              <button className="lp-slack-btn" type="submit">
                {L(lang, {
                  fr: "Demander l'accès Slack",
                  en: "Request Slack access",
                  de: "Slack-Zugang anfragen",
                  es: "Solicitar acceso a Slack",
                  it: "Richiedi l'accesso a Slack",
                })}
              </button>
            </form>
          )}
        </div>
      </section>

      {/* Waitlist */}
      <section className="lp-wait" id="waitlist">
        <h2 className="lp-wait-title">
          {L(lang, {
            fr: "Branche ton vrai compte Qonto",
            en: "Connect your real Qonto account",
            de: "Verbinde dein echtes Qonto-Konto",
            es: "Conecta tu cuenta Qonto real",
            it: "Collega il tuo vero conto Qonto",
          })}
        </h2>
        {joined ? (
          <p className="lp-wait-done">
            ✓ {L(lang, { fr: "Tu es sur la liste", en: "You're on the list", de: "Du bist auf der Liste", es: "Estás en la lista", it: "Sei nella lista" })}
          </p>
        ) : (
          <>
            <form
              className="lp-wait-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (email.includes("@")) {
                  storeEmail(email, "waitlist");
                  setJoined(true);
                }
              }}
            >
              <input
                className="lp-wait-input"
                type="email"
                required
                placeholder={L(lang, { fr: "ton@email.com", en: "you@email.com", de: "du@email.com", es: "tu@email.com", it: "tua@email.com" })}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-label="email"
              />
              <button className="lp-wait-btn" type="submit">
                {L(lang, {
                  fr: "Rejoindre : connecter Qonto",
                  en: "Join: connect Qonto",
                  de: "Beitreten: Qonto verbinden",
                  es: "Unirse: conectar Qonto",
                  it: "Iscriviti: collega Qonto",
                })}
              </button>
            </form>
            <p className="lp-wait-hint">
              {L(lang, {
                fr: "Pour rejoindre la liste d'attente, connecte ton email.",
                en: "To join the waitlist, connect your email.",
                de: "Um der Warteliste beizutreten, gib deine E-Mail an.",
                es: "Para unirte a la lista de espera, conecta tu email.",
                it: "Per iscriverti alla lista d'attesa, collega la tua email.",
              })}
            </p>
          </>
        )}
        <p className="lp-disclaimer">
          {L(lang, {
            fr: "Données de démonstration — configure Qonto + Anthropic dans .env pour brancher ton vrai compte. Données traitées en Europe, jamais utilisées pour entraîner un modèle. Conseils fiscaux à valider avec ton comptable.",
            en: "Demo data — set up Qonto + Anthropic in .env to connect your real account. Data processed in Europe, never used to train a model. Tax advice to confirm with your accountant.",
            de: "Demo-Daten — Qonto + Anthropic in .env einrichten, um dein echtes Konto zu verbinden. Daten in Europa verarbeitet, nie zum Modelltraining genutzt. Steuertipps mit deinem Buchhalter prüfen.",
            es: "Datos de demostración — configura Qonto + Anthropic en .env para conectar tu cuenta real. Datos tratados en Europa, nunca usados para entrenar un modelo. Consejos fiscales a validar con tu contable.",
            it: "Dati dimostrativi — configura Qonto + Anthropic in .env per collegare il tuo conto reale. Dati trattati in Europa, mai usati per addestrare un modello. Consigli fiscali da validare con il commercialista.",
          })}
        </p>
        <p className="lp-proto">
          {L(lang, {
            fr: "Prototype pour Hackathon Qonto",
            en: "Prototype for Qonto Hackathon",
            de: "Prototyp für den Qonto-Hackathon",
            es: "Prototipo para el Hackathon de Qonto",
            it: "Prototipo per l'Hackathon Qonto",
          })}
        </p>
      </section>

      {/* Gate email — au clic « Voir la démo » (stocké dans Cloudflare KV) */}
      {gate && (
        <div className="lp-gate" role="dialog" aria-modal="true" onClick={() => !sending && setGate(false)}>
          <div className="lp-gate-box" onClick={(e) => e.stopPropagation()}>
            <p className="lp-gate-title">
              {L(lang, { fr: "Accède à la démo", en: "Access the demo", de: "Zur Demo", es: "Accede a la demo", it: "Accedi alla demo" })}
            </p>
            <p className="lp-gate-sub">
              {L(lang, {
                fr: "Laisse ton email pour lancer la démo Argentier.",
                en: "Leave your email to launch the Argentier demo.",
                de: "Gib deine E-Mail an, um die Argentier-Demo zu starten.",
                es: "Deja tu email para iniciar la demo de Argentier.",
                it: "Lascia la tua email per avviare la demo di Argentier.",
              })}
            </p>
            <form className="lp-gate-form" onSubmit={submitDemo}>
              <input
                className="lp-gate-input"
                type="email"
                required
                autoFocus
                placeholder={L(lang, { fr: "ton@email.com", en: "you@email.com", de: "du@email.com", es: "tu@email.com", it: "tua@email.com" })}
                value={demoEmail}
                onChange={(e) => setDemoEmail(e.target.value)}
                aria-label="email"
              />
              <button className="lp-gate-btn" type="submit" disabled={sending}>
                {sending
                  ? "…"
                  : L(lang, { fr: "Tester gratuitement →", en: "Try for free →", de: "Kostenlos testen →", es: "Probar gratis →", it: "Prova gratis →" })}
              </button>
            </form>
            <button className="lp-gate-cancel" onClick={() => setGate(false)} disabled={sending}>
              {L(lang, { fr: "Annuler", en: "Cancel", de: "Abbrechen", es: "Cancelar", it: "Annulla" })}
            </button>
          </div>
        </div>
      )}

      {/* Modale de compte — connexion / inscription (mot de passe choisi, jamais envoyé par email) */}
      {authOpen && (
        <div className="lp-gate" role="dialog" aria-modal="true" onClick={() => !authBusy && setAuthOpen(false)}>
          <div className="lp-auth-box" onClick={(e) => e.stopPropagation()}>
            <p className="lp-gate-title">
              {authMode === "login"
                ? L(lang, { fr: "Connexion", en: "Log in", de: "Anmelden", es: "Iniciar sesión", it: "Accedi" })
                : L(lang, { fr: "Créer un compte", en: "Create an account", de: "Konto erstellen", es: "Crear una cuenta", it: "Crea un account" })}
            </p>
            <p className="lp-gate-sub">
              {authMode === "login"
                ? L(lang, {
                    fr: "Connecte-toi pour brancher ton compte Qonto.",
                    en: "Log in to connect your Qonto account.",
                    de: "Melde dich an, um dein Qonto-Konto zu verbinden.",
                    es: "Inicia sesión para conectar tu cuenta Qonto.",
                    it: "Accedi per collegare il tuo conto Qonto.",
                  })
                : L(lang, {
                    fr: "Crée ton compte, puis connecte Qonto en lecture seule.",
                    en: "Create your account, then connect Qonto read-only.",
                    de: "Erstelle dein Konto, dann verbinde Qonto nur lesend.",
                    es: "Crea tu cuenta y luego conecta Qonto en solo lectura.",
                    it: "Crea il tuo account, poi collega Qonto in sola lettura.",
                  })}
            </p>
            <form className="lp-auth-form" onSubmit={submitAuth}>
              {authMode === "signup" && (
                <div className="lp-auth-row2">
                  <input
                    className="lp-gate-input"
                    type="text"
                    required
                    placeholder={L(lang, { fr: "Prénom", en: "First name", de: "Vorname", es: "Nombre", it: "Nome" })}
                    value={fPrenom}
                    onChange={(e) => setFPrenom(e.target.value)}
                    aria-label={L(lang, { fr: "Prénom", en: "First name", de: "Vorname", es: "Nombre", it: "Nome" })}
                  />
                  <input
                    className="lp-gate-input"
                    type="text"
                    required
                    placeholder={L(lang, { fr: "Nom", en: "Last name", de: "Nachname", es: "Apellido", it: "Cognome" })}
                    value={fNom}
                    onChange={(e) => setFNom(e.target.value)}
                    aria-label={L(lang, { fr: "Nom", en: "Last name", de: "Nachname", es: "Apellido", it: "Cognome" })}
                  />
                </div>
              )}
              <input
                className="lp-gate-input"
                type="email"
                required
                autoComplete="email"
                placeholder={L(lang, { fr: "ton@email.com", en: "you@email.com", de: "du@email.com", es: "tu@email.com", it: "tua@email.com" })}
                value={fEmail}
                onChange={(e) => setFEmail(e.target.value)}
                aria-label="email"
              />
              {authMode === "signup" && (
                <input
                  className="lp-gate-input"
                  type="tel"
                  placeholder={L(lang, { fr: "Téléphone", en: "Phone", de: "Telefon", es: "Teléfono", it: "Telefono" })}
                  value={fTel}
                  onChange={(e) => setFTel(e.target.value)}
                  aria-label={L(lang, { fr: "Téléphone", en: "Phone", de: "Telefon", es: "Teléfono", it: "Telefono" })}
                />
              )}
              <input
                className="lp-gate-input"
                type="password"
                required
                minLength={8}
                autoComplete={authMode === "login" ? "current-password" : "new-password"}
                placeholder={L(lang, { fr: "Mot de passe", en: "Password", de: "Passwort", es: "Contraseña", it: "Password" })}
                value={fPass}
                onChange={(e) => setFPass(e.target.value)}
                aria-label={L(lang, { fr: "Mot de passe", en: "Password", de: "Passwort", es: "Contraseña", it: "Password" })}
              />
              {authMode === "signup" && (
                <input
                  className="lp-gate-input"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  placeholder={L(lang, { fr: "Confirmer le mot de passe", en: "Confirm password", de: "Passwort bestätigen", es: "Confirmar contraseña", it: "Conferma password" })}
                  value={fPass2}
                  onChange={(e) => setFPass2(e.target.value)}
                  aria-label={L(lang, { fr: "Confirmer le mot de passe", en: "Confirm password", de: "Passwort bestätigen", es: "Confirmar contraseña", it: "Conferma password" })}
                />
              )}
              {authMode === "signup" && (
                <label className="lp-auth-cgv">
                  <input type="checkbox" checked={fCgv} onChange={(e) => setFCgv(e.target.checked)} />
                  <span>
                    {L(lang, { fr: "J'accepte les", en: "I accept the", de: "Ich akzeptiere die", es: "Acepto las", it: "Accetto i" })}{" "}
                    <a href="/cgv" target="_blank" rel="noopener noreferrer">
                      {L(lang, { fr: "conditions générales", en: "terms", de: "AGB", es: "condiciones", it: "termini" })}
                    </a>{" "}
                    *
                  </span>
                </label>
              )}
              {authError && <p className="lp-auth-err">{authError}</p>}
              <button className="lp-gate-btn" type="submit" disabled={authBusy}>
                {authBusy
                  ? "…"
                  : authMode === "login"
                    ? L(lang, { fr: "Se connecter", en: "Log in", de: "Anmelden", es: "Iniciar sesión", it: "Accedi" })
                    : L(lang, { fr: "Créer mon compte", en: "Create my account", de: "Konto erstellen", es: "Crear mi cuenta", it: "Crea il mio account" })}
              </button>
            </form>
            <button className="lp-gate-cancel" onClick={() => openAuth(authMode === "login" ? "signup" : "login")}>
              {authMode === "login"
                ? L(lang, { fr: "Pas de compte ? S'inscrire", en: "No account? Sign up", de: "Kein Konto? Registrieren", es: "¿Sin cuenta? Regístrate", it: "Nessun account? Registrati" })
                : L(lang, { fr: "Déjà un compte ? Se connecter", en: "Already have an account? Log in", de: "Schon ein Konto? Anmelden", es: "¿Ya tienes cuenta? Inicia sesión", it: "Hai già un account? Accedi" })}
            </button>
          </div>
        </div>
      )}

      <footer className="lp-foot">
        <div className="lp-foot-brand">
          <Mark /> Argentier
        </div>
        <nav className="lp-foot-liens">
          <a href="/mentions-legales">Mentions légales</a>
          <a href="/confidentialite">Confidentialité</a>
          <a href="/cgv">CGV</a>
          <a href="/dpa">Sous-traitance (DPA)</a>
          <a href="/sous-traitants">Sous-traitants</a>
        </nav>
        <div className="lp-foot-note">
          Lecture seule — Argentier ne déplace jamais d’argent.
        </div>
      </footer>
    </div>
  );
}

function Mark() {
  return (
    <svg className="lp-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M5.5 25.5 L16 5.5 L26.5 25.5" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
      <rect x="12" y="19.5" width="2.3" height="6" rx="0.7" className="lp-mark-bar" />
      <rect x="15.4" y="16.5" width="2.3" height="9" rx="0.7" className="lp-mark-bar" />
      <rect x="18.8" y="13.5" width="2.3" height="12" rx="0.7" className="lp-mark-bar" />
    </svg>
  );
}

// Palette inspirée de qonto.com : noir profond, blanc, accent jaune.
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
.lp{--bg:#111110;--ink:#FFFFFF;--ink2:#B4B2AC;--line:rgba(255,255,255,.14);--yellow:#F5D312;
  background:var(--bg);color:var(--ink);font-family:'Inter',system-ui,sans-serif;min-height:100vh;
  -webkit-font-smoothing:antialiased;line-height:1.5;overflow-x:hidden;}
.lp *{box-sizing:border-box;}
.lp-mark{width:26px;height:26px;color:var(--ink);vertical-align:middle;}
.lp-mark-bar{fill:var(--yellow);}
.lp-nav{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;
  padding:16px clamp(18px,5vw,64px);background:rgba(17,17,16,.82);backdrop-filter:blur(10px);border-bottom:1px solid var(--line);}
.lp-brand{display:inline-flex;align-items:center;gap:9px;font-family:'Space Grotesk';font-weight:600;font-size:18px;}
.lp-nav-right{display:flex;align-items:center;gap:14px;}
.lp-langs{display:inline-flex;gap:2px;}
.lp-lang{border:0;background:none;font-size:15px;padding:3px 4px;cursor:pointer;opacity:.5;border-radius:6px;line-height:1;transition:opacity .1s,background .1s;}
.lp-lang.on,.lp-lang:hover{opacity:1;background:rgba(255,255,255,.08);}
.lp-demo-top{border:1px solid var(--line);background:none;color:var(--ink);border-radius:99px;font-family:inherit;
  font-size:13px;font-weight:600;padding:8px 16px;cursor:pointer;transition:background .12s;}
.lp-demo-top:hover{background:rgba(255,255,255,.08);}

.lp-hero{max-width:920px;margin:0 auto;padding:clamp(48px,10vh,120px) clamp(18px,5vw,32px) 40px;text-align:center;}
.lp-eyebrow{display:inline-block;font-size:12.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;
  color:var(--yellow);border:1px solid color-mix(in srgb,var(--yellow) 40%,transparent);border-radius:99px;padding:6px 14px;margin-bottom:26px;}
.lp-title{font-family:'Space Grotesk';font-weight:700;font-size:clamp(34px,7vw,72px);line-height:1.02;letter-spacing:-.03em;margin:0 0 22px;text-wrap:balance;}
.lp-sub{font-size:clamp(16px,2.3vw,21px);color:var(--ink2);max-width:640px;margin:0 auto 34px;text-wrap:pretty;}
.lp-cta{display:flex;gap:14px;justify-content:center;flex-wrap:wrap;margin-bottom:56px;}
.lp-demo{border:0;background:var(--yellow);color:#111110;border-radius:99px;font-family:inherit;font-size:16px;font-weight:700;
  padding:15px 32px;cursor:pointer;box-shadow:0 8px 30px color-mix(in srgb,var(--yellow) 30%,transparent);transition:transform .08s ease;}
.lp-demo:hover{transform:translateY(-2px);}
.lp-cta-login{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--yellow);color:var(--yellow);
  border-radius:99px;font-size:16px;font-weight:600;padding:15px 28px;text-decoration:none;transition:background .12s;
  background:none;font-family:inherit;cursor:pointer;}
.lp-cta-login:hover{background:color-mix(in srgb,var(--yellow) 14%,transparent);}
.lp-cta-ghost{display:inline-flex;align-items:center;border:1px solid var(--line);color:var(--ink);border-radius:99px;
  font-size:16px;font-weight:600;padding:15px 28px;text-decoration:none;transition:background .12s;
  background:none;font-family:inherit;cursor:pointer;}
.lp-cta-ghost:hover{background:rgba(255,255,255,.08);}

.lp-acct{display:inline-flex;align-items:center;gap:10px;}
.lp-acct-name{font-size:13px;font-weight:600;color:var(--ink);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lp-acct-out{border:1px solid var(--line);background:none;color:var(--ink2);font-family:inherit;font-size:12px;font-weight:600;padding:6px 12px;border-radius:99px;cursor:pointer;transition:background .12s;}
.lp-acct-out:hover{background:rgba(255,255,255,.08);}
.lp-acct-in{border:1px solid var(--line);background:none;color:var(--ink);font-family:inherit;font-size:13px;font-weight:600;padding:8px 16px;border-radius:99px;cursor:pointer;transition:background .12s;}
.lp-acct-in:hover{background:rgba(255,255,255,.08);}
.lp-auth-box{background:#1b1b19;border:1px solid var(--line);border-radius:18px;padding:28px;width:100%;max-width:440px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.5);}
.lp-auth-form{display:flex;flex-direction:column;gap:10px;text-align:left;}
.lp-auth-row2{display:flex;gap:10px;}
.lp-auth-row2 .lp-gate-input{flex:1;min-width:0;}
.lp-auth-cgv{display:flex;align-items:flex-start;gap:9px;font-size:12.5px;color:var(--ink2);line-height:1.4;margin-top:2px;cursor:pointer;}
.lp-auth-cgv input{margin-top:2px;accent-color:var(--yellow);flex:none;}
.lp-auth-cgv a{color:var(--yellow);}
.lp-auth-err{color:#ff8f8f;font-size:12.5px;margin:2px 0 0;}
.lp-verify-bar{display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap;
  background:color-mix(in srgb,var(--yellow) 12%,transparent);border-bottom:1px solid color-mix(in srgb,var(--yellow) 30%,transparent);
  padding:10px 20px;font-size:13.5px;color:var(--ink);}
.lp-verify-btn{border:1px solid var(--yellow);background:none;color:var(--yellow);font-family:inherit;font-size:13px;font-weight:600;
  padding:6px 14px;border-radius:99px;cursor:pointer;transition:background .12s;}
.lp-verify-btn:hover{background:color-mix(in srgb,var(--yellow) 16%,transparent);}
.lp-verify-done{color:var(--yellow);font-weight:600;font-size:13px;}
.lp-hook{display:inline-flex;align-items:baseline;gap:16px;padding-top:40px;border-top:1px solid var(--line);flex-wrap:wrap;justify-content:center;max-width:560px;}
.lp-hook-num{font-family:'Space Grotesk';font-weight:700;font-size:clamp(56px,13vw,110px);line-height:.85;color:var(--yellow);letter-spacing:-.04em;}
.lp-hook-cap{font-family:'Space Grotesk';font-weight:600;font-size:clamp(17px,3vw,24px);color:var(--ink);max-width:300px;text-align:left;}

.lp-pitch{max-width:720px;margin:0 auto;padding:20px clamp(18px,5vw,32px) 60px;}
.lp-para{font-size:clamp(16px,2vw,19px);line-height:1.65;color:var(--ink2);margin:0 0 22px;text-wrap:pretty;}
.lp-para strong{color:var(--ink);font-weight:600;}

.lp-rules{max-width:920px;margin:0 auto;padding:0 clamp(18px,5vw,32px) 70px;display:grid;grid-template-columns:repeat(2,1fr);gap:16px;}
@media(max-width:640px){.lp-rules{grid-template-columns:1fr;}}
.lp-rule{display:flex;gap:14px;align-items:flex-start;border:1px solid var(--line);border-radius:16px;padding:20px;background:rgba(255,255,255,.02);}
.lp-rule-n{flex:none;width:30px;height:30px;border-radius:50%;background:var(--yellow);color:#111110;font-family:'Space Grotesk';
  font-weight:700;display:flex;align-items:center;justify-content:center;font-size:15px;}
.lp-rule-t{font-family:'Space Grotesk';font-weight:600;font-size:16px;margin:0 0 4px;}
.lp-rule-d{font-size:13.5px;color:var(--ink2);margin:0;}

.lp-slack{max-width:920px;margin:0 auto;padding:0 clamp(18px,5vw,32px) 20px;}
.lp-slack-card{border:1px solid var(--line);border-radius:20px;padding:clamp(24px,4vw,40px);
  background:linear-gradient(180deg,rgba(245,211,18,.06),rgba(255,255,255,.02));text-align:center;}
.lp-slack-badge{display:inline-block;font-size:12px;font-weight:600;letter-spacing:.04em;color:var(--yellow);
  border:1px solid color-mix(in srgb,var(--yellow) 40%,transparent);border-radius:99px;padding:5px 13px;margin-bottom:16px;}
.lp-slack-title{font-family:'Space Grotesk';font-weight:700;font-size:clamp(22px,3.6vw,34px);letter-spacing:-.02em;margin:0 0 12px;}
.lp-slack-sub{font-size:clamp(15px,2vw,18px);color:var(--ink2);max-width:600px;margin:0 auto 16px;text-wrap:pretty;}
.lp-slack-note{font-size:13px;color:var(--ink2);max-width:560px;margin:0 auto 20px;line-height:1.55;
  border-top:1px solid var(--line);padding-top:16px;}
.lp-slack-form{display:flex;gap:10px;max-width:540px;margin:0 auto;flex-wrap:wrap;justify-content:center;}
.lp-slack-input{flex:1;min-width:220px;border:1px solid var(--line);background:rgba(255,255,255,.05);color:var(--ink);
  border-radius:99px;font-family:inherit;font-size:15px;padding:14px 22px;outline:none;transition:border-color .12s;}
.lp-slack-input::placeholder{color:var(--ink2);}
.lp-slack-input:focus{border-color:var(--yellow);}
.lp-slack-btn{border:0;background:var(--yellow);color:#111110;border-radius:99px;font-family:inherit;font-size:15px;
  font-weight:700;padding:14px 26px;cursor:pointer;transition:transform .08s ease;box-shadow:0 8px 30px color-mix(in srgb,var(--yellow) 24%,transparent);}
.lp-slack-btn:hover{transform:translateY(-2px);}
.lp-slack-done{font-family:'Space Grotesk';font-weight:700;font-size:clamp(16px,2.4vw,20px);color:var(--yellow);margin:6px 0 0;}

.lp-wait{max-width:720px;margin:0 auto;padding:20px clamp(18px,5vw,32px) 40px;text-align:center;}
.lp-wait-title{font-family:'Space Grotesk';font-weight:700;font-size:clamp(24px,4vw,38px);letter-spacing:-.02em;margin:0 0 26px;}
.lp-wait-btn{border:0;background:var(--yellow);color:#111110;border-radius:99px;font-family:inherit;font-size:clamp(14px,2vw,17px);
  font-weight:700;padding:16px 28px;cursor:pointer;max-width:100%;transition:transform .08s ease,opacity .1s;box-shadow:0 8px 30px color-mix(in srgb,var(--yellow) 26%,transparent);}
.lp-wait-btn:hover:not(:disabled){transform:translateY(-2px);}
.lp-wait-btn:disabled{opacity:.7;cursor:default;background:#2a2a27;color:var(--yellow);box-shadow:none;}
.lp-wait-form{display:flex;gap:10px;max-width:540px;margin:0 auto;flex-wrap:wrap;justify-content:center;}
.lp-wait-input{flex:1;min-width:220px;border:1px solid var(--line);background:rgba(255,255,255,.05);color:var(--ink);
  border-radius:99px;font-family:inherit;font-size:15px;padding:15px 22px;outline:none;transition:border-color .12s;}
.lp-wait-input::placeholder{color:var(--ink2);}
.lp-wait-input:focus{border-color:var(--yellow);}
.lp-wait-hint{font-size:12.5px;color:var(--ink2);margin:12px 0 0;}
.lp-wait-done{font-family:'Space Grotesk';font-weight:700;font-size:clamp(18px,3vw,24px);color:var(--yellow);margin:0;}
.lp-disclaimer{font-size:12px;color:var(--ink2);max-width:560px;margin:22px auto 0;line-height:1.6;}
.lp-proto{font-family:'Space Grotesk';font-weight:600;font-size:13px;color:var(--yellow);margin:14px 0 0;letter-spacing:.02em;}

.lp-foot{border-top:1px solid var(--line);text-align:center;padding:32px 20px 40px;color:var(--ink2);font-size:13px;display:flex;flex-direction:column;align-items:center;gap:14px;}
.lp-foot-brand{display:inline-flex;align-items:center;gap:8px;font-weight:600;color:var(--ink);}
.lp-foot .lp-mark{width:18px;height:18px;color:var(--ink2);}
.lp-foot-liens{display:flex;flex-wrap:wrap;justify-content:center;gap:4px 18px;}
.lp-foot-liens a{color:var(--ink2);text-decoration:none;}
.lp-foot-liens a:hover{color:var(--ink);text-decoration:underline;text-underline-offset:2px;}
.lp-foot-note{opacity:.72;max-width:420px;}
.lp-gate{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px);}
.lp-gate-box{background:#1b1b19;border:1px solid var(--line);border-radius:18px;padding:28px;width:100%;max-width:420px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.5);}
.lp-gate-title{font-family:'Space Grotesk';font-weight:700;font-size:22px;color:var(--ink);margin:0 0 6px;}
.lp-gate-sub{font-size:13.5px;color:var(--ink2);margin:0 0 18px;}
.lp-gate-form{display:flex;flex-direction:column;gap:10px;}
.lp-gate-input{border:1px solid var(--line);background:rgba(255,255,255,.05);color:var(--ink);border-radius:12px;font-family:inherit;font-size:15px;padding:14px 18px;outline:none;transition:border-color .12s;}
.lp-gate-input::placeholder{color:var(--ink2);}
.lp-gate-input:focus{border-color:var(--yellow);}
.lp-gate-btn{border:0;background:var(--yellow);color:#111110;border-radius:12px;font-family:inherit;font-size:16px;font-weight:700;padding:14px;cursor:pointer;transition:transform .08s ease,opacity .1s;}
.lp-gate-btn:hover:not(:disabled){transform:translateY(-1px);}
.lp-gate-btn:disabled{opacity:.7;cursor:progress;}
.lp-gate-cancel{margin-top:12px;border:0;background:none;color:var(--ink2);font-family:inherit;font-size:13px;cursor:pointer;text-decoration:underline;}
@media(prefers-reduced-motion:reduce){.lp-demo,.lp-wait-btn,.lp-slack-btn{transition:none;}}
`;
