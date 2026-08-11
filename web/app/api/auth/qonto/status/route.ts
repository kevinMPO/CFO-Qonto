// ---------------------------------------------------------------------------
// GET /api/auth/qonto/status — état de la connexion Qonto, pour l'interface.
//
// Contrat (stable, consommé par le front) :
//   { connected, orgName?, readOnly, scopesAreWriteCapable }
//
// Ce que la route ne fait JAMAIS :
//   - exposer le jeton, son scope brut, sa date d'expiration ou son empreinte ;
//   - déclencher un rafraîchissement (un simple affichage ne doit pas consommer
//     un refresh token) ni le moindre appel à Qonto.
//
// Les deux derniers champs disent la vérité, même quand elle est désagréable :
//   - `readOnly: true` — Argentier n'émet que des lectures ; c'est l'allowlist
//     applicative (`lib/mcp/readonly-guard.ts`) qui l'impose, avant chaque
//     appel réseau. Cette affirmation n'a de valeur que si l'allowlist est le
//     SEUL chemin vers Qonto : elle l'était à une exception près (le client par
//     clé API statique `lib/qonto.ts`, qui appelait `fetch` sans garde), et
//     cette exception a été SUPPRIMÉE. L'unicité du chemin n'est plus une
//     intention de commentaire, elle est vérifiée à l'échelle du dépôt par
//     `lib/mcp/__tests__/invariant-fetch-qonto.test.ts` : tout module de `lib/`
//     ou `app/` qui appelle `fetch` sur un hôte Qonto doit passer par
//     `assertReadOnly`, sous peine de test rouge ;
//   - `scopesAreWriteCapable` — le JETON, lui, porte des droits d'écriture
//     qu'aujourd'hui le serveur d'autorisation de Qonto refuse de restreindre.
//     Le dire au lieu de le taire est la seule position honnête, et ce champ
//     passera à `false` tout seul le jour d'un client OAuth dédié en lecture.
// ---------------------------------------------------------------------------

import { NextResponse } from "next/server";
import { activeProvider } from "@/lib/auth/providers";
import { lireSession } from "@/lib/auth/session";
import { getTokenStore } from "@/lib/auth/token-store";
import { getOrganizationById } from "@/lib/db/tenant";
import { baseD1SiPresente, bindingsArgentier } from "@/lib/runtime/bindings";

export const dynamic = "force-dynamic";

export async function GET(requete: Request): Promise<Response> {
  // Le jeton peut porter des droits d'écriture : on le sait par la description
  // du provider, jamais en inspectant le jeton lui-même.
  let scopesAreWriteCapable = true;
  try {
    scopesAreWriteCapable = !activeProvider().readOnly;
  } catch {
    // Configuration OAuth incomplète : on reste sur l'hypothèse prudente.
  }

  const enveloppe = {
    // Invariant produit : toute requête Qonto traverse l'allowlist read-only.
    readOnly: true,
    scopesAreWriteCapable,
  };

  const session = await lireSession(requete).catch(() => null);
  if (!session) {
    return sansCache(NextResponse.json({ connected: false, ...enveloppe }));
  }

  const bindings = bindingsArgentier();

  // « Connecté » = il reste un jeu de jetons stocké pour ce locataire. On lit
  // sa présence, jamais son contenu.
  let connected = false;
  try {
    connected = (await getTokenStore(bindings).get(session.orgId)) !== null;
  } catch (erreur) {
    console.error("[argentier][oauth] Lecture du token store impossible :", erreur);
  }

  let orgName: string | undefined;
  // Variante de diagnostic : une route d'état ne doit pas tomber en 500 parce
  // qu'un binding manque — c'est justement l'état qu'elle est là pour observer.
  const db = baseD1SiPresente(bindings);
  if (connected && db) {
    try {
      const organisation = await getOrganizationById(db, session.orgId);
      orgName = organisation?.legalName ?? undefined;
    } catch (erreur) {
      console.error("[argentier][oauth] Lecture de l'organisation impossible :", erreur);
    }
  }

  return sansCache(NextResponse.json({ connected, orgName, ...enveloppe }));
}

/** Un état de connexion ne se met jamais en cache. */
function sansCache(reponse: NextResponse): NextResponse {
  reponse.headers.set("Cache-Control", "no-store");
  return reponse;
}
