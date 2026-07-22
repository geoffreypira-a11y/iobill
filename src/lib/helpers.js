// IO BILL - Helpers utilitaires

// MONEY : stocker en cents cote DB, convertir uniquement a l'affichage
export const toCents = (n) => Math.round(Number(n || 0) * 100);
export const fromCents = (c) => Number(c || 0) / 100;

const eurFmt = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
export const fmtEUR = (cents) => eurFmt.format(fromCents(cents));

const eurFmtCompact = new Intl.NumberFormat("fr-FR", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0
});
export const fmtEURCompact = (cents) => eurFmtCompact.format(fromCents(cents));

// DATES
export const fmtDate = (iso) => {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
};

export const fmtDateLong = (iso) => {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
};

export const daysUntil = (iso) => {
  if (!iso) return null;
  const target = new Date(iso); target.setHours(0,0,0,0);
  const now = new Date(); now.setHours(0,0,0,0);
  return Math.round((target - now) / 86400000);
};

export const todayISO = () => new Date().toISOString().slice(0, 10);

// IDs
export const uid = () => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
};

// VALIDATION
export const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || "");
export const isSiret = (s) => /^\d{14}$/.test((s || "").replace(/\s/g, ""));
export const isSiren = (s) => /^\d{9}$/.test((s || "").replace(/\s/g, ""));
// v8.48.16 — Un SIRET valide ou un SIREN valide. Utilisé côté PA :
// SUPER PDP et l'annuaire PPF référencent les entreprises par SIREN
// (9 chiffres). Le SIRET (14 chiffres) est autorisé — les 9 premiers
// sont le SIREN, on extrait à l'envoi.
export const isSiretOrSiren = (s) => {
  const x = (s || "").replace(/\s/g, "");
  return /^\d{9}$/.test(x) || /^\d{14}$/.test(x);
};
// Retourne toujours 9 chiffres depuis un SIRET ou un SIREN
export const extractSiren = (s) => {
  const x = (s || "").replace(/\s/g, "");
  if (!x) return null;
  if (x.length === 14) return x.slice(0, 9);
  if (x.length === 9) return x;
  return null;
};

export const formatSiret = (s) => {
  const x = (s || "").replace(/\s/g, "");
  if (x.length === 14) return x.slice(0,3) + " " + x.slice(3,6) + " " + x.slice(6,9) + " " + x.slice(9,14);
  if (x.length === 9) return x.slice(0,3) + " " + x.slice(3,6) + " " + x.slice(6,9);
  return s;
};

// INITIALES pour avatars
export const initials = (name) => {
  if (!name) return "??";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

// DEBOUNCE
export function debounce(fn, ms) {
  let t;
  return function() {
    const args = arguments;
    clearTimeout(t);
    t = setTimeout(() => fn.apply(null, args), ms || 250);
  };
}
