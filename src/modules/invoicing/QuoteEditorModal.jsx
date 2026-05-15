import React, { useEffect, useMemo, useState } from "react";
import { sb } from "../../lib/supabase.js";
import { ClientPicker } from "../../components/ClientPicker.jsx";
import { LineEditor, TotalsBlock, calcDocumentTotals, calcLine, newEmptyLine } from "../../components/LineEditor.jsx";
import { fmtEUR, todayISO, toCents } from "../../lib/helpers.js";
import { buildClientSnapshot, buildCompanySnapshot } from "../../lib/snapshots.js";
import { capture, bumpModuleUsage } from "../../lib/telemetry.js";
import { CURRENCIES, VAT_CATEGORIES } from "../../lib/currency.js";

// ─── Helpers brouillon localStorage (pattern IOcar) ─────
const DRAFT_KEY = "iobill_quote_draft_new";

function saveDraft(data) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...data, _ts: Date.now() }));
  } catch {}
}
function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    // Expire après 7 jours
    if (Date.now() - (d._ts || 0) > 7 * 86400000) {
      localStorage.removeItem(DRAFT_KEY);
      return null;
    }
    return d;
  } catch { return null; }
}
function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
}

/**
 * Modale d'édition de devis (nouveau ou existant).
 *
 * Props :
 * - token, company : auth
 * - quote : objet devis existant (édition) ou null (création)
 * - onClose() : fermer sans sauver
 * - onSaved(quote) : appelé après save réussi avec le devis créé/maj
 */
