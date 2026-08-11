// ---------------------------------------------------------------------------
// Coquille commune aux documents légaux (mentions, confidentialité, CGV, DPA,
// sous-traitants).
//
// Composant SERVEUR : ces pages sont du texte statique, elles n'ont besoin
// d'aucun état client. Elles n'importent donc ni Landing.tsx ni Argentier.tsx,
// et n'embarquent aucun script — un document légal doit rester lisible même
// si tout le reste du site tombe.
//
// La palette reprend celle de la landing (noir profond, jaune) pour que le
// visiteur ne croie pas avoir changé de site. Les polices sont celles du
// système : pas d'appel à Google Fonts ici, contrairement aux deux écrans
// applicatifs — inutile d'exposer l'IP du visiteur à un tiers pour lui servir
// des mentions légales.
// ---------------------------------------------------------------------------

import Link from "next/link";
import type { ReactNode } from "react";

/** Identité de l'éditeur, source unique pour tous les documents légaux. */
export const EDITEUR = {
  denomination: "MAMFORMA",
  forme: "Entreprise individuelle (EI)",
  exploitant: "Kévin MAMERI",
  adresse: "122 rue Amelot, 75011 Paris, France",
  siret: "902 427 145 00013",
  siren: "902 427 145",
  email: "bonjour@mamforma.fr",
  telephone: "01 84 80 24 02",
  service: "Argentier",
  domaine: "getargentier.com",
} as const;

/**
 * Hébergeur déclaré. À MAINTENIR EXACT : la loi impose de nommer l'hébergeur
 * réel, et il change avec la plateforme de déploiement. Une seule constante à
 * modifier le jour d'une bascule.
 */
export const HEBERGEUR = {
  nom: "Cloudflare, Inc.",
  adresse: "101 Townsend Street, San Francisco, CA 94107, États-Unis",
  contact: "https://www.cloudflare.com",
  precision:
    "Les données applicatives (base D1) sont stockées dans la région " +
    "« Europe de l'Ouest » (WEUR) et ne quittent pas l'Union européenne.",
} as const;

/** Date de dernière révision, affichée en tête de chaque document. */
export const DERNIERE_MISE_A_JOUR = "11 août 2026";

const DOCUMENTS = [
  { href: "/mentions-legales", titre: "Mentions légales" },
  { href: "/confidentialite", titre: "Confidentialité" },
  { href: "/cgv", titre: "CGV" },
  { href: "/dpa", titre: "Sous-traitance (DPA)" },
  { href: "/sous-traitants", titre: "Sous-traitants" },
] as const;

const CSS = `
.dl{--bg:#111110;--ink:#FFFFFF;--ink2:#B4B2AC;--line:rgba(255,255,255,.14);--yellow:#F5D312;
  background:var(--bg);color:var(--ink2);min-height:100vh;line-height:1.65;
  font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased;}
.dl *{box-sizing:border-box;}
.dl-nav{position:sticky;top:0;z-index:10;display:flex;align-items:center;justify-content:space-between;gap:16px;
  flex-wrap:wrap;padding:14px clamp(18px,5vw,64px);background:rgba(17,17,16,.92);
  backdrop-filter:blur(10px);border-bottom:1px solid var(--line);}
.dl-brand{color:var(--ink);font-weight:700;font-size:17px;text-decoration:none;letter-spacing:-.01em;}
.dl-brand span{color:var(--yellow);}
.dl-nav-links{display:flex;gap:4px;flex-wrap:wrap;}
.dl-nav-links a{color:var(--ink2);text-decoration:none;font-size:13px;padding:5px 9px;border-radius:6px;}
.dl-nav-links a:hover{color:var(--ink);background:rgba(255,255,255,.08);}
.dl-nav-links a[aria-current="page"]{color:#111110;background:var(--yellow);font-weight:600;}
.dl-wrap{max-width:820px;margin:0 auto;padding:clamp(32px,6vw,64px) clamp(18px,5vw,32px) 80px;}
.dl-maj{font-size:13px;color:var(--ink2);opacity:.75;margin:0 0 8px;}
.dl h1{color:var(--ink);font-size:clamp(28px,5vw,42px);line-height:1.1;letter-spacing:-.02em;margin:0 0 12px;font-weight:700;}
.dl-chapo{font-size:clamp(16px,2vw,18px);color:var(--ink2);margin:0 0 40px;}
.dl h2{color:var(--ink);font-size:clamp(19px,2.6vw,24px);line-height:1.25;letter-spacing:-.01em;
  margin:44px 0 14px;padding-top:22px;border-top:1px solid var(--line);font-weight:600;}
.dl h3{color:var(--ink);font-size:16px;margin:26px 0 8px;font-weight:600;}
.dl p{margin:0 0 14px;}
.dl strong{color:var(--ink);font-weight:600;}
.dl a{color:var(--yellow);text-decoration:underline;text-underline-offset:2px;}
.dl ul,.dl ol{margin:0 0 16px;padding-left:22px;}
.dl li{margin-bottom:8px;}
.dl-def{border-left:2px solid var(--yellow);padding:2px 0 2px 16px;margin:0 0 16px;}
.dl-note{border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:0 0 20px;background:rgba(255,255,255,.03);}
.dl-note p:last-child{margin-bottom:0;}
.dl-tableau{width:100%;overflow-x:auto;margin:0 0 20px;-webkit-overflow-scrolling:touch;}
.dl table{width:100%;border-collapse:collapse;font-size:14px;min-width:560px;}
.dl th,.dl td{text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid var(--line);}
.dl th{color:var(--ink);font-weight:600;white-space:nowrap;}
.dl-fiche{list-style:none;padding:0;margin:0 0 20px;}
.dl-fiche li{display:flex;flex-wrap:wrap;gap:4px 12px;padding:9px 0;border-bottom:1px solid var(--line);margin:0;}
.dl-fiche b{color:var(--ink);font-weight:600;min-width:210px;}
.dl-foot{border-top:1px solid var(--line);padding:26px clamp(18px,5vw,32px) 44px;text-align:center;font-size:13px;}
.dl-foot a{color:var(--ink2);text-decoration:none;margin:0 8px;}
.dl-foot a:hover{color:var(--ink);text-decoration:underline;}
`;

export default function DocumentLegal({
  titre,
  chapo,
  chemin,
  children,
}: {
  titre: string;
  chapo: ReactNode;
  chemin: string;
  children: ReactNode;
}) {
  return (
    <div className="dl">
      <style>{CSS}</style>

      <nav className="dl-nav">
        <Link href="/" className="dl-brand">
          Argentier<span>.</span>
        </Link>
        <div className="dl-nav-links">
          {DOCUMENTS.map((d) => (
            <Link
              key={d.href}
              href={d.href}
              aria-current={d.href === chemin ? "page" : undefined}
            >
              {d.titre}
            </Link>
          ))}
        </div>
      </nav>

      <main className="dl-wrap">
        <p className="dl-maj">Dernière mise à jour : {DERNIERE_MISE_A_JOUR}</p>
        <h1>{titre}</h1>
        <div className="dl-chapo">{chapo}</div>
        {children}
      </main>

      <footer className="dl-foot">
        <Link href="/">Accueil</Link>
        {DOCUMENTS.filter((d) => d.href !== chemin).map((d) => (
          <Link key={d.href} href={d.href}>
            {d.titre}
          </Link>
        ))}
      </footer>
    </div>
  );
}
