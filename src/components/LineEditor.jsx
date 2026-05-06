import React from "react";
import { Icon } from "./Icon.jsx";
import { fmtEUR, toCents, fromCents, uid } from "../lib/helpers.js";

// VAT rates available in France
export const VAT_RATES = [
  { value: 20, label: "20% — Normal" },
  { value: 10, label: "10% — Intermédiaire" },
  { value: 5.5, label: "5,5% — Réduit" },
  { value: 2.1, label: "2,1% — Spécial" },
  { value: 0, label: "0% — Exonéré / hors champ" }
];

export const UNITS = [
  { value: "u", label: "u (unité)" },
  { value: "h", label: "h (heure)" },
  { value: "j", label: "j (jour)" },
  { value: "mois", label: "mois" },
  { value: "kg", label: "kg" },
  { value: "m", label: "m" },
  { value: "m²", label: "m²" },
  { value: "m³", label: "m³" },
  { value: "forfait", label: "forfait" }
];

/**
 * Calcule les totaux d'une ligne. Tout en cents pour éviter les pertes de précision.
 * Renvoie : { line_ht_cents, line_vat_cents, line_ttc_cents }
 */
export function calcLine(line) {
  const qty = Number(line.quantity || 0);
  const unitHT = toCents(line.unit_price_ht);    // saisie en €, stockée en cents
  const discountPct = Number(line.discount_pct || 0);
  const vatRate = Number(line.vat_rate || 0);

  const grossHT = Math.round(qty * unitHT);
  const discount = Math.round((grossHT * discountPct) / 100);
  const lineHT = grossHT - discount;
  const lineVat = Math.round((lineHT * vatRate) / 100);
  const lineTTC = lineHT + lineVat;

  return { line_ht_cents: lineHT, line_vat_cents: lineVat, line_ttc_cents: lineTTC };
}

/**
 * Calcule les totaux globaux et la ventilation par taux de TVA
 */
export function calcDocumentTotals(lines) {
  let subtotalHT = 0;
  let totalVat = 0;
  let totalTTC = 0;
  const byRate = {};

  lines.forEach((l) => {
    const { line_ht_cents, line_vat_cents, line_ttc_cents } = calcLine(l);
    subtotalHT += line_ht_cents;
    totalVat += line_vat_cents;
    totalTTC += line_ttc_cents;
    const r = Number(l.vat_rate || 0);
    if (!byRate[r]) byRate[r] = { rate: r, base_cents: 0, vat_cents: 0 };
    byRate[r].base_cents += line_ht_cents;
    byRate[r].vat_cents += line_vat_cents;
  });

  return {
    subtotal_ht_cents: subtotalHT,
    vat_total_cents: totalVat,
    total_ttc_cents: totalTTC,
    vat_breakdown: Object.values(byRate).sort((a, b) => a.rate - b.rate)
  };
}

export function newEmptyLine(defaults = {}) {
  return {
    _localId: uid(),
    description: "",
    quantity: 1,
    unit: "u",
    unit_price_ht: "",
    vat_rate: defaults.vat_rate ?? 20,
    discount_pct: 0
  };
}

