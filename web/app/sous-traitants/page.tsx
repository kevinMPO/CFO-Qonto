// ---------------------------------------------------------------------------
// Liste des sous-traitants ultérieurs — article 28.2 et 28.4 du RGPD.
//
// Cette page fait partie intégrante de l'accord de sous-traitance (/dpa), qui
// engage l'éditeur à annoncer toute adjonction 30 JOURS AVANT son entrée en
// vigueur. Conséquence pratique : on ne branche pas un nouveau prestataire
// recevant des données sans avoir modifié cette page d'abord.
//
// La liste est construite à partir des destinations réseau RÉELLES du code
// (voir la CSP de next.config.mjs, qui les énumère). Toute nouvelle destination
// doit apparaître ici.
// ---------------------------------------------------------------------------

import type { Metadata } from "next";
import DocumentLegal, { EDITEUR } from "../legal/DocumentLegal";

export const metadata: Metadata = {
  title: "Sous-traitants — Argentier",
  description:
    "Liste complète des prestataires qui traitent des données pour le compte " +
    "d'Argentier, ce qu'ils reçoivent et où ils sont établis.",
};

/** Prestataires agissant comme sous-traitants ultérieurs. */
const SOUS_TRAITANTS = [
  {
    nom: "Cloudflare, Inc.",
    pays: "États-Unis — stockage en Union européenne",
    role: "Hébergement du service, stockage des jetons chiffrés, base de données",
    donnees:
      "L’ensemble des données du service, chiffrées au repos pour les jetons",
    note:
      "La base de données est en région « Europe de l’Ouest » (WEUR) et n’en " +
      "sort pas.",
  },
  {
    nom: "Anthropic PBC",
    pays: "États-Unis",
    role: "Classement des dépenses, rédaction des courriers, lecture des prix relevés",
    donnees: "Nom du marchand et catégorie, exclusivement",
    note:
      "Aucun IBAN, aucun identifiant de transaction, aucun solde, aucune " +
      "donnée nominative. Filtre bloquant avant chaque envoi.",
  },
  {
    nom: "Linkup Technologies (SAS)",
    pays: "France — Union européenne",
    role: "Recherche des tarifs publics du marché",
    donnees: "Nom du marchand et catégorie, exclusivement",
    note:
      "28 avenue des Pépinières, 94260 Fresnes · RCS Créteil 930 910 740. " +
      "Données traitées et stockées dans l’Union européenne.",
  },
  {
    nom: "ElevenLabs, Inc.",
    pays: "États-Unis",
    role: "Synthèse vocale et dialogue vocal, si vous utilisez ces fonctions",
    donnees:
      "Texte de la narration à lire, et voix de l’utilisateur pendant un échange",
    note: "Fonction facultative : sans usage vocal, aucune donnée n’est transmise.",
  },
] as const;

/** Tiers sollicités par le NAVIGATEUR, qui reçoivent de ce fait l'adresse IP. */
const TIERS_NAVIGATEUR = [
  {
    nom: "Google Ireland Limited (Google Fonts)",
    pays: "Irlande / États-Unis",
    role: "Polices de caractères des écrans applicatifs",
    donnees: "Adresse IP et caractéristiques du navigateur",
  },
  {
    nom: "unpkg (réseau de diffusion)",
    pays: "Réseau mondial",
    role: "Chargement du composant de dialogue vocal, page de démonstration",
    donnees: "Adresse IP et caractéristiques du navigateur",
  },
] as const;

