// ---------------------------------------------------------------------------
// Conditions générales de vente.
//
// Le cœur du document est l'article 4 : la DÉFINITION CONTRACTUELLE de
// l'« économie prouvée ». C'est l'assiette de la commission, elle est calculée
// par l'éditeur, donc elle doit être définie, opposable et CONTESTABLE — sinon
// la facturation repose sur un chiffre que le client n'a aucun moyen de
// vérifier, et devient juridiquement fragile.
//
// L'article 4.4 assume que l'annualisation est une PROJECTION (× 12 à partir
// d'une baisse observée sur ~30 jours) et prévoit la régularisation qui va
// avec. Ne pas retirer cette clause : c'est elle qui rend la commission
// défendable.
// ---------------------------------------------------------------------------

import type { Metadata } from "next";
import DocumentLegal, { EDITEUR } from "../legal/DocumentLegal";

export const metadata: Metadata = {
  title: "Conditions générales de vente — Argentier",
  description:
    "Argentier est gratuit et se rémunère par une commission de 5 % sur les " +
    "économies prouvées. Voici comment une économie devient prouvée.",
};

export default function Cgv() {
  return (
    <DocumentLegal
      chemin="/cgv"
      titre="Conditions générales de vente"
      chapo={
        <>
          Argentier est gratuit. Il se rémunère par une commission de{" "}
          <strong>5 % sur les économies prouvées</strong>. Tout l’enjeu tient
          dans le mot « prouvées » : l’article 4 le définit précisément, et vous
          donne les moyens de le contester.
        </>
      }
    >
      <h2>1. Objet et champ d’application</h2>
      <p>
        Les présentes conditions régissent l’accès au service Argentier, exploité
        par <strong>{EDITEUR.denomination}</strong> ({EDITEUR.forme}),{" "}
        {EDITEUR.adresse}, SIRET {EDITEUR.siret} (ci-après « l’Éditeur »).
      </p>
      <p>
        Le service est réservé aux <strong>professionnels</strong> agissant dans
        le cadre de leur activité : sociétés, entrepreneurs individuels,
        professions libérales. Il n’est pas destiné aux consommateurs.
      </p>
      <p>
        Elles sont acceptées lors de la connexion d’un compte bancaire au
        service. Elles prévalent sur tout document du Client, notamment ses
        conditions d’achat.
      </p>

      <h2>2. Définitions</h2>
      <div className="dl-def">
        <p>
          <strong>Levier</strong> — une piste d’économie identifiée sur un
          fournisseur : abonnement récurrent surdimensionné, doublon
          d’abonnement, frais de change évitables.
        </p>
      </div>
      <div className="dl-def">
        <p>
          <strong>Montant de référence</strong> — la dépense mensuelle moyenne
          constatée sur le fournisseur concerné, calculée sur les relevés du
          compte pendant les 90 jours précédant l’approbation du levier.
        </p>
      </div>
      <div className="dl-def">
        <p>
          <strong>Approbation</strong> — l’acte par lequel le Client décide de
          mettre en œuvre un levier. Elle est expresse : rien n’est engagé sans
          elle.
        </p>
      </div>
      <div className="dl-def">
        <p>
          <strong>J+30</strong> — la date d’observation, fixée à 30 jours
          calendaires après l’approbation, à laquelle est mesurée la baisse
          réelle de la dépense.
        </p>
      </div>
      <div className="dl-def">
        <p>
          <strong>Économie prouvée</strong> — voir l’article 4. C’est l’assiette
          de la commission.
        </p>
      </div>

      <h2>3. Le service</h2>
      <p>Argentier, à la demande du Client :</p>
      <ul>
        <li>lit les opérations du compte professionnel connecté ;</li>
        <li>
          identifie les leviers d’économie au moyen d’un moteur de calcul{" "}
          <strong>déterministe</strong> ;
        </li>
        <li>
          compare les prix aux tarifs publics du marché, chaque prix affiché
          étant accompagné de <strong>sa source et de sa date</strong> ;
        </li>
        <li>
          <strong>prépare</strong> les courriers de renégociation ou de
          résiliation, que le Client relit et envoie lui-même.
        </li>
      </ul>
      <div className="dl-note">
        <p>
          <strong>Ce que le service ne fait jamais.</strong> Argentier n’émet
          aucun virement, ne valide aucun paiement, ne résilie aucun contrat,
          n’envoie aucun courrier à votre place et ne modifie aucune donnée chez
          Qonto. L’accès au compte est <strong>techniquement</strong> restreint à
          la lecture. Les analyses ne constituent ni un conseil en
          investissement, ni un conseil fiscal ou juridique, ni une prestation
          d’expertise comptable, et ne remplacent pas votre expert-comptable.
        </p>
      </div>

      <h2>4. Économie prouvée : définition, mesure, contestation</h2>

      <h3>4.1 Les quatre conditions cumulatives</h3>
      <p>
        Une économie n’est <strong>prouvée</strong> que si les quatre conditions
        suivantes sont réunies :
      </p>
      <ol>
        <li>
          le levier a été <strong>expressément approuvé</strong> par le Client ;
        </li>
        <li>
          à J+30, la dépense mensuelle constatée sur le fournisseur concerné est{" "}
          <strong>inférieure au montant de référence</strong> ;
        </li>
        <li>
          cette baisse est <strong>lisible sur les relevés</strong> du compte du
          Client, qui peut la vérifier lui-même ;
        </li>
        <li>
          la baisse <strong>n’est pas imputable</strong> à une cause étrangère au
          levier (arrêt d’activité, changement de périmètre, saisonnalité,
          impayé, migration décidée indépendamment).
        </li>
      </ol>
      <p>
        À défaut, l’économie reste <strong>en attente</strong> et{" "}
        <strong>n’est pas facturée</strong>. Une économie en attente peut être
        constatée lors d’une observation ultérieure.
      </p>

      <h3>4.2 Le calcul n’est pas discrétionnaire</h3>
      <p>
        Tous les montants sont produits par un <strong>moteur de calcul
        déterministe</strong> appliquant des règles publiées : mêmes relevés,
        mêmes résultats. Aucun montant n’est estimé, arrondi à l’avantage de
        l’Éditeur, ni produit par un modèle de langage.
      </p>
      <p>
        <strong>Économie mensuelle prouvée</strong> = montant de référence −
        dépense mensuelle constatée à J+30.
      </p>

      <h3>4.3 Assiette et taux</h3>
      <p>
        La commission est de <strong>5 %</strong> de l’économie annualisée
        prouvée, soit <strong>l’économie mensuelle prouvée × 12</strong>.
      </p>
      <p>
        Illustration : une dépense ramenée de 300 € à 200 € par mois donne une
        économie mensuelle de 100 €, une économie annualisée de 1 200 €, et une
        commission de <strong>60 € hors taxes, facturée une seule fois</strong>.
        Le Client conserve les 1 140 € restants, et l’intégralité de l’économie
        les années suivantes.
      </p>

      <h3>4.4 L’annualisation est une projection — et se régularise</h3>
      <div className="dl-note">
        <p>
          L’Éditeur l’énonce sans détour : l’économie annualisée est une{" "}
          <strong>projection</strong> obtenue en multipliant par douze une baisse{" "}
          <strong>réellement observée sur environ trente jours</strong>. Ce n’est
          pas un montant annuel constaté.
        </p>
        <p>
          En conséquence, si l’économie <strong>cesse dans les douze mois</strong>{" "}
          suivant la facturation pour une cause non imputable au Client
          (augmentation tarifaire du fournisseur, retour au tarif antérieur,
          rétablissement du doublon), le Client peut demander un{" "}
          <strong>remboursement au prorata</strong> des mois non réalisés. La
          demande se fait par écrit, relevés à l’appui, et le remboursement
          intervient dans les <strong>30 jours</strong>.
        </p>
      </div>

      <h3>4.5 Contestation</h3>
      <p>
        Le Client peut contester une économie prouvée{" "}
        <strong>dans les 30 jours</strong> suivant la réception de la facture, par
        écrit à <a href={`mailto:${EDITEUR.email}`}>{EDITEUR.email}</a>.
      </p>
      <p>
        L’Éditeur communique alors, dans un délai de <strong>15 jours</strong> :
        le montant de référence et son mode de calcul, la liste des opérations
        retenues, la dépense constatée à J+30, et la règle appliquée. En cas de{" "}
        <strong>doute sérieux</strong> sur la condition 4 de l’article 4.1,{" "}
        <strong>le doute profite au Client</strong> et l’économie repasse en
        attente.
      </p>
      <p>
        La contestation <strong>suspend l’exigibilité</strong> de la somme
        contestée. Aucune pénalité de retard ne court pendant l’examen.
      </p>

      <h2>5. Prix, facturation, paiement</h2>
      <ul>
        <li>
          <strong>L’accès au service est gratuit.</strong> Aucun abonnement,
          aucun frais d’entrée, aucun engagement de durée.
        </li>
        <li>
          <strong>Sans économie prouvée, aucune facture.</strong>
        </li>
        <li>
          La facturation intervient après constatation, par facture électronique
          détaillant chaque levier et son calcul.
        </li>
        <li>
          Paiement à <strong>30 jours</strong> à compter de l’émission.
        </li>
      </ul>
      <p>
        Les prix sont exprimés <strong>hors taxes</strong>. La taxe sur la valeur
        ajoutée applicable est celle en vigueur à la date de facturation ; le cas
        échéant, la mention « TVA non applicable, article 293 B du code général
        des impôts » figure sur la facture.
      </p>
      <p>
        En cas de retard, et conformément aux articles L. 441-10 et D. 441-5 du
        code de commerce, des intérêts au taux de la Banque centrale européenne
        majoré de 10 points sont dus, ainsi qu’une indemnité forfaitaire de
        recouvrement de <strong>40 €</strong>. Ces sommes ne s’appliquent pas
        pendant l’examen d’une contestation recevable.
      </p>

      <h2>6. Obligations du Client</h2>
      <ul>
        <li>
          fournir un accès en lecture à un compte professionnel dont il a le
          droit de disposer ;
        </li>
        <li>
          relire les documents préparés <strong>avant</strong> tout envoi : ils
          sont des projets, sous sa seule responsabilité une fois envoyés ;
        </li>
        <li>
          signaler toute anomalie dans une analyse, afin qu’elle soit corrigée ;
        </li>
        <li>
          ne pas tenter de contourner les restrictions techniques du service.
        </li>
      </ul>

      <h2>7. Durée, débranchement, réversibilité</h2>
      <p>
        Le contrat est conclu <strong>sans durée d’engagement</strong>. Le Client
        peut débrancher son compte{" "}
        <strong>à tout moment, en une action, sans motif ni préavis</strong> : les
        jetons d’accès sont immédiatement supprimés et les sessions en cours
        invalidées.
      </p>
      <p>
        Le débranchement met fin pour l’avenir à toute lecture du compte. Il ne
        remet pas en cause les économies déjà prouvées avant sa date, ni les
        factures correspondantes — ni, symétriquement, le droit à régularisation
        de l’article 4.4.
      </p>
      <p>
        Sur demande, le Client obtient l’export de ses décisions et de ses
        économies constatées dans un format lisible par machine, sous 30 jours.
      </p>

      <h2>8. Responsabilité</h2>
      <p>
        L’Éditeur fournit le service avec le soin d’un professionnel diligent.
        Les analyses reposent sur les données transmises par la banque du Client
        et sur des tarifs publics relevés à une date donnée ; l’Éditeur ne
        garantit ni l’obtention d’une économie, ni l’acceptation d’une
        renégociation par un fournisseur.
      </p>
      <p>
        Le Client demeure <strong>seul décideur</strong> de ses résiliations,
        renégociations et déclarations. La classification professionnel /
        personnel proposée est une <strong>aide</strong> : elle ne vaut pas avis
        fiscal et doit être validée par le Client ou son expert-comptable.
      </p>
      <p>
        Hors dommage corporel, faute lourde ou dol, la responsabilité de
        l’Éditeur est <strong>limitée aux sommes effectivement facturées</strong>{" "}
        au Client au cours des douze mois précédant le fait générateur. Les
        dommages indirects — perte d’exploitation, perte de chance, préjudice
        commercial — sont exclus.
      </p>
      <p>
        L’Éditeur n’est pas responsable des indisponibilités imputables à la
        banque du Client, à son hébergeur ou à un prestataire tiers.
      </p>

      <h2>9. Données personnelles et confidentialité</h2>
      <p>
        Le traitement des données est décrit dans la{" "}
        <a href="/confidentialite">politique de confidentialité</a>. Pour les
        données bancaires du Client, l’Éditeur agit en{" "}
        <strong>sous-traitant</strong> au sens de l’article 28 du RGPD, dans les
        conditions de l’<a href="/dpa">accord de sous-traitance</a>, qui fait
        partie intégrante du contrat.
      </p>
      <p>
        Chaque partie s’engage à la confidentialité des informations de l’autre.
        L’Éditeur ne communique aucune donnée du Client à un tiers hors les
        sous-traitants listés et les obligations légales.
      </p>

      <h2>10. Évolution des conditions</h2>
      <p>
        Toute modification est publiée sur cette page. Les clients actifs en sont
        informés par courriel <strong>30 jours</strong> avant l’entrée en vigueur.
        À défaut d’accord, le Client peut débrancher son compte sans frais ; les
        conditions antérieures continuent de régir les économies déjà prouvées.
      </p>

      <h2>11. Force majeure</h2>
      <p>
        Aucune partie n’est responsable d’un manquement causé par un événement de
        force majeure au sens de l’article 1218 du code civil.
      </p>

      <h2>12. Droit applicable et litiges</h2>
      <p>
        Les présentes conditions sont soumises au <strong>droit français</strong>.
      </p>
      <p>
        Les parties s’efforcent de résoudre amiablement tout différend. Le Client
        écrit à <a href={`mailto:${EDITEUR.email}`}>{EDITEUR.email}</a> ;
        l’Éditeur répond sous 15 jours.
      </p>
      <p>
        À défaut d’accord dans les 60 jours, le litige relève de la compétence
        exclusive des <strong>tribunaux de Paris</strong>, y compris en cas de
        pluralité de défendeurs ou d’appel en garantie.
      </p>
    </DocumentLegal>
  );
}