export function LineEditor({ lines, onChange, defaultVatRate = 20, readonly = false, vatExempt = false }) {
  function update(i, patch) {
    const next = [...lines];
    next[i] = { ...next[i], ...patch };
    onChange(next);
  }
  function remove(i) {
    onChange(lines.filter((_, idx) => idx !== i));
  }
  function add() {
    onChange([...lines, newEmptyLine({ vat_rate: vatExempt ? 0 : defaultVatRate })]);
  }
  function move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= lines.length) return;
    const next = [...lines];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }

  return (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: readonly ? "2.4fr .6fr .6fr 1fr .6fr 1.1fr" : "2.4fr .6fr .6fr 1fr .6fr .8fr 1.1fr 0.4fr",
          gap: 8,
          fontSize: 9.5,
          letterSpacing: 1.4,
          textTransform: "uppercase",
          color: "var(--muted)",
          fontWeight: 600,
          padding: "0 0 8px",
          borderBottom: "1px solid var(--border2)"
        }}
      >
        <span>Désignation</span>
        <span>Qté</span>
        <span>Unité</span>
        <span style={{ textAlign: "right" }}>P.U. HT</span>
        <span style={{ textAlign: "right" }}>Remise</span>
        {!readonly && <span>TVA</span>}
        <span style={{ textAlign: "right" }}>Total HT</span>
        {!readonly && <span></span>}
      </div>

      {lines.length === 0 && (
        <div style={{ padding: 24, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
          Aucune ligne. <span style={{ color: "var(--gold)", cursor: "pointer" }} onClick={add}>Ajouter la première</span>
        </div>
      )}

      {lines.map((l, i) => {
        const totals = calcLine(l);
        return (
          <div
            key={l._localId || l.id || i}
            style={{
              display: "grid",
              gridTemplateColumns: readonly ? "2.4fr .6fr .6fr 1fr .6fr 1.1fr" : "2.4fr .6fr .6fr 1fr .6fr .8fr 1.1fr 0.4fr",
              gap: 8,
              alignItems: "center",
              padding: "8px 0",
              borderBottom: "1px solid var(--border2)"
            }}
          >
            <input
              className="form-input"
              value={l.description || ""}
              onChange={(e) => update(i, { description: e.target.value })}
              placeholder="Désignation"
              disabled={readonly}
              style={{ fontSize: 12.5 }}
            />
            <input
              type="number"
              step="0.01"
              className="form-input mono"
              value={l.quantity ?? ""}
              onChange={(e) => update(i, { quantity: e.target.value })}
              disabled={readonly}
              style={{ fontSize: 12.5, textAlign: "right" }}
            />
            <select
              className="form-input"
              value={l.unit || "u"}
              onChange={(e) => update(i, { unit: e.target.value })}
              disabled={readonly}
              style={{ fontSize: 12 }}
            >
              {UNITS.map((u) => <option key={u.value} value={u.value}>{u.value}</option>)}
            </select>
            <input
              type="number"
              step="0.01"
              className="form-input mono"
              value={l.unit_price_ht ?? ""}
              onChange={(e) => update(i, { unit_price_ht: e.target.value })}
              disabled={readonly}
              style={{ fontSize: 12.5, textAlign: "right" }}
              placeholder="0,00"
            />
            <input
              type="number"
              step="0.1"
              className="form-input mono"
              value={l.discount_pct ?? 0}
              onChange={(e) => update(i, { discount_pct: e.target.value })}
              disabled={readonly}
              style={{ fontSize: 12.5, textAlign: "right" }}
            />
            {!readonly && (
              <select
                className="form-input"
                value={l.vat_rate ?? 20}
                onChange={(e) => update(i, { vat_rate: Number(e.target.value) })}
                disabled={readonly || vatExempt}
                style={{ fontSize: 11.5 }}
              >
                {VAT_RATES.map((r) => <option key={r.value} value={r.value}>{r.value}%</option>)}
              </select>
            )}
            <span className="mono" style={{ textAlign: "right", fontSize: 12.5, color: "var(--text)" }}>
              {fmtEUR(totals.line_ht_cents)}
            </span>
            {!readonly && (
              <div style={{ display: "flex", gap: 2, justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="btn-xs"
                  onClick={() => remove(i)}
                  style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 4 }}
                  title="Supprimer"
                >
                  ×
                </button>
              </div>
            )}
          </div>
        );
      })}

      {!readonly && (
        <button
          type="button"
          onClick={add}
          style={{
            background: "transparent",
            border: "1px dashed var(--border)",
            color: "var(--gold)",
            padding: "8px 14px",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 500,
            marginTop: 12,
            display: "inline-flex",
            alignItems: "center",
            gap: 5
          }}
        >
          <Icon name="plus" size={12} /> Ajouter une ligne
        </button>
      )}
    </div>
  );
}

export function TotalsBlock({ totals, currency = "EUR", showTTC = true }) {
  return (
    <div
      style={{
        marginTop: 18,
        paddingTop: 14,
        borderTop: "1px dashed var(--border)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        maxWidth: 320,
        marginLeft: "auto",
        fontSize: 13
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", color: "var(--muted2)" }}>
        <span>Total HT</span>
        <span className="mono">{fmtEUR(totals.subtotal_ht_cents)}</span>
      </div>
      {(totals.vat_breakdown || []).map((v) => (
        <div key={v.rate} style={{ display: "flex", justifyContent: "space-between", color: "var(--muted2)", fontSize: 12 }}>
          <span>TVA {v.rate}%</span>
          <span className="mono">{fmtEUR(v.vat_cents)}</span>
        </div>
      ))}
      {showTTC && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            color: "var(--gold)",
            fontFamily: "Syne, sans-serif",
            fontWeight: 700,
            fontSize: 18,
            paddingTop: 6,
            borderTop: "1px solid var(--border)",
            marginTop: 4
          }}
        >
          <span>Total TTC</span>
          <span>{fmtEUR(totals.total_ttc_cents)}</span>
        </div>
      )}
    </div>
  );
}