export default function SousTraitants() {
  return (
    <DocumentLegal
      chemin="/sous-traitants"
      titre="Sous-traitants"
      chapo={
        <>
          La liste complète des prestataires qui traitent des données pour le
          compte d’Argentier, ce que chacun reçoit exactement, et où il est
          établi. Cette page fait partie de l’
          <a href="/dpa">accord de sous-traitance</a>.
        </>
      }
    >
      <h2>Sous-traitants ultérieurs</h2>
      <div className="dl-tableau">
        <table>
          <thead>
            <tr>
              <th>Prestataire</th>
              <th>Établissement</th>
              <th>Rôle</th>
              <th>Ce qu’il reçoit</th>
            </tr>
          </thead>
          <tbody>
            {SOUS_TRAITANTS.map((s) => (
              <tr key={s.nom}>
                <td>
                  <strong>{s.nom}</strong>
                  <br />
                  <span style={{ opacity: 0.7 }}>{s.note}</span>
                </td>
                <td>{s.pays}</td>
                <td>{s.role}</td>
                <td>{s.donnees}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Les localisations indiquées sont celles déclarées par chaque prestataire
        dans sa documentation contractuelle.
      </p>

      <div className="dl-note">
        <p>
          <strong>
            Ce qui sort vers les prestataires d’analyse est délibérément pauvre.
          </strong>{" "}
          Vers Anthropic et Linkup, seuls le <strong>nom du marchand</strong> et
          la <strong>catégorie</strong> sont transmis — par exemple « Notion » et
          « logiciel ». Jamais d’IBAN, d’identifiant de transaction, de numéro de
          compte, de solde ni de donnée nominative. Un filtre s’exécute{" "}
          <strong>avant chaque envoi</strong> et <strong>interrompt</strong>{" "}
          l’opération s’il détecte une donnée interdite : il ne se contente pas
          d’avertir.
        </p>
      </div>

      <h2>Qonto n’est pas un sous-traitant d’Argentier</h2>
      <p>
        <strong>Qonto est votre banque</strong>, et la source des données. La
        relation vous lie directement à elle : Argentier ne fait que lire, avec
        votre autorisation, ce que vous y voyez déjà. Qonto n’agit pas pour le
        compte d’Argentier et n’en reçoit aucune donnée.
      </p>
      <p>
        Vous retirez cette autorisation quand vous voulez, en une action, depuis
        Argentier — ou depuis votre espace Qonto.
      </p>

      <h2>Tiers sollicités par votre navigateur</h2>
      <p>
        Ces tiers ne traitent pas vos données bancaires. Ils reçoivent en
        revanche votre <strong>adresse IP</strong> du fait de l’affichage de la
        page, ce qui doit être dit :
      </p>
      <div className="dl-tableau">
        <table>
          <thead>
            <tr>
              <th>Tiers</th>
              <th>Établissement</th>
              <th>Rôle</th>
              <th>Ce qu’il reçoit</th>
            </tr>
          </thead>
          <tbody>
            {TIERS_NAVIGATEUR.map((t) => (
              <tr key={t.nom}>
                <td>
                  <strong>{t.nom}</strong>
                </td>
                <td>{t.pays}</td>
                <td>{t.role}</td>
                <td>{t.donnees}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Aucun de ces appels ne dépose de cookie publicitaire et aucun ne sert à
        vous suivre. Ces pages légales, elles, n’en déclenchent{" "}
        <strong>aucun</strong>. Nous prévoyons d’héberger nous-mêmes ces
        ressources afin de supprimer ces transferts.
      </p>

      <h2>Ce qu’Argentier n’utilise pas</h2>
      <p>Pour lever toute ambiguïté, le service ne recourt à :</p>
      <ul>
        <li>
          <strong>aucun outil de mesure d’audience</strong> — ni Google
          Analytics, ni équivalent ;
        </li>
        <li>
          <strong>aucune régie publicitaire</strong>, aucun pixel de suivi,
          aucun réseau social embarqué ;
        </li>
        <li>
          <strong>aucun agrégateur bancaire tiers</strong> — la connexion est
          directe, de vous à votre banque ;
        </li>
        <li>
          <strong>aucun service de scoring</strong> ou d’évaluation
          automatisée de solvabilité.
        </li>
      </ul>

      <h2>Modification de cette liste</h2>
      <p>
        Toute adjonction ou remplacement de sous-traitant est publié sur cette
        page <strong>30 jours avant</strong> son entrée en vigueur, conformément
        à l’<a href="/dpa">accord de sous-traitance</a>. Les clients actifs en
        sont informés par courriel.
      </p>
      <p>
        Vous pouvez vous y opposer, par écrit et de façon motivée, dans ce délai.
        À défaut de solution, vous résiliez sans frais ni pénalité.
      </p>
      <p>
        Pour être averti de ces changements ou obtenir un exemplaire signé de
        l’accord de sous-traitance :{" "}
        <a href={`mailto:${EDITEUR.email}`}>{EDITEUR.email}</a>.
      </p>
    </DocumentLegal>
  );
}
