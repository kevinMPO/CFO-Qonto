// ---------------------------------------------------------------------------
// Accord de sous-traitance (DPA) — article 28 du RGPD.
//
// Obligatoire dès lors qu'Argentier traite des données personnelles pour le
// compte de ses clients, ce qui est le cas : les opérations d'un compte
// professionnel comportent des données personnelles, a fortiori sur un compte
// d'entrepreneur individuel où le professionnel et la personne se confondent.
//
// Publier ce document plutôt que de le négocier au cas par cas est un choix
// assumé : un DAF doit pouvoir le lire AVANT de brancher son compte.
// ---------------------------------------------------------------------------

import type { Metadata } from "next";
import DocumentLegal, { EDITEUR } from "../legal/DocumentLegal";

export const metadata: Metadata = {
  title: "Accord de sous-traitance (DPA) — Argentier",
  description:
    "Les engagements d'Argentier comme sous-traitant au sens de l'article 28 " +
    "du RGPD : instructions, sécurité, sous-traitants ultérieurs, audit.",
};

export default function Dpa() {
  return (
    <DocumentLegal
      chemin="/dpa"
      titre="Accord de sous-traitance"
      chapo={
        <>
          Le cadre imposé par l’article 28 du RGPD lorsqu’Argentier traite des
          données personnelles <strong>pour le compte</strong> de son client.
          Publié, et non négocié au cas par cas : vous devez pouvoir le lire
          avant de brancher votre compte.
        </>
      }
    >
      <h2>1. Parties et qualifications</h2>
      <p>
        Le présent accord est conclu entre le <strong>Client</strong>,{" "}
        <strong>responsable du traitement</strong>, et{" "}
        <strong>{EDITEUR.denomination}</strong> ({EDITEUR.forme}),{" "}
        {EDITEUR.adresse}, SIRET {EDITEUR.siret},{" "}
        <strong>sous-traitant</strong> (ci-après « l’Éditeur »).
      </p>
      <p>
        Il fait partie intégrante des <a href="/cgv">conditions générales de
        vente</a> et prévaut sur elles en cas de contradiction relative aux
        données personnelles.
      </p>
      <div className="dl-note">
        <p>
          <strong>Pourquoi ce document est nécessaire.</strong> Les opérations
          d’un compte professionnel comportent des données personnelles :
          bénéficiaires nommément désignés, coordonnées bancaires, libellés
          identifiants. C’est plus vrai encore sur un compte d’entrepreneur
          individuel, où le patrimoine professionnel et la personne se
          rejoignent. L’article 28 du RGPD impose alors un contrat écrit.
        </p>
      </div>

      <h2>2. Objet, nature et durée du traitement</h2>
      <div className="dl-tableau">
        <table>
          <thead>
            <tr>
              <th>Élément</th>
              <th>Contenu</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Objet</td>
              <td>
                Analyse en lecture seule des opérations d’un compte
                professionnel, en vue d’identifier des économies
              </td>
            </tr>
            <tr>
              <td>Nature des opérations</td>
              <td>
                Collecte par interface bancaire, consultation, calcul, mise en
                forme, stockage limité, effacement
              </td>
            </tr>
            <tr>
              <td>Finalité</td>
              <td>
                Détection d’abonnements récurrents, doublons et frais de change ;
                classement professionnel / personnel ; préparation de courriers
              </td>
            </tr>
            <tr>
              <td>Catégories de données</td>
              <td>
                Données d’opérations (libellé, marchand, montant, date, devise,
                type), identifiants de compte (raison sociale, IBAN, solde),
                jetons d’accès
              </td>
            </tr>
            <tr>
              <td>Personnes concernées</td>
              <td>
                Le Client et ses représentants, ses bénéficiaires de paiement,
                ses fournisseurs et, le cas échéant, ses salariés
              </td>
            </tr>
            <tr>
              <td>Données sensibles</td>
              <td>
                <strong>Aucune n’est recherchée ni traitée intentionnellement.</strong>{" "}
                Aucune décision n’est fondée sur une donnée de l’article 9
              </td>
            </tr>
            <tr>
              <td>Durée</td>
              <td>
                Durée de la relation contractuelle, jusqu’au débranchement du
                compte
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>3. Engagements de l’Éditeur</h2>

      <h3>3.1 Agir uniquement sur instruction</h3>
      <p>
        L’Éditeur ne traite les données que pour les finalités ci-dessus. Il{" "}
        <strong>n’en fait aucun usage propre</strong> : ni revente, ni location,
        ni cession, ni prospection, ni{" "}
        <strong>entraînement de modèle d’intelligence artificielle</strong>.
      </p>
      <p>
        Chaque analyse est déclenchée par le Client. Si une instruction paraît
        contraire au droit applicable, l’Éditeur en informe le Client et peut
        suspendre son exécution.
      </p>

      <h3>3.2 Limiter par construction ce qui est traité</h3>
      <ul>
        <li>
          l’accès au compte est <strong>techniquement restreint à la
          lecture</strong>, sur une liste fermée d’adresses ; toute autre requête
          est rejetée, et un test automatisé bloque la mise en production de tout
          code qui contournerait ce contrôle ;
        </li>
        <li>
          la fenêtre d’analyse est bornée à <strong>90 jours glissants</strong> ;
        </li>
        <li>
          les opérations bancaires ne sont <strong>pas conservées
          durablement</strong> : elles sont analysées à la demande ;
        </li>
        <li>
          vers les sous-traitants d’analyse, seuls sortent le{" "}
          <strong>nom du marchand</strong> et la <strong>catégorie</strong>, un
          filtre interrompant l’envoi s’il détecte une donnée interdite.
        </li>
      </ul>

      <h3>3.3 Confidentialité</h3>
      <p>
        Seul l’exploitant accède aux données, et uniquement lorsque c’est
        nécessaire au fonctionnement du service ou à la résolution d’un incident.
        Toute personne qui serait amenée à intervenir est tenue à une obligation
        de confidentialité de même portée.
      </p>

      <h3>3.4 Sécurité (article 32)</h3>
      <ul>
        <li>chiffrement des flux (HTTPS, HSTS) ;</li>
        <li>
          jetons d’accès bancaires <strong>chiffrés au repos en AES-GCM
          256 bits</strong>, jamais renvoyés au navigateur, jamais journalisés ;
        </li>
        <li>
          <strong>cloisonnement des clients</strong> : chaque requête en base
          porte l’identifiant du locataire, sans exception ;
        </li>
        <li>
          <strong>journal d’accès</strong> conservé 12 mois, retraçant chaque
          lecture du compte ;
        </li>
        <li>
          authentification par OAuth 2.1 avec PKCE : les identifiants bancaires
          ne transitent jamais par l’Éditeur ;
        </li>
        <li>
          contrôles automatisés interdisant qu’un secret ou une donnée bancaire
          soit versé au code source.
        </li>
      </ul>

      <h3>3.5 Assistance au Client</h3>
      <p>L’Éditeur assiste le Client, à ses frais raisonnables, pour :</p>
      <ul>
        <li>
          répondre aux demandes d’exercice de droits qu’il recevrait
          directement — auquel cas il les transmet au Client{" "}
          <strong>sans délai</strong> et n’y répond pas seul ;
        </li>
        <li>
          réaliser une analyse d’impact ou une consultation préalable de
          l’autorité ;
        </li>
        <li>démontrer sa conformité.</li>
      </ul>

      <h3>3.6 Violation de données</h3>
      <p>
        L’Éditeur notifie au Client toute violation de données le concernant{" "}
        <strong>dans les 48 heures</strong> suivant sa connaissance, en
        précisant : la nature de la violation, les catégories et le volume
        approximatif de données concernées, les conséquences probables et les
        mesures prises ou envisagées.
      </p>
      <p>
        La notification à l’autorité de contrôle et, le cas échéant, aux
        personnes concernées incombe au Client, l’Éditeur lui fournissant tous
        les éléments utiles.
      </p>

      <h3>3.7 Sort des données à la fin</h3>
      <p>
        Au débranchement du compte, l’Éditeur{" "}
        <strong>supprime immédiatement</strong> les jetons d’accès et invalide les
        sessions. Les autres données sont effacées{" "}
        <strong>dans les 30 jours</strong>, à l’exception de celles dont la
        conservation est imposée par la loi — notamment les pièces comptables
        justifiant une facturation.
      </p>
      <p>
        Le Client peut demander, avant effacement, l’export de ses décisions et
        économies constatées dans un format lisible par machine.
      </p>

      <h2>4. Sous-traitants ultérieurs</h2>
      <p>
        Le Client <strong>autorise</strong> le recours aux sous-traitants
        ultérieurs listés sur la page{" "}
        <a href="/sous-traitants">sous-traitants</a>, qui fait partie du présent
        accord.
      </p>
      <p>
        L’Éditeur impose à chacun d’eux, par contrat, des obligations{" "}
        <strong>au moins équivalentes</strong> à celles du présent accord, et
        demeure <strong>pleinement responsable</strong> de leurs manquements
        envers le Client.
      </p>
      <p>
        Toute adjonction ou remplacement est annoncé sur cette même page{" "}
        <strong>30 jours avant</strong> son entrée en vigueur. Le Client peut s’y
        opposer par écrit et motiver son opposition dans ce délai ; à défaut de
        solution, il peut résilier sans frais ni pénalité.
      </p>

      <h2>5. Transferts hors Union européenne</h2>
      <p>
        Les données applicatives sont hébergées en{" "}
        <strong>Union européenne</strong> (base en région Europe de l’Ouest).
      </p>
      <p>
        Deux sous-traitants d’analyse sont établis aux{" "}
        <strong>États-Unis</strong> : Anthropic et ElevenLabs. Ces transferts
        reposent sur les <strong>clauses contractuelles types</strong> de la
        Commission européenne du 4 juin 2021, complétées par les mesures
        techniques décrites à l’article 3.2 — pour Anthropic, le contenu transmis
        ne comporte, <strong>par construction</strong>, aucune donnée
        personnelle identifiante.
      </p>

      <h2>6. Audit</h2>
      <p>
        Le Client peut, <strong>une fois par an</strong> et sur préavis
        raisonnable de 30 jours, demander à l’Éditeur les éléments démontrant sa
        conformité : description des mesures de sécurité, liste des
        sous-traitants, extraits du journal d’accès le concernant, résultats des
        contrôles automatisés.
      </p>
      <p>
        En cas de violation de données l’affectant, ce droit est exerçable{" "}
        <strong>immédiatement et sans limitation de fréquence</strong>.
      </p>
      <p>
        L’Éditeur ne communique aucun élément susceptible de révéler des
        informations relatives à un autre client.
      </p>

      <h2>7. Responsabilité</h2>
      <p>
        Chaque partie assume les conséquences de ses propres manquements. Les
        limitations de responsabilité des conditions générales de vente{" "}
        <strong>ne s’appliquent pas</strong> aux amendes administratives
        prononcées par une autorité de contrôle du fait d’un manquement imputable
        à l’Éditeur, ni aux dommages causés aux personnes concernées par un tel
        manquement.
      </p>

      <h2>8. Contact</h2>
      <p>
        Toute demande relative au présent accord :{" "}
        <a href={`mailto:${EDITEUR.email}`}>{EDITEUR.email}</a>. Un exemplaire
        signé peut être fourni sur demande.
      </p>
    </DocumentLegal>
  );
}
