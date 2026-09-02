// IO BILL — Applications sources du bridge externe
// ═══════════════════════════════════════════════════════════════════
// Une company IOBILL peut être pilotée par une app métier (IOCAR, IOBTP,
// IOBEAUTY...). Son `source_app` conditionne l'affichage : libellé du plan
// (« Pro · IO CAR » plutôt qu'un prix, ces comptes ne payant pas Stripe
// directement) et pictogramme sur les documents et fiches importés.
//
// v8.60 — Ce mapping était recopié à l'identique dans cinq fichiers, ce qui
// garantissait d'en oublier un en ajoutant une app. Il est désormais ici, et
// ici seulement : ajouter une app métier = une ligne dans chaque table.

export const SOURCE_APP_LABELS = {
  iocar:        "IO CAR",
  iobtp:        "IO BTP",
  ioinstitute:  "IO INSTITUTE",
  iobeauty:     "IO BEAUTY"
};

export const SOURCE_APP_EMOJIS = {
  iocar:        "🚗",
  iobtp:        "🏗",
  ioinstitute:  "🎓",
  iobeauty:     "🌠"
};

/** Libellé lisible d'une app source. Renvoie null si ce n'est pas une app externe. */
export function sourceAppLabel(src) {
  if (!src || src === "iobill") return null;
  return SOURCE_APP_LABELS[src] || String(src).toUpperCase();
}

/** Pictogramme d'une app source. Icône de lien générique par défaut. */
export function sourceAppEmoji(src) {
  if (!src || src === "iobill") return "🔗";
  return SOURCE_APP_EMOJIS[src] || "🔗";
}

/**
 * Libellé du plan affiché dans la barre latérale et les réglages.
 * Un compte piloté par une app métier n'a pas d'abonnement Stripe propre :
 * son accès IOBILL est inclus dans celui de l'app source.
 */
export function planLabel(company, { trial = false, withPrice = "Pro · 14,90 € HT/mois" } = {}) {
  const label = sourceAppLabel(company?.source_app);
  if (label) return `Pro · ${label}`;
  if (company?.sub_status === "active") return withPrice;
  if (trial) return "Essai gratuit";
  return "Découverte";
}
