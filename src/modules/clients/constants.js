// IO BILL — CRM : statuts, sources, scores

export const CLIENT_STATUTS = {
  prospect:    { label: "Prospect",      cls: "badge-muted",  icon: "🔍", order: 1 },
  quote_sent:  { label: "Devis envoyé",  cls: "badge-gold",   icon: "📤", order: 2 },
  negotiation: { label: "Négociation",   cls: "badge-orange", icon: "🤝", order: 3 },
  customer:    { label: "Client",        cls: "badge-green",  icon: "✅", order: 4 },
  vip:         { label: "Client VIP",    cls: "badge-gold",   icon: "💎", order: 5 },
  inactive:    { label: "Inactif",       cls: "badge-muted",  icon: "💤", order: 6 }
};

export const CLIENT_SOURCES = [
  { code: "word_of_mouth", label: "Bouche-à-oreille" },
  { code: "website",       label: "Site web" },
  { code: "linkedin",      label: "LinkedIn" },
  { code: "salon",         label: "Salon / événement" },
  { code: "ads",           label: "Publicité" },
  { code: "referral",      label: "Apporteur d'affaires" },
  { code: "other",         label: "Autre" }
];

export const PAYMENT_SCORES = {
  fast:   { label: "Rapide",  cls: "badge-green",  icon: "⚡" },
  normal: { label: "Normal",  cls: "badge-muted",  icon: "—"  },
  slow:   { label: "Lent",    cls: "badge-orange", icon: "🐢" },
  risky:  { label: "À risque", cls: "badge-red",   icon: "⚠️" }
};
