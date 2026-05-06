// IO BILL - i18n minimal sans dependance externe
// Pourquoi pas i18next ? Lourd (60+ KB) pour ce qu'on en fait.
// Strategie : dictionnaire plat avec cle FR comme cle native, traduction EN mappee.

import { useState, useEffect, useCallback } from "react";

const LANG_KEY = "iobill_lang";

// Detection automatique au boot : navigator.language ou localStorage
function detectLang() {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored) return stored;
    const nav = (navigator.language || "fr").slice(0, 2).toLowerCase();
    return ["fr", "en"].includes(nav) ? nav : "fr";
  } catch {
    return "fr";
  }
}

let currentLang = detectLang();
const subscribers = new Set();

export function getLang() { return currentLang; }

export function setLang(lang) {
  if (!["fr", "en"].includes(lang)) return;
  currentLang = lang;
  try { localStorage.setItem(LANG_KEY, lang); } catch {}
  subscribers.forEach((cb) => cb(lang));
  // Update HTML lang attr pour accessibilite et SEO
  if (typeof document !== "undefined") {
    document.documentElement.lang = lang;
  }
}

// Hook React qui re-render quand la langue change
export function useLang() {
  const [, force] = useState(0);
  useEffect(() => {
    const cb = () => force((n) => n + 1);
    subscribers.add(cb);
    return () => subscribers.delete(cb);
  }, []);
  return { lang: currentLang, setLang };
}

