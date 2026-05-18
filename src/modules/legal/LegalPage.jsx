import React from "react";
import { useParams, Link, useNavigate } from "react-router-dom";

/**
 * LegalPage — Pages légales IO BILL.
 * Routes : /legal/cgu, /legal/cgv, /legal/mentions, /legal/privacy
 *
 * Templates de base — à faire valider par un juriste avant production
 * pour 100% conformité (notamment articles 16-18 CGV, traitements DGFiP
 * et obligations RGPD spécifiques au stockage de données fiscales).
 */
export function LegalPage() {
  const { kind } = useParams();
  const navigate = useNavigate();

  const PAGES = {
    cgu: { title: "Conditions Générales d'Utilisation", Comp: CGU },
    cgv: { title: "Conditions Générales de Vente", Comp: CGV },
    mentions: { title: "Mentions légales", Comp: Mentions },
    privacy: { title: "Politique de confidentialité", Comp: Privacy }
  };

  const page = PAGES[kind] || PAGES.cgu;
  const Comp = page.Comp;

  return (
    <div className="page" style={{ maxWidth: 900, margin: "0 auto" }}>
      <button
        onClick={() => navigate(-1)}
        style={{
          background: "transparent", border: 0, color: "var(--muted)",
          fontSize: 13, padding: "4px 0", cursor: "pointer", marginBottom: 12
        }}
      >
        ← Retour
      </button>

      <div style={{ display: "flex", gap: 8, marginBottom: 22, flexWrap: "wrap" }}>
        {Object.entries(PAGES).map(([k, v]) => (
          <Link
            key={k}
            to={`/legal/${k}`}
            className={"tab" + (kind === k ? " active" : "")}
            style={{ fontSize: 12 }}
          >
            {v.title}
          </Link>
        ))}
      </div>

      <h1 style={{ marginBottom: 6 }}>{page.title}</h1>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 24 }}>
        Dernière mise à jour : 18 mai 2026
      </div>

      <article style={{ fontSize: 14, lineHeight: 1.7 }}>
        <Comp />
      </article>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// CGU
