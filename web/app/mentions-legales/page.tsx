// ---------------------------------------------------------------------------
// Mentions légales — obligation de l'article 6-III de la loi n° 2004-575 du
// 21 juin 2004 (LCEN) : tout éditeur d'un service en ligne doit se rendre
// identifiable, et nommer son hébergeur.
// ---------------------------------------------------------------------------

import type { Metadata } from "next";
import DocumentLegal, { EDITEUR, HEBERGEUR } from "../legal/DocumentLegal";

export const metadata: Metadata = {
  title: "Mentions légales — Argentier",
  description:
    "Éditeur, hébergeur et informations légales du service Argentier " +
    "(getargentier.com).",
};

export default function MentionsLegales() {
  return (
    <DocumentLegal
      chemin="/mentions-legales"
      titre="Mentions légales"
      chapo={
        <>
          Informations exigées par l’article 6-III de la loi pour la confiance
          dans l’économie numérique du 21 juin 2004.
        </>
      }
    >
      <h2>Éditeur du service</h2>
      <ul className="dl-fiche">
        <li>
          <b>Dénomination</b> {EDITEUR.denomination}
        </li>
        <li>
          <b>Forme juridique</b> {EDITEUR.forme}
        </li>
        <li>
          <b>Exploitant</b> {EDITEUR.exploitant}
        </li>
        <li>
          <b>Siège</b> {EDITEUR.adresse}
        </li>
        <li>
          <b>SIRET</b> {EDITEUR.siret} (SIREN {EDITEUR.siren})
        </li>
        <li>
          <b>Courriel</b>{" "}
          <a href={`mailto:${EDITEUR.email}`}>{EDITEUR.email}</a>
        </li>
        <li>
          <b>Téléphone</b> {EDITEUR.telephone}
        </li>
        <li>
          <b>Directeur de la publication</b> {EDITEUR.exploitant}
        </li>
      </ul>
      <p>
        <strong>{EDITEUR.service}</strong> est le nom commercial du service
        exploité sur <strong>{EDITEUR.domaine}</strong> par{" "}
        {EDITEUR.denomination}.
      </p>

      <h2>Hébergeur</h2>
      <ul className="dl-fiche">
        <li>
          <b>Hébergeur</b> {HEBERGEUR.nom}
        </li>
        <li>
          <b>Adresse</b> {HEBERGEUR.adresse}
        </li>
        <li>
          <b>Contact</b>{" "}
          <a href={HEBERGEUR.contact} rel="noreferrer noopener" target="_blank">
            {HEBERGEUR.contact}
          </a>
        </li>
      </ul>
      <p>{HEBERGEUR.precision}</p>

      <h2>Nature du service et limites</h2>
      <p>
        Argentier est un <strong>outil d’analyse en lecture seule</strong>. Il
        lit les données du compte professionnel que vous lui donnez accès,
        calcule des pistes d’économies et <strong>prépare</strong> des
        documents que vous relisez et envoyez vous-même.
      </p>
      <div className="dl-note">
        <p>
          <strong>Argentier ne déplace jamais d’argent.</strong> Le service
          n’émet aucun virement, ne valide aucun paiement et n’exécute aucune
          opération bancaire. Techniquement, seules des requêtes de lecture sont
          autorisées ; toute autre requête est rejetée par le service lui-même.
        </p>
      </div>
      <p>
        Argentier <strong>n’est pas un établissement de paiement</strong>, ni un
        établissement de crédit, ni un prestataire de services d’investissement,
        et ne détient à ce titre aucun agrément de l’Autorité de contrôle
        prudentiel et de résolution (ACPR) ni de l’Autorité des marchés
        financiers (AMF).
      </p>
      <p>
        Les analyses produites ne constituent <strong>ni un conseil en
        investissement, ni un conseil fiscal, ni un conseil juridique, ni une
        prestation d’expertise comptable</strong> au sens de l’ordonnance du
        19 septembre 1945. Elles ne remplacent pas votre expert-comptable. Les
        décisions restent les vôtres.
      </p>

      <h2>Propriété intellectuelle</h2>
      <p>
        La structure du service, ses textes, sa charte graphique, ses
        illustrations et son code source sont protégés par le droit d’auteur et
        demeurent la propriété de {EDITEUR.denomination}, à l’exception des
        éléments appartenant à des tiers.
      </p>
      <p>
        Toute reproduction ou représentation, totale ou partielle, à d’autres
        fins que la consultation privée, est interdite sans autorisation écrite
        préalable. Les marques citées (notamment Qonto) appartiennent à leurs
        titulaires respectifs ; leur mention n’implique aucun partenariat ni
        aucune approbation de leur part, sauf indication contraire explicite.
      </p>
      <p>
        <strong>Vos données et vos documents restent les vôtres.</strong>{" "}
        {EDITEUR.denomination} ne revendique aucun droit sur les données
        bancaires que vous lui confiez ni sur les courriers produits pour votre
        compte.
      </p>

      <h2>Signaler un contenu ou une anomalie</h2>
      <p>
        Pour signaler un contenu illicite, une erreur dans une analyse ou une
        faille de sécurité, écrivez à{" "}
        <a href={`mailto:${EDITEUR.email}`}>{EDITEUR.email}</a>. Les
        signalements de sécurité sont traités en priorité et de bonne foi :
        aucune poursuite ne sera engagée contre une personne signalant une
        vulnérabilité sans l’avoir exploitée au-delà de ce qui est nécessaire à
        sa démonstration, et sans avoir accédé aux données d’un tiers.
      </p>

      <h2>Droit applicable et litiges</h2>
      <p>
        Le présent site est soumis au <strong>droit français</strong>. Les
        conditions de résolution des litiges relatifs au service payant figurent
        à l’article « Litiges » des{" "}
        <a href="/cgv">conditions générales de vente</a>.
      </p>
      <p>
        Pour les questions relatives aux données personnelles, voyez la{" "}
        <a href="/confidentialite">politique de confidentialité</a> ; vous
        disposez du droit d’introduire une réclamation auprès de la{" "}
        <a
          href="https://www.cnil.fr/fr/plaintes"
          rel="noreferrer noopener"
          target="_blank"
        >
          CNIL
        </a>
        .
      </p>
    </DocumentLegal>
  );
}
