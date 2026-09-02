import React, { useMemo, useState } from "react";

/**
 * v8.62 — Barre « recherche + période » des listes du cabinet.
 *
 * Le cabinet consulte les pièces d'un client sur un exercice ou un trimestre
 * de TVA précis. Les listes étaient brutes : toutes les pièces, sans moyen de
 * chercher une facture par son numéro ni de se limiter à une période.
 *
 * Le tri par colonne vit dans TableSort.jsx (déjà partagé avec les listes
 * client). Ici : la recherche texte et le filtre de dates.
 *
 * Recherche et période ne sont PAS mémorisées d'une session à l'autre,
 * contrairement au tri : retrouver une liste filtrée sans savoir pourquoi
 * ferait croire à des pièces manquantes.
 */

/** Aujourd'hui au format AAAA-MM-JJ, en heure locale (pas UTC). */
function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
/** Dernier jour du mois m (1-12) de l'année y. */
const lastDay = (y, m) => new Date(y, m, 0).getDate();

/**
 * Bornes d'un préréglage. Renvoie { from, to } en AAAA-MM-JJ, ou des chaînes
 * vides pour « toute la période ».
 *
 * Les trimestres suivent le découpage civil (jan-mars, avr-juin...), qui est
 * celui des déclarations de TVA.
 */
export function presetRange(preset, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1; // 1-12
  const q = Math.floor((m - 1) / 3);      // 0-3, trimestre en cours
  const qStart = q * 3 + 1;

  switch (preset) {
    case "this_month":
      return { from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)) };
    case "last_month": {
      const lm = m === 1 ? 12 : m - 1;
      const ly = m === 1 ? y - 1 : y;
      return { from: iso(ly, lm, 1), to: iso(ly, lm, lastDay(ly, lm)) };
    }
    case "this_quarter":
      return { from: iso(y, qStart, 1), to: iso(y, qStart + 2, lastDay(y, qStart + 2)) };
    case "last_quarter": {
      const ls = qStart - 3;
      // Le trimestre précédent bascule sur l'année d'avant quand on est au T1.
      const ly = ls < 1 ? y - 1 : y;
      const s = ls < 1 ? ls + 12 : ls;
      return { from: iso(ly, s, 1), to: iso(ly, s + 2, lastDay(ly, s + 2)) };
    }
    case "this_year":
      return { from: iso(y, 1, 1), to: iso(y, 12, 31) };
    case "last_year":
      return { from: iso(y - 1, 1, 1), to: iso(y - 1, 12, 31) };
    default: // "all" et "custom" : pas de bornes imposées
      return { from: "", to: "" };
  }
}

const PRESETS = [
  { key: "all",          label: "Toute la période" },
  { key: "this_month",   label: "Ce mois-ci" },
  { key: "last_month",   label: "Mois dernier" },
  { key: "this_quarter", label: "Trimestre en cours" },
  { key: "last_quarter", label: "Trimestre dernier" },
  { key: "this_year",    label: "Cette année" },
  { key: "last_year",    label: "Année dernière" },
  { key: "custom",       label: "Dates personnalisées" }
];

/** Minuscules sans accents, pour une recherche tolérante à la saisie. */
export function norm(s) {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * État de la barre : recherche, préréglage, bornes de dates.
 * `match(row, dateOf, fields)` applique les deux filtres à une ligne.
 */
export function useListFilters() {
  const [q, setQ] = useState("");
  const [preset, setPreset] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  function applyPreset(key) {
    setPreset(key);
    if (key === "custom") return; // on garde les bornes déjà saisies
    const r = presetRange(key);
    setFrom(r.from);
    setTo(r.to);
  }

  // Saisir une date à la main bascule en « personnalisé » : sans ça le libellé
  // afficherait « Ce mois-ci » sur des bornes qui n'y correspondent plus.
  function setFromCustom(v) { setFrom(v); setPreset("custom"); }
  function setToCustom(v) { setTo(v); setPreset("custom"); }

  function reset() { setQ(""); setPreset("all"); setFrom(""); setTo(""); }

  const active = !!(q.trim() || from || to);

  /**
   * @param row      la ligne à tester
   * @param dateOf   (row) => date de la ligne (AAAA-MM-JJ ou ISO complet)
   * @param fields   (row) => tableau des valeurs textuelles cherchables
   */
  function match(row, dateOf, fields) {
    const needle = norm(q).trim();
    if (needle) {
      const hay = norm((fields(row) || []).filter(Boolean).join(" "));
      // Chaque mot doit être présent : « fac 2026 » trouve FAC-2026-0012.
      if (!needle.split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    if (from || to) {
      // Les dates ISO se comparent comme du texte ; on tronque pour gérer
      // indifféremment une colonne `date` et un `timestamptz`.
      const d = String(dateOf(row) || "").slice(0, 10);
      if (!d) return false;              // sans date, hors de toute période
      if (from && d < from) return false;
      if (to && d > to) return false;
    }
    return true;
  }

  return { q, setQ, preset, applyPreset, from, setFrom: setFromCustom, to, setTo: setToCustom, reset, active, match };
}

/**
 * Rendu de la barre.
 *
 * @param filters      l'objet renvoyé par useListFilters()
 * @param placeholder  texte du champ de recherche
 * @param shown/total  compteur de résultats
 */
export function ListToolbar({ filters, placeholder, shown, total, children }) {
  const { q, setQ, preset, applyPreset, from, setFrom, to, setTo, reset, active } = filters;

  return (
    <div style={{
      display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
      marginBottom: 12
    }}>
      <input
        className="search-input"
        placeholder={placeholder || "Rechercher…"}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ width: 240 }}
      />

      <select
        value={preset}
        onChange={(e) => applyPreset(e.target.value)}
        title="Période"
        style={selectStyle}
      >
        {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
      </select>

      <input
        type="date"
        value={from}
        max={to || undefined}
        onChange={(e) => setFrom(e.target.value)}
        title="À partir du"
        style={dateStyle}
      />
      <span style={{ color: "var(--muted)", fontSize: 12 }}>→</span>
      <input
        type="date"
        value={to}
        min={from || undefined}
        onChange={(e) => setTo(e.target.value)}
        title="Jusqu'au"
        style={dateStyle}
      />

      {active && (
        <button className="btn btn-ghost btn-sm" onClick={reset} title="Effacer recherche et période">
          ✕ Réinitialiser
        </button>
      )}

      {children}

      <div style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>
        {active ? `${shown} sur ${total}` : `${total} ligne${total > 1 ? "s" : ""}`}
      </div>
    </div>
  );
}

/** Message affiché quand les filtres ne laissent rien passer. */
export function NoResults({ onReset }) {
  return (
    <div className="card card-pad" style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>
      <div style={{ fontSize: 13, marginBottom: 10 }}>Aucun résultat pour cette recherche ou cette période.</div>
      <button className="btn btn-ghost btn-sm" onClick={onReset}>Réinitialiser les filtres</button>
    </div>
  );
}

const selectStyle = {
  background: "var(--card)",
  border: "1px solid var(--border2)",
  borderRadius: "var(--radius-sm, 6px)",
  padding: "9px 10px",
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
  cursor: "pointer"
};

const dateStyle = {
  background: "var(--card)",
  border: "1px solid var(--border2)",
  borderRadius: "var(--radius-sm, 6px)",
  padding: "8px 10px",
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
  colorScheme: "dark"
};

export { todayISO };
