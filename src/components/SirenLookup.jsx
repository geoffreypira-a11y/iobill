import React, { useState } from "react";
import { cleanSiren, isSirenSearchable, lookupEntreprise, tvaIntraFR } from "../lib/siren.js";
import { formatSiret } from "../lib/helpers.js";

/**
 * Champ « SIRET (14) ou SIREN (9) » doublé d'un bouton de recherche.
 *
 * L'appelant garde la maîtrise du remplissage : on lui rend les données de
 * l'annuaire via `onResult`, à lui de décider ce qu'il écrase et ce qu'il
 * respecte. Le composant ne connaît aucun formulaire en particulier.
 *
 * @param {string}   value     numéro saisi (avec ou sans espaces)
 * @param {Function} onChange  (numéro nettoyé) => void
 * @param {Function} onResult  (données annuaire) => void — voir lib/siren.js
 * @param {string}   label     libellé du champ
 * @param {boolean}  full      occupe toute la largeur de la grille
 */
export function SirenLookup({ value, onChange, onResult, label = "SIRET (14 chiffres) ou SIREN (9)", full = false }) {
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState(null); // { type: "ok"|"err", text }
  const ready = isSirenSearchable(value);
  const n = cleanSiren(value).length;

  async function run() {
    setLoading(true);
    setNote(null);
    const res = await lookupEntreprise(value);
    setLoading(false);
    if (!res.ok) {
      setNote({ type: "err", text: res.error });
      return;
    }
    onResult(res.data);
    setNote({
      type: "ok",
      text: res.data.ferme
        ? `${res.data.raison_sociale} — ⚠ établissement fermé au registre`
        : `${res.data.raison_sociale} — informations récupérées`,
    });
  }

  return (
    <div className="form-row" style={full ? { gridColumn: "1 / -1" } : undefined}>
      <label className="form-label">{label}</label>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="form-input"
          value={formatSiret(value || "")}
          onChange={(e) => { onChange(cleanSiren(e.target.value)); setNote(null); }}
          placeholder="9 ou 14 chiffres"
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={run}
          disabled={loading || !ready}
          title={ready
            ? "Récupérer la raison sociale et l'adresse depuis l'annuaire des entreprises"
            : "Saisissez 9 ou 14 chiffres"}
          style={{ whiteSpace: "nowrap" }}
        >
          {loading ? "⏳..." : "🔍 Récupérer"}
        </button>
      </div>
      {note && (
        <div style={{ fontSize: 11, marginTop: 4, lineHeight: 1.5, color: note.type === "ok" ? "var(--green)" : "var(--red, #e0605e)" }}>
          {note.text}
        </div>
      )}
      {!note && n > 0 && !ready && (
        <div style={{ fontSize: 11, marginTop: 4, color: "var(--orange)" }}>
          {n} chiffre{n > 1 ? "s" : ""} — il en faut 9 (SIREN) ou 14 (SIRET)
        </div>
      )}
    </div>
  );
}

/**
 * Mention sous un champ « N° TVA intracommunautaire » rempli automatiquement.
 *
 * La clé de contrôle se déduit du SIREN par la formule DGFiP, mais rien ne
 * garantit que l'administration a attribué ce numéro-là : elle peut retenir
 * une clé non standard, et une entreprise peut ne pas être assujettie du
 * tout. Or ce numéro part sur la facture puis dans le Factur-X transmis : il
 * doit être contrôlé avant validation.
 *
 * La mention ne s'affiche que tant que la valeur est celle calculée : dès que
 * l'utilisateur saisit un autre numéro, elle disparaît.
 */
export function TvaIntraNote({ siren, value }) {
  const calcule = tvaIntraFR(siren);
  const saisi = String(value || "").replace(/\s/g, "").toUpperCase();
  if (!calcule || saisi !== calcule) return null;
  return (
    <div style={{ fontSize: 11, marginTop: 4, color: "var(--orange)", lineHeight: 1.5 }}>
      ⚠️ Numéro calculé depuis le SIREN, non vérifié auprès de l'administration.
      Vérifiez sa conformité avant de valider — il figure sur la facture et dans
      le fichier transmis.{" "}
      <a
        href="https://ec.europa.eu/taxation_customs/vies/"
        target="_blank"
        rel="noreferrer"
        style={{ color: "var(--gold, #d4a843)", textDecoration: "underline" }}
      >
        Vérifier sur VIES ↗
      </a>
    </div>
  );
}
