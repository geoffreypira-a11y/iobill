// Statuts devis IO BILL
// draft -> sent -> (signed | refused | expired) -> converted

export const QUOTE_STATUSES = {
  draft:     { label: "Brouillon",  cls: "badge-muted",  order: 1 },
  sent:      { label: "Envoyé",     cls: "badge-gold",   order: 2 },
  signed:    { label: "Signé",      cls: "badge-green",  order: 3 },
  refused:   { label: "Refusé",     cls: "badge-red",    order: 4 },
  expired:   { label: "Expiré",     cls: "badge-muted",  order: 5 },
  converted: { label: "Converti",   cls: "badge-green",  order: 6 }
};

export function quoteStatusBadge(status) {
  const s = QUOTE_STATUSES[status] || QUOTE_STATUSES.draft;
  return { ...s, key: status };
}

// Detection auto d'expiration (côté client uniquement, l'horodatage côté serveur reste la source de vérité)
export function isQuoteExpired(quote) {
  if (!quote.expires_at) return false;
  if (["signed", "refused", "converted"].includes(quote.status)) return false;
  return new Date(quote.expires_at) < new Date();
}
