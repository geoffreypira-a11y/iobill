// Statuts factures IO BILL
// draft -> issued (verrouillée) -> sent -> partial/paid/overdue -> [canceled]

export const INVOICE_STATUSES = {
  draft:    { label: "Brouillon", cls: "badge-muted",  order: 1 },
  issued:   { label: "Émise",     cls: "badge-gold",   order: 2 },
  sent:     { label: "Envoyée",   cls: "badge-gold",   order: 3 },
  partial:  { label: "Partielle", cls: "badge-orange", order: 4 },
  paid:     { label: "Payée",     cls: "badge-green",  order: 5 },
  overdue:  { label: "En retard", cls: "badge-red",    order: 6 },
  canceled: { label: "Annulée",   cls: "badge-muted",  order: 7 }
};

export function invoiceStatusBadge(status) {
  const s = INVOICE_STATUSES[status] || INVOICE_STATUSES.draft;
  return { ...s, key: status };
}

export function isInvoiceLocked(status) {
  return ["issued", "sent", "partial", "paid", "overdue"].includes(status);
}

export function isInvoiceOverdue(invoice) {
  if (!invoice.due_date) return false;
  if (!["issued", "sent", "partial"].includes(invoice.status)) return false;
  return new Date(invoice.due_date) < new Date();
}

export function paymentMethodLabel(method) {
  return ({
    bank_transfer: "Virement",
    stripe:        "Stripe",
    cash:          "Espèces",
    check:         "Chèque",
    other:         "Autre"
  }[method] || method || "—");
}
