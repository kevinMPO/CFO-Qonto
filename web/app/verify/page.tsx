"use client";

/**
 * /verify?token=… — page de confirmation d'email.
 *
 * Le lien reçu par email pointe ici (GET). C'est ensuite un POST piloté par JS
 * qui confirme (via le Worker `/auth/verify`) : un scanner d'email qui
 * pré-charge le lien en GET ne consomme donc PAS le jeton à usage unique.
 */

import React, { useEffect, useState } from "react";

import type { Lang } from "@/lib/types";
import { detectLang } from "@/lib/i18n";
import { verifyEmail } from "@/lib/account";

const L = (lang: Lang, m: Record<Lang, string>) => m[lang] ?? m.en;

type Etat = "verifying" | "ok" | "error";

export default function VerifyPage() {
  const [lang, setLang] = useState<Lang>("fr");
  const [etat, setEtat] = useState<Etat>("verifying");

  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem("argentier-lang") : null;
    setLang((["fr", "en", "de", "es", "it"] as Lang[]).includes(saved as Lang) ? (saved as Lang) : detectLang(navigator.language));

    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    if (!token) {
      setEtat("error");
      return;
    }
    verifyEmail(token).then((r) => setEtat(r.ok ? "ok" : "error"));
  }, []);

  return (
    <div className="vf">
      <style>{CSS}</style>
      <div className="vf-card">
        {etat === "verifying" && (
          <>
            <div className="vf-spin" aria-hidden="true" />
            <p className="vf-title">
              {L(lang, { fr: "Confirmation en cours…", en: "Confirming…", de: "Bestätigung läuft…", es: "Confirmando…", it: "Conferma in corso…" })}
            </p>
          </>
        )}
        {etat === "ok" && (
          <>
            <div className="vf-mark vf-ok" aria-hidden="true">✓</div>
            <p className="vf-title">
              {L(lang, { fr: "Email confirmé", en: "Email confirmed", de: "E-Mail bestätigt", es: "Email confirmado", it: "Email confermata" })}
            </p>
            <p className="vf-sub">
              {L(lang, {
                fr: "Ton compte est activé. Tu peux connecter ton compte Qonto en lecture seule.",
                en: "Your account is active. You can connect your Qonto account read-only.",
                de: "Dein Konto ist aktiv. Du kannst dein Qonto-Konto nur lesend verbinden.",
                es: "Tu cuenta está activa. Puedes conectar tu cuenta Qonto en solo lectura.",
                it: "Il tuo account è attivo. Puoi collegare il tuo conto Qonto in sola lettura.",
              })}
            </p>
            <a className="vf-btn" href="/">
              {L(lang, { fr: "Aller sur Argentier →", en: "Go to Argentier →", de: "Zu Argentier →", es: "Ir a Argentier →", it: "Vai su Argentier →" })}
            </a>
          </>
        )}
        {etat === "error" && (
          <>
            <div className="vf-mark vf-err" aria-hidden="true">!</div>
            <p className="vf-title">
              {L(lang, { fr: "Lien invalide ou expiré", en: "Invalid or expired link", de: "Ungültiger oder abgelaufener Link", es: "Enlace no válido o caducado", it: "Link non valido o scaduto" })}
            </p>
            <p className="vf-sub">
              {L(lang, {
                fr: "Reconnecte-toi et demande un nouvel email de confirmation depuis Argentier.",
                en: "Log back in and request a new confirmation email from Argentier.",
                de: "Melde dich erneut an und fordere eine neue Bestätigungs-E-Mail an.",
                es: "Vuelve a iniciar sesión y solicita un nuevo email de confirmación.",
                it: "Accedi di nuovo e richiedi una nuova email di conferma.",
              })}
            </p>
            <a className="vf-btn" href="/">
              {L(lang, { fr: "Retour à Argentier", en: "Back to Argentier", de: "Zurück zu Argentier", es: "Volver a Argentier", it: "Torna su Argentier" })}
            </a>
          </>
        )}
      </div>
    </div>
  );
}

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=Inter:wght@400;500;600&display=swap');
.vf{--bg:#111110;--ink:#fff;--ink2:#B4B2AC;--line:rgba(255,255,255,.14);--yellow:#F5D312;
  background:var(--bg);color:var(--ink);font-family:'Inter',system-ui,sans-serif;min-height:100vh;
  display:flex;align-items:center;justify-content:center;padding:24px;}
.vf-card{background:#1b1b19;border:1px solid var(--line);border-radius:20px;padding:40px 32px;max-width:440px;width:100%;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.5);}
.vf-title{font-family:'Space Grotesk';font-weight:700;font-size:22px;margin:18px 0 8px;}
.vf-sub{font-size:14px;color:var(--ink2);line-height:1.6;margin:0 0 22px;}
.vf-mark{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto;font-size:28px;font-weight:700;}
.vf-ok{background:var(--yellow);color:#111110;}
.vf-err{background:#3a2a2a;color:#ff8f8f;border:1px solid #ff8f8f;}
.vf-btn{display:inline-block;background:var(--yellow);color:#111110;font-weight:700;text-decoration:none;padding:13px 26px;border-radius:99px;font-size:15px;}
.vf-spin{width:40px;height:40px;border-radius:50%;border:3px solid var(--line);border-top-color:var(--yellow);margin:0 auto;animation:vf-rot .8s linear infinite;}
@keyframes vf-rot{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.vf-spin{animation:none}}
`;