export function QuoteEditorModal({ token, company, quote, onClose, onSaved }) {
  const isNew = !quote;
  const isReadonly = quote && ["signed", "converted", "refused"].includes(quote.status);

  // état du formulaire
  const [clientId, setClientId] = useState(quote?.client_id || null);
  const [client, setClient] = useState(null);
  const [issueDate, setIssueDate] = useState(quote?.issue_date || todayISO());
  const [validityDays, setValidityDays] = useState(quote?.validity_days || 30);
  const [notes, setNotes] = useState(quote?.notes || "");
  const [terms, setTerms] = useState(quote?.terms || "");
  const [currency, setCurrency] = useState(quote?.currency || "EUR");
  const [vatCategory, setVatCategory] = useState(quote?.vat_category || "standard");
  const [lines, setLines] = useState([newEmptyLine({ vat_rate: company.vat_default_rate || 20 })]);

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [draftToRestore, setDraftToRestore] = useState(null);

  const vatExempt = company.vat_regime === "franchise";

  // ─── Chargement données existantes (mode édition) ─────
  useEffect(() => {
    if (isNew) return;
    let alive = true;
    (async () => {
      const ls = await sb.select(token, "document_lines", {
        filter: `document_type=eq.quote&document_id=eq.${quote.id}`,
        order: "sort_order.asc"
      });
      if (!alive) return;
      const localLines = (ls || []).map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        unit_price_ht: (l.unit_price_ht_cents / 100).toString(),
        vat_rate: l.vat_rate,
        discount_pct: l.discount_pct
      }));
      setLines(localLines.length > 0 ? localLines : [newEmptyLine({ vat_rate: company.vat_default_rate || 20 })]);

      // Charger le client
      if (quote.client_id) {
        const c = await sb.selectOne(token, "clients", `id=eq.${quote.client_id}`);
        if (alive && c) setClient(c);
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, company.id, quote?.id, isNew]);

  // ─── Brouillon : proposer restauration au montage (création uniquement) ─────
  useEffect(() => {
    if (!isNew) return;
    const draft = loadDraft();
    if (draft && (draft.notes || draft.terms || (draft.lines && draft.lines.some((l) => l.description?.trim())))) {
      setDraftToRestore(draft);
    }
  }, []);

  // ─── Sauvegarde auto brouillon (debounce 1s) ─────
  useEffect(() => {
    if (!isNew) return;
    if (draftToRestore) return; // pas de sauvegarde tant qu'on n'a pas répondu
    const t = setTimeout(() => {
      saveDraft({ clientId, issueDate, validityDays, notes, terms, currency, vatCategory, lines });
    }, 1000);
    return () => clearTimeout(t);
  }, [isNew, draftToRestore, clientId, issueDate, validityDays, notes, terms, currency, vatCategory, lines]);

  function applyDraft(draft) {
    setClientId(draft.clientId || null);
    setIssueDate(draft.issueDate || todayISO());
    setValidityDays(draft.validityDays || 30);
    setNotes(draft.notes || "");
    setTerms(draft.terms || "");
    setCurrency(draft.currency || "EUR");
    setVatCategory(draft.vatCategory || "standard");
    if (draft.lines && draft.lines.length > 0) setLines(draft.lines);
    setDraftToRestore(null);
  }
  function discardDraft() {
    clearDraft();
    setDraftToRestore(null);
  }

  // ─── Calculs ─────
  const totals = useMemo(() => calcDocumentTotals(lines), [lines]);
  const expiresAt = useMemo(() => {
    if (!issueDate || !validityDays) return null;
    const d = new Date(issueDate);
    d.setDate(d.getDate() + Number(validityDays));
    return d.toISOString().slice(0, 10);
  }, [issueDate, validityDays]);

  // ─── Sauvegarde ─────
  async function handleSave() {
    setErr("");
    if (!clientId) { setErr("Sélectionnez un client"); return; }
    if (!client) { setErr("Client introuvable"); return; }
    if (!issueDate) { setErr("Date d'émission requise"); return; }
    if (lines.length === 0 || lines.every((l) => !l.description?.trim())) {
      setErr("Ajoutez au moins une ligne décrite");
      return;
    }

    setSaving(true);
    const t = totals;
    const cat = VAT_CATEGORIES[vatCategory] || VAT_CATEGORIES.standard;
    const payload = {
      company_id: company.id,
      client_id: clientId,
      client_snapshot: buildClientSnapshot(client),
      company_snapshot: buildCompanySnapshot(company),
      issue_date: issueDate,
      validity_days: Number(validityDays),
      expires_at: expiresAt,
      subtotal_ht_cents: t.subtotal_ht_cents,
      vat_total_cents: t.vat_total_cents,
      total_ttc_cents: t.total_ttc_cents,
      currency,
      vat_category: vatCategory,
      vat_legal_mention: cat.legal_mention || null,
      notes: notes || null,
      terms: terms || null
    };

    try {
      let saved;
      if (isNew) {
        const number = await sb.rpc(token, "allocate_document_number", {
          p_company_id: company.id,
          p_doc_type: "quote"
        });
        payload.number = number;
        payload.status = "draft";
        const created = await sb.insert(token, "quotes", payload);
        saved = created?.[0];
      } else {
        const updated = await sb.update(token, "quotes", `id=eq.${quote.id}`, payload);
        saved = updated?.[0];
      }
      if (!saved) throw new Error("Erreur d'enregistrement");

      // Réécriture des lignes : delete + insert
      await sb.delete(token, "document_lines", `document_type=eq.quote&document_id=eq.${saved.id}`);
      const linesPayload = lines
        .filter((l) => l.description?.trim())
        .map((l, idx) => {
          const c = calcLine(l);
          return {
            company_id: company.id,
            document_type: "quote",
            document_id: saved.id,
            sort_order: idx,
            description: l.description,
            quantity: Number(l.quantity || 0),
            unit: l.unit || "u",
            unit_price_ht_cents: toCents(l.unit_price_ht),
            vat_rate: Number(l.vat_rate || 0),
            discount_pct: Number(l.discount_pct || 0),
            line_ht_cents: c.line_ht_cents,
            line_vat_cents: c.line_vat_cents,
            line_ttc_cents: c.line_ttc_cents
          };
        });
      if (linesPayload.length > 0) {
        await sb.insert(token, "document_lines", linesPayload);
      }

      // Telemetry & cleanup
      if (isNew) {
        capture("quote_created", { quote_id: saved.id });
        bumpModuleUsage(token, company.id, "quotes_created");
        clearDraft();
      } else {
        capture("quote_updated", { quote_id: saved.id });
      }

      setSaving(false);
      onSaved(saved);  // notifie le parent et ferme la modale
    } catch (e) {
      setSaving(false);
      setErr(e.message || "Erreur d'enregistrement");
    }
  }

  // ─── Lignes : géré directement par LineEditor via setLines ─────

  if (loading) {
    return (
      <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal modal-lg">
          <div className="modal-body" style={{ textAlign: "center", color: "var(--muted)" }}>
            Chargement...
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && !saving && onClose()}>
      {/* ─── Popup de restauration de brouillon (pattern IOcar) ─── */}
      {draftToRestore && (
        <div className="modal-bg" style={{ zIndex: 1000 }}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-hd">
              <span className="modal-title">📝 Brouillon récupéré</span>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 16, color: "var(--text)" }}>
                Une saisie en cours a été détectée.<br />
                Voulez-vous reprendre où vous en étiez ?
              </p>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="btn btn-ghost btn-sm" onClick={discardDraft}>
                  🗑 Repartir de zéro
                </button>
                <button className="btn btn-primary btn-sm" onClick={() => applyDraft(draftToRestore)}>
                  ↩ Restaurer ma saisie
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="modal modal-lg">
        <div className="modal-hd">
          <span className="modal-title">
            {isNew ? "Nouveau devis" : `Modifier ${quote.number || "devis"}`}
            {isReadonly && <span style={{ marginLeft: 8, fontSize: 11, color: "var(--orange)" }}>· lecture seule</span>}
          </span>
          <button className="close-btn" onClick={onClose} disabled={saving}>×</button>
        </div>

        <div className="modal-body">
          {err && <div className="auth-error" style={{ marginBottom: 14 }}>{err}</div>}

          {/* Bloc Client */}
          <div style={{ marginBottom: 16 }}>
            <ClientPicker
              token={token}
              company={company}
              value={clientId}
              onChange={(id, c) => { setClientId(id); setClient(c); }}
              label="Client *"
            />
            {client && (
              <div style={{
                marginTop: 6,
                padding: "8px 12px",
                background: "var(--card2)",
                borderRadius: 8,
                fontSize: 11,
                color: "var(--muted2)",
                lineHeight: 1.5
              }}>
                <div style={{ color: "var(--text)", fontWeight: 600 }}>
                  {client.client_type === "individual"
                    ? [client.first_name, client.last_name].filter(Boolean).join(" ")
                    : client.legal_name}
                </div>
                {client.email && <div>{client.email}</div>}
                {client.phone && <div>{client.phone}</div>}
                {!client.email && (
                  <div style={{ color: "var(--orange)", marginTop: 4 }}>
                    ⚠️ Pas d'email — l'envoi par mail ne sera pas possible
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Bloc Dates + devise */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
            <div className="form-row">
              <label className="form-label">Date d'émission *</label>
              <input
                type="date"
                className="form-input"
                value={issueDate}
                onChange={(e) => setIssueDate(e.target.value)}
                disabled={isReadonly}
              />
            </div>
            <div className="form-row">
              <label className="form-label">Validité (jours)</label>
              <input
                type="number"
                className="form-input"
                value={validityDays}
                onChange={(e) => setValidityDays(e.target.value)}
                disabled={isReadonly}
                min={1}
              />
              {expiresAt && (
                <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>
                  Expire le {new Date(expiresAt).toLocaleDateString("fr-FR")}
                </div>
              )}
            </div>
            <div className="form-row">
              <label className="form-label">Devise</label>
              <select
                className="form-input"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                disabled={isReadonly}
              >
                {Object.entries(CURRENCIES).map(([code, info]) => (
                  <option key={code} value={code}>
                    {code} — {info.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Régime TVA */}
          <div className="form-row" style={{ marginBottom: 16 }}>
            <label className="form-label">Régime TVA</label>
            <select
              className="form-input"
              value={vatCategory}
              onChange={(e) => setVatCategory(e.target.value)}
              disabled={isReadonly}
            >
              {Object.entries(VAT_CATEGORIES).map(([key, cat]) => (
                <option key={key} value={key}>{cat.label}</option>
              ))}
            </select>
            {VAT_CATEGORIES[vatCategory]?.legal_mention && (
              <div style={{
                marginTop: 6,
                fontSize: 11,
                color: "var(--muted2)",
                fontStyle: "italic"
              }}>
                Mention : {VAT_CATEGORIES[vatCategory].legal_mention}
              </div>
            )}
          </div>

          {/* Lignes */}
          <div style={{ marginBottom: 16 }}>
            <div style={{
              fontFamily: "Syne, sans-serif",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 1.5,
              textTransform: "uppercase",
              color: "var(--muted)",
              marginBottom: 8
            }}>
              Détail
            </div>
            <LineEditor
              lines={lines}
              onChange={setLines}
              readonly={isReadonly}
              vatExempt={vatExempt}
              defaultVatRate={company.vat_default_rate || 20}
            />
          </div>

          {/* Totaux */}
          <TotalsBlock totals={totals} currency={currency} />

          {/* Notes & CGV */}
          <div className="form-row" style={{ marginTop: 16, marginBottom: 12 }}>
            <label className="form-label">Notes (apparaîtront sur le devis)</label>
            <textarea
              className="form-input"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={isReadonly}
              placeholder="Ex : Délai d'intervention, modalités, etc."
            />
          </div>
          <div className="form-row">
            <label className="form-label">Conditions / CGV</label>
            <textarea
              className="form-input"
              rows={2}
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              disabled={isReadonly}
              placeholder="Conditions générales de vente, modalités de règlement, etc."
            />
          </div>
        </div>

        {/* ─── Footer pattern IOcar : Annuler + Enregistrer ─── */}
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
            Annuler
          </button>
          {!isReadonly && (
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? "⏳ Enregistrement..." : "💾 Enregistrer"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
