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

// v8.202 — `products` est le catalogue de l'entreprise, facultatif. Quand il
// est fourni, taper dans la désignation propose les produits correspondants ;
// en choisir un remplit la ligne. Le prix est COPIÉ, jamais référencé :
// augmenter un tarif au catalogue ne doit rien changer à un document déjà
// établi. Sans `products`, le champ se comporte exactement comme avant.
export function LineEditor({ lines, onChange, defaultVatRate = 20, readonly = false, vatExempt = false, products = [] }) {
  // Index de la ligne dont la liste de suggestions est ouverte, et position
  // surlignée au clavier. `null` = aucune liste affichée.
  const [suggestPour, setSuggestPour] = React.useState(null);
  // `null` tant que l'utilisateur n'est pas entré dans la liste au clavier.
  // C'est ce qui rend la suggestion non intrusive : tant qu'il écrit, Entrée
  // reste le retour à la ligne qu'elle a toujours été. Il faut une flèche
  // (ou la souris) pour donner la main à la liste.
  const [surligne, setSurligne] = React.useState(null);
  // Le survol souris est purement visuel et n'entre PAS dans `surligne` :
  // sinon la souris posée par hasard au-dessus de la liste rendrait à Entrée
  // son pouvoir de sélection, en plein milieu d'une désignation qu'on tape.
  const [survol, setSurvol] = React.useState(null);

  const catalogue = React.useMemo(
    () => (products || []).filter((p) => !p.archived),
    [products]
  );

  function suggestions(texte) {
    const s = String(texte || "").toLowerCase().trim();
    if (s.length < 2) return [];
    return catalogue
      .filter((p) =>
        (p.designation || "").toLowerCase().includes(s)
        || (p.reference || "").toLowerCase().includes(s))
      .slice(0, 8);
  }

  // Choisir un produit remplit la ligne d'un coup. La description longue, si
  // elle existe, vient sous la désignation : c'est ce que le client lira.
  function choisirProduit(i, p) {
    update(i, {
      description: p.description
        ? `${p.designation}\n${p.description}`
        : p.designation,
      unit: p.unit || "u",
      unit_price_ht: String((p.unit_price_ht_cents || 0) / 100),
      vat_rate: vatExempt ? 0 : Number(p.vat_rate ?? defaultVatRate)
    });
    setSuggestPour(null);
  }

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
          gridTemplateColumns: readonly ? "2.4fr .6fr .6fr 1fr .6fr 1.1fr" : "2.4fr .6fr .6fr 1fr .6fr .8fr 1.1fr 0.9fr",
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
              gridTemplateColumns: readonly ? "2.4fr .6fr .6fr 1fr .6fr 1.1fr" : "2.4fr .6fr .6fr 1fr .6fr .8fr 1.1fr 0.9fr",
              gap: 8,
              alignItems: "center",
              padding: "8px 0",
              borderBottom: "1px solid var(--border2)"
            }}
          >
            {(() => {
              const props = suggestPour === i ? suggestions(l.description) : [];
              return (
                <div style={{ position: "relative" }}>
                  <textarea
                    className="form-input"
                    value={l.description || ""}
                    onChange={(e) => {
                      update(i, { description: e.target.value });
                      if (catalogue.length > 0) { setSuggestPour(i); setSurligne(null); }
                    }}
                    onFocus={() => { if (catalogue.length > 0) { setSuggestPour(i); setSurligne(null); } }}
                    // Un clic sur une suggestion fait perdre le focus au champ.
                    // On laisse au clic le temps d'aboutir avant de fermer.
                    onBlur={() => setTimeout(() => setSuggestPour((cur) => cur === i ? null : cur), 150)}
                    onKeyDown={(e) => {
                      if (props.length === 0) return;
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setSurligne((x) => x === null ? 0 : (x + 1) % props.length);
                      }
                      else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setSurligne((x) => x === null ? props.length - 1 : (x - 1 + props.length) % props.length);
                      }
                      else if (e.key === "Enter" && surligne !== null) {
                        // Entrée ne valide une suggestion QUE si l'on est
                        // descendu dans la liste. Sinon elle passe son chemin
                        // et le navigateur insère un retour à la ligne, comme
                        // avant l'arrivée du catalogue : on écrit une
                        // désignation sur trois lignes sans être interrompu.
                        e.preventDefault();
                        choisirProduit(i, props[surligne]);
                      }
                      else if (e.key === "Escape") { setSuggestPour(null); setSurligne(null); }
                    }}
                    placeholder={catalogue.length > 0
                      ? "Désignation — Entrée = nouvelle ligne, ↓ pour le catalogue"
                      : "Désignation (Entrée = nouvelle ligne)"}
                    disabled={readonly}
                    rows={1}
                    ref={(el) => {
                      if (!el || el.dataset.hauteurPour === el.value) return;
                      el.style.height = "auto";
                      el.style.height = el.scrollHeight + "px";
                      el.dataset.hauteurPour = el.value;
                    }}
                    onInput={(e) => {
                      e.target.style.height = "auto";
                      e.target.style.height = e.target.scrollHeight + "px";
                      e.target.dataset.hauteurPour = e.target.value;
                    }}
                    style={{ fontSize: 12.5, resize: "vertical", minHeight: 34, lineHeight: 1.4, fontFamily: "inherit", overflow: "hidden" }}
                  />
                  {props.length > 0 && (
                    <div style={{
                      position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50,
                      background: "var(--card)", border: "1px solid var(--border)",
                      borderRadius: 8, marginTop: 2, overflow: "hidden",
                      boxShadow: "0 8px 24px rgba(0,0,0,.4)", maxHeight: 260, overflowY: "auto"
                    }}>
                      {props.map((p, k) => (
                        <div
                          key={p.id}
                          onMouseDown={(e) => { e.preventDefault(); choisirProduit(i, p); }}
                          onMouseEnter={() => setSurvol(k)}
                          onMouseLeave={() => setSurvol(null)}
                          style={{
                            padding: "7px 10px", cursor: "pointer", display: "flex",
                            justifyContent: "space-between", alignItems: "baseline", gap: 10,
                            background: (k === surligne || k === survol) ? "rgba(212,168,67,.12)" : "transparent"
                          }}
                        >
                          <span style={{ fontSize: 12.5, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {p.designation}
                            {p.reference && (
                              <span className="mono" style={{ color: "var(--muted)", fontSize: 10.5, marginLeft: 6 }}>
                                {p.reference}
                              </span>
                            )}
                          </span>
                          <span className="mono" style={{ fontSize: 12, color: "var(--gold)", whiteSpace: "nowrap" }}>
                            {fmtEUR(p.unit_price_ht_cents)} / {p.unit}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
            <input
              type="number"
              step="1"
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
              step="1"
              className="form-input mono"
              value={l.unit_price_ht ?? ""}
              onChange={(e) => update(i, { unit_price_ht: e.target.value })}
              disabled={readonly}
              style={{ fontSize: 12.5, textAlign: "right" }}
              placeholder="0,00"
            />
            <input
              type="number"
              step="1"
              className="form-input mono"
              value={l.discount_pct ?? 0}
              onChange={(e) => update(i, { discount_pct: e.target.value })}
              disabled={readonly}
              style={{ fontSize: 12.5, textAlign: "right" }}
            />
            {!readonly && (
              <select
                className="form-input"
                value={vatExempt ? 0 : (l.vat_rate ?? 20)}
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
              <div style={{ display: "flex", gap: 1, justifyContent: "flex-end", alignItems: "center" }}>
                {/* v8.201 — Réordonner les lignes. `move()` existait depuis
                    longtemps dans ce composant, sans rien pour l'appeler.
                    Deux flèches suffisent : dans la pratique on déplace une
                    ligne d'un ou deux crans, et elles fonctionnent au doigt —
                    ce que le glisser-déposer natif ne fait pas.
                    Le composant étant partagé, devis, factures et avoirs en
                    héritent ensemble. */}
                <button
                  type="button"
                  className="btn-xs"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  style={{
                    background: "transparent", border: "none", cursor: i === 0 ? "default" : "pointer",
                    color: i === 0 ? "var(--border2)" : "var(--muted)", padding: "2px 3px", fontSize: 11, lineHeight: 1
                  }}
                  title={i === 0 ? "Déjà en première position" : "Monter cette ligne"}
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="btn-xs"
                  onClick={() => move(i, 1)}
                  disabled={i === lines.length - 1}
                  style={{
                    background: "transparent", border: "none", cursor: i === lines.length - 1 ? "default" : "pointer",
                    color: i === lines.length - 1 ? "var(--border2)" : "var(--muted)", padding: "2px 3px", fontSize: 11, lineHeight: 1
                  }}
                  title={i === lines.length - 1 ? "Déjà en dernière position" : "Descendre cette ligne"}
                >
                  ▼
                </button>
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
