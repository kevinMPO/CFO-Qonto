// ---------------------------------------------------------------------------
// Politique de confidentialité — articles 12 à 14 du RGPD.
//
// RÈGLE D'ÉCRITURE DE CE FICHIER : chaque affirmation doit être vérifiable dans
// le code. Les durées viennent de lib/auth/session.ts et lib/auth/token-store.ts,
// la liste des destinataires de ce que l'application appelle réellement (voir la
// CSP de next.config.mjs, qui énumère les sorties navigateur). Si le code
// change, cette page change AVEC — une politique fausse est pire qu'absente.
// ---------------------------------------------------------------------------

import type { Metadata } from "next";
import DocumentLegal, { EDITEUR } from "../legal/DocumentLegal";

export const metadata: Metadata = {
  title: "Politique de confidentialité — Argentier",
  description:
    "Quelles données Argentier traite, pourquoi, combien de temps, avec qui, " +
    "et quels sont vos droits.",
};

export default function Confidentialite() {
  return (
    <DocumentLegal
      chemin="/confidentialite"
      titre="Politique de confidentialité"
      chapo={
        <>
          Argentier lit des données bancaires. Cette page dit exactement
          lesquelles, pourquoi, pendant combien de temps et qui d’autre les voit.
          Sans détour.
        </>
      }
    >
      <h2>1. Qui est responsable</h2>
      <p>
        Le responsable du traitement est <strong>{EDITEUR.denomination}</strong>{" "}
        ({EDITEUR.forme}), {EDITEUR.adresse}, SIRET {EDITEUR.siret}, exploitant
        le service Argentier sur {EDITEUR.domaine}.
      </p>
      <p>
        Contact pour toute question relative aux données personnelles :{" "}
        <a href={`mailto:${EDITEUR.email}`}>{EDITEUR.email}</a>. Aucun délégué à
        la protection des données n’est désigné, la désignation n’étant pas
        obligatoire au regard de l’activité ; les demandes sont traitées
        directement par l’exploitant.
      </p>
      <div className="dl-note">
        <p>
          <strong>Deux rôles distincts, à ne pas confondre.</strong> Pour les
          visiteurs du site, {EDITEUR.denomination} est{" "}
          <strong>responsable de traitement</strong>. Pour les données bancaires
          de ses clients professionnels, {EDITEUR.denomination} agit en{" "}
          <strong>sous-traitant</strong> au sens de l’article 28 du RGPD : c’est
          le client qui décide de la finalité. Le cadre de cette sous-traitance
          est fixé par l’<a href="/dpa">accord de sous-traitance</a>.
        </p>
      </div>

      <h2>2. Quelles données, pour quoi, sur quelle base</h2>
      <div className="dl-tableau">
        <table>
          <thead>
            <tr>
              <th>Donnée</th>
              <th>Finalité</th>
              <th>Base légale</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Adresse électronique (liste d’attente)</td>
              <td>Vous prévenir de l’ouverture du service</td>
              <td>Consentement (art. 6.1.a)</td>
            </tr>
            <tr>
              <td>
                Transactions du compte professionnel : libellé, marchand,
                montant, date, devise, type d’opération
              </td>
              <td>
                Détecter abonnements récurrents, doublons et frais de change ;
                classer les dépenses en professionnel / personnel
              </td>
              <td>Exécution du contrat (art. 6.1.b)</td>
            </tr>
            <tr>
              <td>Raison sociale, solde, IBAN du compte analysé</td>
              <td>Identifier le compte et restituer l’analyse</td>
              <td>Exécution du contrat</td>
            </tr>
            <tr>
              <td>Jetons d’accès OAuth Qonto</td>
              <td>Lire le compte sans stocker vos identifiants bancaires</td>
              <td>Exécution du contrat</td>
            </tr>
            <tr>
              <td>Identifiant de session (cookie)</td>
              <td>Vous reconnaître d’une page à l’autre</td>
              <td>Intérêt légitime — cookie strictement nécessaire</td>
            </tr>
            <tr>
              <td>Journal d’accès : date, opération, résultat</td>
              <td>
                Tracer chaque lecture du compte, détecter un abus, prouver ce
                qui a été consulté
              </td>
              <td>Intérêt légitime (art. 6.1.f) — sécurité</td>
            </tr>
            <tr>
              <td>Décisions d’optimisation et économies constatées</td>
              <td>Suivre les économies prouvées et établir la facturation</td>
              <td>Exécution du contrat · obligation comptable</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        <strong>Aucun profilage, aucune décision automatisée</strong> produisant
        des effets juridiques à votre égard n’est mis en œuvre. Argentier
        propose ; vous décidez. Vos données ne sont{" "}
        <strong>jamais vendues, louées ni cédées</strong>, et ne servent{" "}
        <strong>pas à entraîner de modèle d’intelligence artificielle</strong>.
      </p>

      <h2>3. Vos identifiants bancaires ne nous sont jamais transmis</h2>
      <p>
        La connexion à Qonto se fait par <strong>OAuth 2.1 avec PKCE</strong> :
        vous vous authentifiez chez Qonto, sur son domaine, et Argentier ne
        reçoit qu’un jeton d’accès révocable. Nous ne voyons ni votre mot de
        passe, ni votre second facteur.
      </p>
      <p>
        Les jetons sont <strong>chiffrés au repos en AES-GCM 256 bits</strong>{" "}
        avant d’être écrits, avec un vecteur d’initialisation régénéré à chaque
        écriture. Ils ne sont jamais renvoyés au navigateur, jamais journalisés,
        jamais inclus dans un message d’erreur.
      </p>
      <div className="dl-note">
        <p>
          <strong>Le jeton demandé ne permet que de lire.</strong> Argentier
          sollicite explicitement des autorisations en lecture seule —
          consultation de l’organisation, des comptes, des opérations, des
          justificatifs — et aucune autorisation d’écriture. Vous pouvez le
          constater sur l’écran de consentement de Qonto avant d’accepter :
          aucune ligne n’y mentionne de virement, de carte ni de modification.
        </p>
        <p>
          Une seconde barrière s’ajoute à la première, parce qu’une garantie
          unique n’en est pas une : un contrôle interne n’autorise que des
          requêtes de lecture sur une liste fermée d’adresses et rejette tout le
          reste, et un test automatisé fait échouer la mise en production si
          quiconque ajoute un appel qui le contournerait.
        </p>
      </div>

      <h2>4. Combien de temps</h2>
      <div className="dl-tableau">
        <table>
          <thead>
            <tr>
              <th>Donnée</th>
              <th>Durée</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Cookies temporaires de connexion OAuth</td>
              <td>10 minutes</td>
            </tr>
            <tr>
              <td>Cookie de session</td>
              <td>30 jours, ou jusqu’à déconnexion</td>
            </tr>
            <tr>
              <td>Jetons d’accès OAuth</td>
              <td>
                Durée de validité du jeton de renouvellement ; supprimés
                immédiatement en cas de révocation
              </td>
            </tr>
            <tr>
              <td>Transactions bancaires analysées</td>
              <td>
                Non conservées durablement : analysées à la demande, sur une
                fenêtre glissante de 90 jours maximum
              </td>
            </tr>
            <tr>
              <td>Décisions et économies prouvées</td>
              <td>
                Durée de la relation contractuelle, puis 10 ans au titre des
                obligations comptables
              </td>
            </tr>
            <tr>
              <td>Journal d’accès</td>
              <td>12 mois</td>
            </tr>
            <tr>
              <td>Adresse électronique (liste d’attente)</td>
              <td>3 ans à compter du dernier contact</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        Lorsque vous débranchez votre compte, les jetons sont supprimés et vos
        sessions en cours cessent d’être valides. Les données strictement
        nécessaires à une obligation légale ou à la preuve d’une facturation sont
        conservées jusqu’au terme du délai applicable, puis effacées.
      </p>

      <h2>5. Qui d’autre voit vos données</h2>
      <p>
        La liste complète et à jour, avec les rôles et les localisations, figure
        sur la page <a href="/sous-traitants">sous-traitants</a>. En résumé :
      </p>
      <ul>
        <li>
          <strong>Cloudflare</strong> — hébergement, stockage des jetons et base
          de données. La base est en région <strong>Europe de l’Ouest</strong>.
        </li>
        <li>
          <strong>Anthropic</strong> — classement des dépenses et rédaction des
          courriers.
        </li>
        <li>
          <strong>Linkup</strong> — recherche des prix publics du marché.
        </li>
        <li>
          <strong>ElevenLabs</strong> — synthèse et reconnaissance vocales, si
          vous utilisez la narration ou le dialogue vocal.
        </li>
      </ul>
      <div className="dl-note">
        <p>
          <strong>Ce qui sort vers ces prestataires est délibérément pauvre.</strong>{" "}
          Vers Anthropic et Linkup, seuls le <strong>nom du marchand</strong> et
          la <strong>catégorie</strong> sont transmis. Ni IBAN, ni identifiant de
          transaction, ni numéro de compte, ni solde, ni donnée nominative. Un
          filtre s’exécute <strong>avant chaque envoi</strong> et interrompt
          l’opération s’il détecte une donnée interdite — il ne se contente pas
          d’avertir, il bloque.
        </p>
      </div>

      <h3>Transferts hors Union européenne</h3>
      <p>
        Anthropic et ElevenLabs sont établis aux <strong>États-Unis</strong>.
        Ces transferts s’appuient sur les{" "}
        <strong>clauses contractuelles types</strong> de la Commission
        européenne. S’agissant d’Anthropic et de Linkup, le contenu transmis ne
        comporte, par construction, aucune donnée personnelle identifiante.
      </p>

      <h3>Deux appels tiers depuis votre navigateur</h3>
      <p>
        En toute transparence, l’affichage du service déclenche deux requêtes
        vers des tiers, qui reçoivent de ce fait votre{" "}
        <strong>adresse IP</strong> et les caractéristiques de votre navigateur :
      </p>
      <ul>
        <li>
          <strong>Google Fonts</strong> (Google Ireland Limited), pour les
          polices de caractères des écrans applicatifs. Ces pages légales, elles,
          n’y font pas appel.
        </li>
        <li>
          <strong>unpkg</strong>, pour charger le composant de dialogue vocal
          ElevenLabs, uniquement sur la page de démonstration.
        </li>
      </ul>
      <p>
        Aucune de ces requêtes ne dépose de cookie publicitaire et aucune ne sert
        à vous suivre. Nous prévoyons d’héberger nous-mêmes ces ressources afin
        de supprimer ces transferts.
      </p>

      <h2>6. Cookies</h2>
      <p>
        Argentier <strong>ne dépose aucun cookie publicitaire</strong>, aucun
        traceur, aucun outil de mesure d’audience. Aucun bandeau de consentement
        n’est donc affiché : ce serait vous demander une autorisation dont nous
        n’avons pas besoin.
      </p>
      <p>Les seuls cookies déposés sont :</p>
      <ul>
        <li>
          un <strong>cookie de session signé</strong>, qui ne contient qu’un
          identifiant opaque — ni votre nom, ni votre IBAN, ni aucune donnée
          bancaire ;
        </li>
        <li>
          deux <strong>cookies temporaires</strong> de 10 minutes, qui sécurisent
          la connexion à Qonto contre le détournement de requête.
        </li>
      </ul>
      <p>
        Tous sont <code>HttpOnly</code> (inaccessibles au JavaScript),{" "}
        <code>SameSite</code> et, en production, <code>Secure</code>. Ils sont{" "}
        <strong>strictement nécessaires</strong> au fonctionnement du service au
        sens de l’article 82 de la loi Informatique et Libertés, et donc exemptés
        de consentement.
      </p>

      <h2>7. Vos droits</h2>
      <p>
        Vous disposez des droits d’<strong>accès</strong>, de{" "}
        <strong>rectification</strong>, d’<strong>effacement</strong>, de{" "}
        <strong>limitation</strong>, d’<strong>opposition</strong> et à la{" "}
        <strong>portabilité</strong> de vos données, ainsi que du droit de
        retirer votre consentement à tout moment lorsque le traitement repose sur
        celui-ci.
      </p>
      <p>
        Deux droits sont exerçables <strong>immédiatement, sans nous écrire</strong> :
      </p>
      <ul>
        <li>
          <strong>retirer l’accès à votre compte</strong> — le débranchement
          supprime les jetons et invalide vos sessions ;
        </li>
        <li>
          <strong>vous désinscrire de la liste d’attente</strong> — par simple
          demande à l’adresse ci-dessous, traitée sans condition.
        </li>
      </ul>
      <p>
        Pour tout le reste, écrivez à{" "}
        <a href={`mailto:${EDITEUR.email}`}>{EDITEUR.email}</a>. Nous répondons
        sous <strong>un mois</strong>. Si vous estimez vos droits méconnus, vous
        pouvez saisir la{" "}
        <a
          href="https://www.cnil.fr/fr/plaintes"
          rel="noreferrer noopener"
          target="_blank"
        >
          CNIL
        </a>
        , 3 place de Fontenoy, 75007 Paris.
      </p>

      <h2>8. Sécurité</h2>
      <ul>
        <li>Chiffrement de bout en bout des échanges (HTTPS, HSTS).</li>
        <li>Jetons bancaires chiffrés au repos en AES-GCM 256 bits.</li>
        <li>
          Cloisonnement des clients : chaque requête en base porte
          l’identifiant du locataire, sans exception.
        </li>
        <li>
          Lecture seule imposée par le code, sur une liste fermée d’adresses,
          vérifiée par des tests automatisés qui bloquent la mise en production.
        </li>
        <li>Journal d’accès pour chaque lecture du compte.</li>
        <li>
          Contrôle automatique interdisant qu’un secret ou une donnée bancaire
          soit versé au code source.
        </li>
      </ul>
      <p>
        Aucun dispositif n’est infaillible. En cas de violation de données
        présentant un risque pour vos droits, vous serez informé{" "}
        <strong>sans délai injustifié</strong>, et la CNIL dans les{" "}
        <strong>72 heures</strong>, conformément aux articles 33 et 34 du RGPD.
      </p>

      <h2>9. Modifications</h2>
      <p>
        Toute évolution de cette politique est publiée sur cette page, avec mise
        à jour de la date figurant en tête. En cas de changement substantiel
        affectant vos droits, les clients du service payant sont prévenus par
        courriel.
      </p>
    </DocumentLegal>
  );
}