// ─── Dictionnaire FR -> EN ────────────────────────────────────
// Cle = string FR exacte. On utilise t("Texte en français") qui retourne
// la traduction EN si la langue est en, sinon la cle elle-meme.
// Avantage : zero "key not found", la version FR reste lisible dans le code.
const EN_DICT = {
  // Navigation generale
  "Tableau de bord": "Dashboard",
  "Pilotage": "Overview",
  "Devis": "Quotes",
  "Factures": "Invoices",
  "Avoirs": "Credit notes",
  "Achats": "Purchases",
  "Clients": "Clients",
  "TVA": "VAT",
  "URSSAF": "Social",
  "Export compta": "Accounting export",
  "Banque": "Banking",
  "Cabinet": "Firm",
  "Équipe": "Team",
  "Journal d'audit": "Audit log",
  "Stats plateforme": "Platform stats",
  "Paramètres": "Settings",
  "Avancé": "Advanced",
  "Déconnexion": "Sign out",

  // Actions courantes
  "Enregistrer": "Save",
  "Annuler": "Cancel",
  "Supprimer": "Delete",
  "Modifier": "Edit",
  "Confirmer": "Confirm",
  "Fermer": "Close",
  "Nouveau": "New",
  "Continuer": "Continue",
  "Suivant": "Next",
  "Précédent": "Previous",
  "Ignorer": "Skip",
  "Inviter": "Invite",
  "Accepter": "Accept",
  "Refuser": "Decline",
  "Rechercher": "Search",
  "Voir tout": "See all",
  "Voir plus": "See more",
  "Télécharger": "Download",
  "Partager": "Share",

  // Statuts
  "Brouillon": "Draft",
  "Émise": "Issued",
  "Émis": "Issued",
  "Envoyée": "Sent",
  "Envoyé": "Sent",
  "Signé": "Signed",
  "Refusé": "Declined",
  "Expiré": "Expired",
  "Converti": "Converted",
  "Payée": "Paid",
  "Payé": "Paid",
  "Partielle": "Partial",
  "En retard": "Overdue",
  "Annulée": "Canceled",
  "En attente": "Pending",
  "Validée": "Validated",
  "Acceptée": "Accepted",
  "Active": "Active",
  "Activé": "Enabled",
  "Désactivé": "Disabled",

  // KPI / métriques
  "CA HT du mois": "Revenue (excl. tax) this month",
  "Encours": "Outstanding",
  "TVA collectée": "Collected VAT",
  "DSO moyen": "Average DSO",
  "Délai de paiement moyen": "Average payment delay",
  "Année": "Year",
  "Mois": "Month",
  "facture(s) en attente": "pending invoice(s)",

  // Auth
  "Connexion": "Sign in",
  "Inscription": "Sign up",
  "Email": "Email",
  "Mot de passe": "Password",
  "Mot de passe oublié ?": "Forgot password?",
  "Créer un compte": "Create account",
  "Déjà un compte ?": "Already have an account?",
  "Pas encore de compte ?": "No account yet?",

  // Documents
  "Numéro": "Number",
  "Date d'émission": "Issue date",
  "Échéance": "Due date",
  "Validité (jours)": "Validity (days)",
  "Devise": "Currency",
  "Régime TVA": "VAT regime",
  "Désignation": "Description",
  "Quantité": "Quantity",
  "P.U. HT": "Unit price (excl. tax)",
  "Total HT": "Subtotal (excl. tax)",
  "Total TTC": "Total (incl. tax)",
  "Notes": "Notes",
  "Conditions": "Terms",
  "Conditions de paiement": "Payment terms",
  "Émettre la facture": "Issue invoice",
  "Émettre définitivement": "Issue permanently",
  "Émettre l'avoir": "Issue credit note",
  "Convertir en facture →": "Convert to invoice →",
  "Envoyer pour signature": "Send for signature",
  "Saisir un paiement": "Record a payment",
  "Créer un avoir": "Create credit note",

  // Clients
  "Nouveau client": "New client",
  "Raison sociale": "Legal name",
  "Nom": "Last name",
  "Prénom": "First name",
  "Particulier": "Individual",
  "Entreprise": "Company",
  "Adresse": "Address",
  "Téléphone": "Phone",
  "Pays": "Country",

  // Frequents
  "Chargement...": "Loading...",
  "Aucun résultat": "No results",
  "Erreur": "Error",
  "Succès": "Success",
  "à régler": "to pay",
  "à jour": "up to date",
  "Mes sociétés": "My companies",
  "Changer de société": "Switch company",
  "Notifications": "Notifications",
  "Tout est à jour": "All caught up",

  // Cabinet
  "Activer le plan Cabinet": "Activate Firm plan",
  "Inviter un client": "Invite a client",
  "Lecture seule": "Read-only",
  "Édition": "Edit",
  "Niveau d'accès": "Access level",
  "Demande de supervision": "Supervision request",

  // Settings tabs
  "Profil société": "Company profile",
  "Modules": "Modules",
  "Branding": "Branding",
  "Abonnement": "Subscription",
  "Inbox OCR": "Inbox OCR",
  "PDP": "PDP",
  "SMS": "SMS",
  "Sécurité": "Security",

  // Settings extras
  "Langue": "Language",
  "Langue de l'interface": "Interface language",
  "Relancer la visite guidée": "Restart guided tour",
  "Compte": "Account",
  "Changer le mot de passe": "Change password",
  "Zone dangereuse": "Danger zone",
  "Se déconnecter": "Sign out",

  // Conformité (sidebar)
  "Conformité": "Compliance",

  // Dashboard
  "Bonjour {name}, voici où vous en êtes en {month}": "Hello {name}, here's how you're doing in {month}",
  "Nouveau devis": "New quote",
  "CA HT — ce mois": "Revenue (excl. tax) — this month",
  "À encaisser": "Outstanding",
  "À déclarer prochainement": "To declare soon"
};

/**
 * Traduit une chaine. Si la langue active n'est pas FR, cherche dans le dico.
 * Si pas trouve, retourne la cle (= la version FR), pour ne jamais casser l'UI.
 *
 * Usage : t("Tableau de bord")
 * Avec interpolation : t("Bonjour {name}", { name: "Anthony" })
 */
export function t(key, vars) {
  let str = key;
  if (currentLang === "en" && EN_DICT[key]) {
    str = EN_DICT[key];
  }
  if (vars) {
    Object.entries(vars).forEach(([k, v]) => {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), v);
    });
  }
  return str;
}

// Hook pratique : retourne la fonction t() liee a la langue active (re-render auto)
export function useT() {
  const { lang } = useLang();
  return useCallback((key, vars) => t(key, vars), [lang]);
}
