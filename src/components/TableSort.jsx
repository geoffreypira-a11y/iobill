import React, { useMemo, useState } from "react";

/**
 * v8.53 — Tri des listes par colonne, partagé par Factures, Devis, Avoirs et
 * Achats.
 *
 * Les listes étaient triées par ordre de saisie (`created_at`), ce qui n'a
 * plus de sens dès qu'on ressaisit des documents anciens. On trie donc par
 * date réelle, et l'utilisateur peut choisir une autre colonne — son choix
 * est mémorisé par liste.
 *
 * Le tri est appliqué côté client, sur la liste déjà chargée : changer de
 * colonne n'entraîne aucun aller-retour serveur.
 */

/**
 * @param {string} storageKey  clé localStorage, unique par liste
 * @param {{key: string, dir: "asc"|"desc"}} defaultSort
 */
export function useTableSort(storageKey, defaultSort) {
  const [sort, setSort] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (saved && saved.key && (saved.dir === "asc" || saved.dir === "desc")) return saved;
    } catch { /* préférence illisible : on retombe sur le défaut */ }
    return defaultSort;
  });

  function toggleSort(key) {
    setSort((prev) => {
      // Un nouveau critère démarre décroissant (le plus récent, le plus gros
      // en premier), sauf les colonnes de texte qui se lisent de A à Z.
      const isText = key === "client" || key === "vendor" || key === "category";
      const next = prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: isText ? "asc" : "desc" };
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* mode privé */ }
      return next;
    });
  }

  return { sort, toggleSort };
}

/** En-tête de colonne cliquable. */
export function SortableTh({ label, sortKey, sort, onSort, align, style }) {
  const active = sort.key === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      title={`Trier par ${String(label).toLowerCase()}`}
      style={{
        cursor: "pointer",
        userSelect: "none",
        textAlign: align || undefined,
        whiteSpace: "nowrap",
        color: active ? "var(--gold)" : undefined,
        ...style
      }}
    >
      {label}
      <span style={{ marginLeft: 5, opacity: active ? 1 : 0.25, fontSize: 10 }}>
        {active ? (sort.dir === "asc" ? "▲" : "▼") : "▼"}
      </span>
    </th>
  );
}

/**
 * Trie une liste sans la muter.
 *
 * @param rows      lignes déjà filtrées
 * @param sort      { key, dir }
 * @param valueOf   (row, key) => valeur comparable (nombre ou chaîne)
 * @param tieBreak  (row) => valeur départageant les ex æquo (ex. le numéro),
 *                  pour un ordre stable d'un rendu à l'autre
 */
export function sortRows(rows, sort, valueOf, tieBreak) {
  const sign = sort.dir === "asc" ? 1 : -1;
  // localeCompare + numeric : sans ça "FAC-2026-0010" passerait avant
  // "FAC-2026-0009" par simple comparaison lexicale.
  const cmpValues = (a, b) =>
    (typeof a === "number" && typeof b === "number")
      ? a - b
      : String(a ?? "").localeCompare(String(b ?? ""), "fr", { numeric: true });

  return [...rows].sort((ra, rb) => {
    let cmp = cmpValues(valueOf(ra, sort.key), valueOf(rb, sort.key));
    if (cmp === 0 && tieBreak) cmp = cmpValues(tieBreak(ra), tieBreak(rb));
    return cmp * sign;
  });
}

/** Applique filtrage puis tri, en un seul useMemo mémoïsé. */
export function useSortedRows(rows, sort, valueOf, tieBreak) {
  return useMemo(
    () => sortRows(rows, sort, valueOf, tieBreak),
    // valueOf/tieBreak sont des fonctions stables définies dans le composant
    // appelant ; les recréer à chaque rendu ne coûte qu'un tri sur ≤300 lignes.
    [rows, sort] // eslint-disable-line react-hooks/exhaustive-deps
  );
}
