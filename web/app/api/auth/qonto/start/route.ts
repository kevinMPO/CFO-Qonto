// ---------------------------------------------------------------------------
// GET /api/auth/qonto/start — départ du flux OAuth 2.1 (PKCE, client public).
//
// Trois choses, dans cet ordre :
//   1. fabriquer le couple PKCE (`code_verifier` / `code_challenge` S256) et le
//      `state` anti-CSRF ;
//   2. les DÉPOSER côté navigateur dans deux cookies httpOnly, éphémères et
//      limités au chemin `/api/auth/qonto` — le serveur ne garde aucun état,
//      ce qui rend la route compatible avec un runtime sans mémoire partagée ;
//   3. rediriger vers le serveur d'autorisation.
//
// Le `code_verifier` est le secret qui prouvera, au callback, que c'est bien
// nous qui avons demandé le code. Il ne doit jamais être lisible par un script
// de la page (httpOnly), ni voyager sur un autre chemin que celui du flux.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";
import { buildAuthorizationUrl } from "@/lib/auth/oauth-client";
import { createPkcePair, generateState } from "@/lib/auth/pkce";
import { activeProvider } from "@/lib/auth/providers";
import {
  NOM_COOKIE_STATE,
  NOM_COOKIE_VERIFIER,
  optionsCookieOAuth,
} from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * Le proxy MCP de Qonto n'accepte comme `redirect_uri` que du LOOPBACK
 * (`http://localhost:*`, `http://127.0.0.1:*`) ou une URI inscrite dans sa
 * liste blanche codée en dur. Mesuré : toute autre origine reçoit un
 * `400 invalid redirect_uri`.
 *
 * Conséquence, tant que Qonto n'a pas inscrit notre URI : sur un domaine
 * hébergé, ce flux ne PEUT pas aboutir. On refuse donc de partir plutôt que
 * d'envoyer l'utilisateur se heurter à une page d'erreur OAuth brute chez un
 * tiers — c'est illisible, et ça donne l'impression que le produit est cassé
 * alors que c'est une restriction de la plateforme d'en face.
 */
function origineAcceptableParQonto(redirectUri: string): boolean {
  let hote: string;
  try {
    hote = new URL(redirectUri).hostname;
  } catch {
    return false;
  }
  return hote === "localhost" || hote === "127.0.0.1" || hote === "[::1]";
}

export async function GET(): Promise<Response> {
  let urlAutorisation: string;
  let codeVerifier: string;
  let state: string;

  try {
    // `activeProvider()` lève si la configuration est incohérente : mieux vaut
    // un 500 explicite qu'une redirection vers un serveur d'autorisation
    // improvisé.
    const provider = activeProvider();

    // Garde-fou : sur une origine que Qonto refusera, on s'arrête ici.
    if (provider.id === "mcp-proxy" && !origineAcceptableParQonto(provider.redirectUri)) {
      console.warn(
        `[argentier][oauth] Départ refusé : le proxy MCP de Qonto n'accepte ` +
          `pas la redirect_uri « ${provider.redirectUri} » (loopback ou liste ` +
          `blanche uniquement).`,
      );
      return NextResponse.json(
        {
          error: "connexion_indisponible",
          message:
            "La connexion directe à ton compte Qonto n'est pas encore ouverte " +
            "sur ce domaine : Qonto doit d'abord autoriser l'adresse de retour " +
            "d'Argentier. En attendant, la démonstration fonctionne avec un " +
            "jeu de données d'exemple.",
          message_en:
            "Connecting your Qonto account is not yet available on this domain: " +
            "Qonto must first allow Argentier's callback address. Meanwhile, the " +
            "demo runs on sample data.",
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    const pkce = await createPkcePair();
    codeVerifier = pkce.codeVerifier;
    state = generateState();
    urlAutorisation = buildAuthorizationUrl(provider, {
      codeChallenge: pkce.codeChallenge,
      state,
    });
  } catch (erreur) {
    console.error("[argentier][oauth] Départ du flux impossible :", erreur);
    return NextResponse.json(
      { error: "configuration_oauth", message: "Connexion Qonto indisponible : configuration OAuth incomplète." },
      { status: 500 },
    );
  }

  const reponse = NextResponse.redirect(urlAutorisation, 302);
  const options = optionsCookieOAuth();
  reponse.cookies.set(NOM_COOKIE_VERIFIER, codeVerifier, options);
  reponse.cookies.set(NOM_COOKIE_STATE, state, options);
  // Aucun cache : ces cookies sont à usage unique et le `state` ne doit jamais
  // être resservi par un intermédiaire.
  reponse.headers.set("Cache-Control", "no-store");
  return reponse;
}
