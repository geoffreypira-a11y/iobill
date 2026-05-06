// IO BILL - Helpers multi-devises et categories TVA pour B2B/B2C/export

// ─── Devises supportees ─────────────────────────────────────
export const CURRENCIES = [
  { code: "EUR", symbol: "€",  name: "Euro" },
  { code: "USD", symbol: "$",  name: "Dollar US" },
  { code: "GBP", symbol: "£",  name: "Livre sterling" },
  { code: "CHF", symbol: "CHF", name: "Franc suisse" },
  { code: "CAD", symbol: "$CA", name: "Dollar canadien" },
  { code: "JPY", symbol: "¥",  name: "Yen" },
  { code: "AUD", symbol: "$AU", name: "Dollar australien" },
  { code: "SEK", symbol: "kr", name: "Couronne suedoise" },
  { code: "DKK", symbol: "kr", name: "Couronne danoise" },
  { code: "NOK", symbol: "kr", name: "Couronne norvegienne" },
  { code: "PLN", symbol: "zł", name: "Zloty polonais" }
];

export function getCurrency(code) {
  return CURRENCIES.find((c) => c.code === code) || CURRENCIES[0];
}

export function formatMoney(amount, currencyCode = "EUR") {
  const cur = getCurrency(currencyCode);
  try {
    return new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: cur.code,
      maximumFractionDigits: 2
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${cur.symbol}`;
  }
}

// ─── Categories TVA (selon localisation client + nature operation) ────
export const VAT_CATEGORIES = {
  standard: {
    label: "TVA française standard",
    description: "Client situé en France, TVA française appliquée (5,5% / 10% / 20%)",
    requires_vat_number: false,
    forces_zero_vat: false
  },
  export_eu_b2b: {
    label: "Livraison/prestation intracom B2B",
    description: "Client UE professionnel avec n° TVA intracom valide → autoliquidation",
    requires_vat_number: true,
    forces_zero_vat: true,
    legal_mention: "Autoliquidation — Article 196 de la directive 2006/112/CE. TVA due par le preneur."
  },
  export_eu_b2c: {
    label: "Vente UE B2C (OSS)",
    description: "Client UE particulier — TVA du pays du client si seuil 10k€ depasse",
    requires_vat_number: false,
    forces_zero_vat: false,
    legal_mention: "Régime OSS — Guichet unique TVA UE."
  },
  export_outside_eu: {
    label: "Export hors UE",
    description: "Client hors UE (US, UK, CH, etc.) → exonération de TVA",
    requires_vat_number: false,
    forces_zero_vat: true,
    legal_mention: "Exonération de TVA — Article 262 ter du CGI (export)."
  },
  reverse_charge: {
    label: "Autoliquidation BTP",
    description: "Sous-traitance dans le secteur du bâtiment (article 283-2 nonies du CGI)",
    requires_vat_number: false,
    forces_zero_vat: true,
    legal_mention: "Autoliquidation — TVA due par le preneur (article 283-2 nonies du CGI, sous-traitance BTP)."
  },
  franchise: {
    label: "Franchise en base de TVA",
    description: "Auto-entrepreneur sous le seuil — TVA non applicable",
    requires_vat_number: false,
    forces_zero_vat: true,
    legal_mention: "TVA non applicable, art. 293 B du CGI."
  }
};

// Liste des codes pays UE (pour autoliquidation B2B intracom)
export const EU_COUNTRIES = [
  "AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE",
  "IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE"
];

export function isEUCountry(code) {
  return EU_COUNTRIES.includes(String(code || "").toUpperCase());
}

export function isOutsideEU(code) {
  if (!code) return false;
  return !isEUCountry(code);
}

/**
 * Suggere automatiquement la categorie TVA selon le client et la company
 */
export function suggestVatCategory(client, company) {
  if (company?.vat_regime === "franchise") return "franchise";
  if (!client) return "standard";

  const clientCountry = (client.country || "FR").toUpperCase();
  const companyCountry = (company?.country || "FR").toUpperCase();

  // Meme pays = standard
  if (clientCountry === companyCountry) return "standard";

  // UE
  if (isEUCountry(clientCountry)) {
    // B2B avec VAT number → autoliquidation
    if (client.client_type === "company" && client.vat_number) return "export_eu_b2b";
    // B2C ou B2B sans VAT → OSS
    return "export_eu_b2c";
  }

  // Hors UE
  return "export_outside_eu";
}

// ─── Conversion devises (taux) ─────────────────────────────────
// Pour V1, on utilise frankfurter.app (taux BCE, gratuit, pas de cle API).
// Il y a aussi exchangerate.host et openexchangerates si besoin (avec cle).
export async function fetchExchangeRate(fromCurrency, toCurrency = "EUR", date = null) {
  if (fromCurrency === toCurrency) return { rate: 1, date: date || new Date().toISOString().slice(0, 10) };

  const dateStr = date || "latest";
  try {
    const r = await fetch(`https://api.frankfurter.app/${dateStr}?from=${fromCurrency}&to=${toCurrency}`);
    if (!r.ok) return null;
    const j = await r.json();
    return { rate: j.rates?.[toCurrency], date: j.date };
  } catch {
    return null;
  }
}
