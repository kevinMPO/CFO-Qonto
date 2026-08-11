// ---------------------------------------------------------------------------
// Configuration Next.js d'Argentier.
//
// L'essentiel de ce fichier, ce sont les EN-TÊTES DE SÉCURITÉ : un pentest sur
// / et /demo n'en a trouvé aucun (ni CSP, ni X-Frame-Options, ni nosniff, ni
// Referrer-Policy, ni HSTS). Sur un produit qui affiche un compte bancaire,
// c'est le minimum vital, et c'est posé ici pour TOUTES les routes plutôt que
// dans un middleware — un middleware s'oublie, une entrée `headers()` non.
//
// La CSP est écrite à partir de ce que l'application appelle RÉELLEMENT depuis
// le navigateur, vérifié dans `app/` :
//   - `<style>{CSS}</style>` inline (Landing.tsx, Argentier.tsx) + `@import`
//     de fonts.googleapis.com  → style-src 'unsafe-inline' + googleapis ;
//   - hydratation Next 15, qui injecte `self.__next_f.push(...)` en inline
//     → script-src 'self' 'unsafe-inline'. Les nonces exigeraient un
//     middleware sur chaque requête ; c'est le compromis assumé ;
//   - widget vocal ElevenLabs, chargé depuis unpkg.com et parlant à l'API
//     ElevenLabs (NEXT_PUBLIC_ELEVENLABS_AGENT_ID) ;
//   - liste d'attente postée au Worker argentier-mcp ;
//   - narration TTS lue depuis un `blob:` fabriqué par /api/voice.
// Toute nouvelle destination réseau côté navigateur DOIT être ajoutée ici,
// sinon elle sera bloquée — c'est le but.
// ---------------------------------------------------------------------------

/** Vrai en `next dev` : le HMR de Next a besoin d'`eval`, la prod non. */
const developpement = process.env.NODE_ENV === "development";

/** Worker Cloudflare qui encaisse les inscriptions à la liste d'attente. */
const WORKER_LISTE_ATTENTE = "https://argentier-mcp.bonjour-e83.workers.dev";

/**
 * Politique de sécurité du contenu, directive par directive.
 * Chaque entrée est justifiée : une directive qu'on ne sait pas expliquer est
 * une directive à retirer.
 */
const CSP = [
  // Tout ce qui n'est pas listé plus bas est interdit hors de l'origine.
  "default-src 'self'",
  // Hydratation Next (inline) + widget conversationnel ElevenLabs (unpkg).
  `script-src 'self' 'unsafe-inline' https://unpkg.com${developpement ? " 'unsafe-eval'" : ""}`,
  // Feuilles inline des deux écrans + polices Google importées par CSS.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  // Images : rien d'externe n'est référencé aujourd'hui ; `data:` et `blob:`
  // servent aux SVG inline et aux ressources fabriquées côté client.
  "img-src 'self' data: blob:",
  // Audio de la narration : un `blob:` construit à partir de /api/voice.
  "media-src 'self' blob: data:",
  // Sorties réseau du navigateur, énumérées.
  [
    "connect-src 'self'",
    WORKER_LISTE_ATTENTE,
    // Q&A vocal ElevenLabs : API REST, WebSocket temps réel et transport
    // WebRTC (LiveKit) du widget embarqué.
    "https://api.elevenlabs.io",
    "wss://api.elevenlabs.io",
    "https://api.us.elevenlabs.io",
    "wss://api.us.elevenlabs.io",
    "https://*.livekit.cloud",
    "wss://*.livekit.cloud",
    // Le script du widget est récupéré depuis unpkg.
    "https://unpkg.com",
  ].join(" "),
  // Le widget peut créer un worker à partir d'un blob (traitement audio).
  "worker-src 'self' blob:",
  // Aucune iframe tierce n'est attendue.
  "frame-src 'self'",
  // Argentier ne doit JAMAIS être encadré : pas de clickjacking sur un écran
  // qui affiche un solde bancaire.
  "frame-ancestors 'none'",
  // Verrous génériques : pas de plugin, pas de <base> détournée, pas de POST
  // vers un domaine tiers depuis un formulaire de la page.
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/**
 * En-têtes appliqués à toutes les routes, pages comme API.
 * HSTS est inoffensif en local (les navigateurs l'ignorent sur http://).
 */
const EN_TETES_SECURITE = [
  { key: "Content-Security-Policy", value: CSP },
  // Doublon volontaire de `frame-ancestors`, pour les navigateurs anciens.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    // Le micro reste ouvert à l'origine : le Q&A vocal en a besoin. Tout le
    // reste est coupé.
    key: "Permissions-Policy",
    value: [
      "accelerometer=()",
      "camera=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "payment=()",
      "usb=()",
      "microphone=(self)",
    ].join(", "),
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Ne pas annoncer la version du framework servi.
  poweredByHeader: false,

  async headers() {
    return [{ source: "/:chemin*", headers: EN_TETES_SECURITE }];
  },
};

export default nextConfig;
