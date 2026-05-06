// IO BILL - Avoirs : statuts et helpers
// Un avoir est rattache a une facture emise. Il peut etre total (annulation
// pure) ou partiel (rectification d'un montant).

export const CREDIT_NOTE_STATUSES = {
  draft:  { label: "Brouillon", cls: "badge-muted", order: 1 },
  issued: { label: "Émis",      cls: "badge-gold",  order: 2 }
};

export function creditNoteStatusBadge(status) {
  const s = CREDIT_NOTE_STATUSES[status] || CREDIT_NOTE_STATUSES.draft;
  return { ...s, key: status };
}

// Raisons standardisees (cf. recommandations DGFiP)
export const CREDIT_NOTE_REASONS = [
  { code: "cancellation",  label: "Annulation totale" },
  { code: "discount",      label: "Geste commercial / remise a posteriori" },
  { code: "error",         label: "Erreur de facturation" },
  { code: "return",        label: "Retour de marchandise" },
  { code: "partial_refund",label: "Remboursement partiel" },
  { code: "other",         label: "Autre" }
];