// ═══════════════════════════════════════════════════════════
function CGU() {
  return (
    <>
      <H2>1. Objet</H2>
      <p>Les présentes Conditions Générales d'Utilisation (CGU) régissent l'accès et l'utilisation de la plateforme IO BILL accessible à l'adresse <strong>app.iobill.online</strong>, éditée par OWL'S INDUSTRY (ci-après « l'Éditeur »).</p>
      <p>IO BILL est un logiciel SaaS de facturation conforme à la réglementation française Factur-X 2026/2027 (DGFiP), destiné aux entrepreneurs individuels, TPE/PME et cabinets comptables.</p>

      <H2>2. Acceptation</H2>
      <p>L'utilisation d'IO BILL implique l'acceptation pleine et entière des présentes CGU. Si vous n'acceptez pas ces conditions, vous devez cesser immédiatement l'utilisation du service.</p>

      <H2>3. Création de compte</H2>
      <p>Pour utiliser IO BILL, vous devez créer un compte en fournissant des informations exactes et à jour (raison sociale, SIRET, email professionnel). Vous êtes responsable de la confidentialité de vos identifiants.</p>

      <H2>4. Usage du service</H2>
      <p>Vous vous engagez à utiliser IO BILL conformément à sa destination, à la législation en vigueur et aux présentes CGU. Sont notamment interdits :</p>
      <ul>
        <li>l'utilisation à des fins frauduleuses (émission de fausses factures, fraude fiscale)</li>
        <li>la tentative d'accès non autorisé aux systèmes</li>
        <li>l'extraction massive de données via des moyens non prévus par l'API officielle</li>
        <li>la revente ou la mise à disposition à des tiers sans accord écrit</li>
      </ul>

      <H2>5. Disponibilité</H2>
      <p>L'Éditeur s'efforce d'assurer une disponibilité de 99 % du service sur une base mensuelle, hors maintenances programmées. Aucune garantie de disponibilité absolue ne peut être donnée.</p>

      <H2>6. Conformité réglementaire</H2>
      <p>IO BILL est conforme aux exigences Factur-X 2026/2027 (chaîne de hashs immuable des factures émises). Vous restez seul responsable de l'exactitude des données saisies et de leur conformité fiscale.</p>

      <H2>7. Propriété intellectuelle</H2>
      <p>La marque IO BILL, le logo, l'interface, le code source et la documentation sont la propriété exclusive de OWL'S INDUSTRY. Toute reproduction non autorisée est interdite.</p>
      <p>Les données que vous saisissez (factures, devis, clients) restent votre propriété exclusive.</p>

      <H2>8. Données personnelles</H2>
      <p>Le traitement des données personnelles est régi par notre <Link to="/legal/privacy">Politique de confidentialité</Link>.</p>

      <H2>9. Résiliation</H2>
      <p>Vous pouvez résilier votre compte à tout moment depuis votre espace Paramètres. L'Éditeur peut suspendre ou résilier un compte en cas de manquement grave aux CGU.</p>

      <H2>10. Loi applicable</H2>
      <p>Les présentes CGU sont régies par le droit français. Tout litige sera soumis aux tribunaux compétents du ressort du siège social de OWL'S INDUSTRY.</p>
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// CGV
// ═══════════════════════════════════════════════════════════
function CGV() {
  return (
    <>
      <H2>1. Objet</H2>
      <p>Les présentes Conditions Générales de Vente (CGV) s'appliquent à tous les abonnements souscrits sur IO BILL par les professionnels (B2B).</p>

      <H2>2. Offres et tarifs</H2>
      <ul>
        <li><strong>IO BILL Pro mensuel</strong> : 9,90 € HT/mois (11,88 € TTC)</li>
        <li><strong>IO BILL Pro annuel</strong> : 89 € HT/an (106,80 € TTC) — soit ≈ 7,42 €/mois</li>
        <li><strong>IO BILL Cabinet</strong> : 49 € HT/mois (58,80 € TTC) pour les cabinets comptables</li>
        <li><strong>Offre de lancement Cabinet</strong> : les 10 premiers cabinets bénéficient d'un abonnement gratuit à vie</li>
      </ul>
      <p>Les prix sont indiqués hors taxes. La TVA française au taux en vigueur (20 % au 18/05/2026) est ajoutée pour les clients établis en France.</p>

      <H2>3. Souscription</H2>
      <p>La souscription se fait via Stripe (PCI-DSS Niveau 1). L'abonnement est activé immédiatement après le paiement. Vous recevez un email de confirmation et une facture conforme.</p>

      <H2>4. Période d'essai</H2>
      <p>Une période d'essai gratuite de 14 jours est offerte aux nouveaux comptes (sauf cabinets bénéficiaires de l'offre de lancement). Aucune carte bancaire n'est requise pour démarrer l'essai. À la fin de l'essai, vous pouvez souscrire ou laisser le compte expirer sans frais.</p>

      <H2>5. Renouvellement et résiliation</H2>
      <p>L'abonnement se renouvelle automatiquement par tacite reconduction à chaque échéance (mensuelle ou annuelle). Vous pouvez résilier à tout moment depuis Paramètres → Abonnement. La résiliation prend effet à la fin de la période en cours, sans remboursement au prorata.</p>

      <H2>6. Modalités de paiement</H2>
      <p>Les paiements sont prélevés automatiquement par Stripe sur la carte bancaire ou le compte SEPA renseigné. En cas d'échec de paiement, l'abonnement passe en « impayé » pendant 7 jours avant suspension.</p>

      <H2>7. Droit de rétractation</H2>
      <p>Conformément à l'article L.221-3 du Code de la consommation, le droit de rétractation de 14 jours ne s'applique pas aux contrats conclus entre professionnels. Toutefois, OWL'S INDUSTRY accepte le remboursement intégral en cas de demande dans les 7 jours suivant la première souscription, à titre commercial.</p>

      <H2>8. Pénalités de retard</H2>
      <p>Tout retard de paiement entraîne, sans mise en demeure préalable, l'application de pénalités au taux de 3 fois le taux d'intérêt légal, ainsi qu'une indemnité forfaitaire pour frais de recouvrement de 40 € (article L.441-10 du Code de commerce).</p>

      <H2>9. Garanties et responsabilité</H2>
      <p>L'Éditeur garantit la conformité de la plateforme aux spécifications Factur-X DGFiP. La responsabilité de l'Éditeur est limitée au montant des sommes versées au titre de l'abonnement sur les 12 derniers mois.</p>

      <H2>10. Litiges</H2>
      <p>Tout litige est soumis aux tribunaux compétents du siège social de OWL'S INDUSTRY. Une médiation peut être tentée préalablement.</p>
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// Mentions légales
// ═══════════════════════════════════════════════════════════
function Mentions() {
  return (
    <>
      <H2>Éditeur du site</H2>
      <p>
        <strong>OWL'S INDUSTRY</strong> — SAS au capital de 4 000 €<br />
        Siège social : 44 Bis Vieille Route de la Gavotte, 13170 Les Pennes-Mirabeau<br />
        SIRET : 852 788 470 00015<br />
        TVA intracommunautaire : FR25852788470<br />
        Email : contact@iobill.online<br />
        Représentant légal : Geoffrey Pira
      </p>

      <H2>Directeur de la publication</H2>
      <p>Geoffrey Pira, président de OWL'S INDUSTRY.</p>

      <H2>Hébergement</H2>
      <p>
        Le site IO BILL est hébergé par :<br />
        <strong>Vercel Inc.</strong>, 340 S Lemon Ave #4133, Walnut, CA 91789, États-Unis.<br />
        Les données de la plateforme (factures, clients, etc.) sont stockées sur :<br />
        <strong>Supabase</strong> (Frankfurt, Allemagne — région eu-central-1).
      </p>

      <H2>Propriété intellectuelle</H2>
      <p>L'ensemble du site (textes, logo, code, interface) est protégé par le droit d'auteur. Toute reproduction sans autorisation écrite préalable est interdite.</p>

      <H2>Contact</H2>
      <p>Pour toute question : <a href="mailto:contact@iobill.online">contact@iobill.online</a></p>
    </>
  );
}

// ═══════════════════════════════════════════════════════════
// Politique de confidentialité (RGPD)
// ═══════════════════════════════════════════════════════════
function Privacy() {
  return (
    <>
      <H2>1. Responsable du traitement</H2>
      <p>OWL'S INDUSTRY, SAS, 44 Bis Vieille Route de la Gavotte, 13170 Les Pennes-Mirabeau. Contact DPO : <a href="mailto:contact@iobill.online">contact@iobill.online</a></p>

      <H2>2. Données collectées</H2>
      <ul>
        <li><strong>Données d'identité</strong> : raison sociale, SIRET, dirigeant, email professionnel</li>
        <li><strong>Données fiscales</strong> : numéro de TVA, factures émises et reçues</li>
        <li><strong>Données clients</strong> : informations des clients que vous saisissez dans IO BILL</li>
        <li><strong>Données techniques</strong> : adresse IP, journaux de connexion, données de navigation</li>
        <li><strong>Données de paiement</strong> : traitées exclusivement par Stripe (PCI-DSS L1), jamais stockées par IO BILL</li>
      </ul>

      <H2>3. Finalités</H2>
      <ul>
        <li>Fourniture du service de facturation</li>
        <li>Émission de factures conformes Factur-X 2026/2027</li>
        <li>Facturation et gestion des abonnements</li>
        <li>Support client</li>
        <li>Amélioration du service (statistiques anonymisées)</li>
      </ul>

      <H2>4. Base légale</H2>
      <p>Le traitement repose sur l'exécution du contrat (CGU/CGV), le respect des obligations légales (notamment fiscales — conservation des factures 10 ans, article L.123-22 du Code de commerce) et l'intérêt légitime de l'Éditeur pour l'amélioration du service.</p>

      <H2>5. Durée de conservation</H2>
      <ul>
        <li><strong>Compte actif</strong> : durée de l'abonnement</li>
        <li><strong>Compte fermé</strong> : 10 ans après clôture pour les données fiscales (obligation légale), 3 ans pour les autres données</li>
        <li><strong>Logs techniques</strong> : 12 mois</li>
        <li><strong>Données de paiement Stripe</strong> : selon la politique de Stripe</li>
      </ul>

      <H2>6. Destinataires</H2>
      <p>Les données ne sont jamais revendues. Elles peuvent être transmises à :</p>
      <ul>
        <li><strong>Stripe</strong> (sous-traitant paiement, USA — DPA + SCCs)</li>
        <li><strong>Vercel</strong> (sous-traitant hébergement, USA — DPA + SCCs)</li>
        <li><strong>Supabase</strong> (sous-traitant base de données, Allemagne)</li>
        <li><strong>Resend</strong> (sous-traitant envoi d'emails, USA — DPA + SCCs)</li>
        <li><strong>Mistral AI</strong> (sous-traitant OCR factures, France)</li>
        <li><strong>Yousign</strong> (sous-traitant signature électronique, France — uniquement si module activé)</li>
        <li>Plateformes de Dématérialisation Partenaires (PDP) en cas de transmission Factur-X — sur instruction explicite de l'utilisateur</li>
        <li>Autorités publiques sur réquisition légale</li>
      </ul>

      <H2>7. Transferts hors UE</H2>
      <p>Certains sous-traitants sont basés aux États-Unis (Stripe, Vercel, Resend). Les transferts sont encadrés par les Clauses Contractuelles Types (SCCs) de la Commission européenne et les certifications Data Privacy Framework lorsque applicables.</p>

      <H2>8. Vos droits (RGPD)</H2>
      <p>Vous disposez des droits suivants :</p>
      <ul>
        <li>Accès, rectification, effacement de vos données</li>
        <li>Limitation et opposition au traitement</li>
        <li>Portabilité (export complet de vos données depuis Paramètres → Sécurité)</li>
        <li>Définition de directives post-mortem</li>
        <li>Réclamation auprès de la CNIL (<a href="https://www.cnil.fr" target="_blank" rel="noreferrer">cnil.fr</a>)</li>
      </ul>
      <p>Pour exercer vos droits : <a href="mailto:contact@iobill.online">contact@iobill.online</a> (réponse sous 30 jours).</p>

      <H2>9. Sécurité</H2>
      <p>IO BILL met en œuvre des mesures techniques et organisationnelles pour protéger vos données : chiffrement TLS 1.3, authentification forte, isolation RLS PostgreSQL, hash chain immutable sur les factures émises, sauvegardes journalières chiffrées.</p>

      <H2>10. Cookies</H2>
      <p>IO BILL utilise uniquement des cookies strictement nécessaires au fonctionnement du service (session, préférences). Aucun cookie publicitaire ou de tracking tiers n'est utilisé. Aucun consentement n'est requis pour ces cookies nécessaires (article 82 de la loi Informatique et Libertés).</p>
    </>
  );
}

function H2({ children }) {
  return <h2 style={{ marginTop: 28, marginBottom: 8, fontSize: 17, color: "var(--gold)" }}>{children}</h2>;
}
