import React from "react";
import { NavLink } from "react-router-dom";
import { Icon } from "./Icon.jsx";

/**
 * BottomNav — v8.111
 *
 * Barre d'accès rapide en bas d'écran, sur téléphone uniquement.
 * Reprend le principe d'IO CAR : sur mobile, ouvrir le tiroir latéral
 * pour changer d'écran coûte deux gestes, alors que l'essentiel du
 * travail tourne autour de quatre pages.
 *
 * Elle est masquée par défaut (`display: none`) et n'apparaît que sous
 * le palier mobile : sur grand écran, la barre latérale reste la seule
 * navigation et rien ne change.
 *
 * Les modules désactivés dans Paramètres sont retirés, comme dans la
 * barre latérale — on n'offre pas un raccourci vers un écran éteint.
 * La grille s'ajuste au nombre d'entrées restantes.
 */
export function BottomNav({ company }) {
  const modules = company?.modules || {};

  const entrees = [
    { to: "/quotes",    label: "Devis",    icon: "quote",   actif: modules.quotes !== false },
    { to: "/invoices",  label: "Factures", icon: "invoice", actif: modules.invoicing !== false },
    { to: "/purchases", label: "Achats",   icon: "cart",    actif: modules.purchases !== false },
    { to: "/clients",   label: "Clients",  icon: "users",   actif: true }
  ].filter((e) => e.actif);

  if (entrees.length === 0) return null;

  return (
    <nav className="bottom-nav" style={{ gridTemplateColumns: `repeat(${entrees.length}, 1fr)` }}>
      {entrees.map((e) => (
        <NavLink
          key={e.to}
          to={e.to}
          className={({ isActive }) => "bottom-nav-item" + (isActive ? " active" : "")}
        >
          <Icon name={e.icon} size={20} className="bn-icon" />
          <span>{e.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
