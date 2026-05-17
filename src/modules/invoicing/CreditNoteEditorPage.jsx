// IO BILL — Éditeur d'avoir
// v8.14 : UX simplifiée (checkboxes lignes + qty), validation montant max,
// actions post-émission (Aperçu PDF, Envoyer, Transmettre, Télécharger),
// retour automatique à la liste après émission.

import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams, Link } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { TotalsBlock, calcLine } from "../../components/LineEditor.jsx";
import { fmtEUR, fmtDate, todayISO } from "../../lib/helpers.js";
import { snapshotDisplayName } from "../../lib/snapshots.js";
import { DocumentPreviewModal } from "../../components/DocumentPreviewModal.jsx";
import { creditNoteStatusBadge, CREDIT_NOTE_REASONS } from "./creditNoteHelpers.js";

export function CreditNoteEditorPage({ token, company }) {
  const { id } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const isNew = !id || id === "new";
  const fromInvoiceId = search.get("from_invoice");

  // État document
  const [creditNote, setCreditNote] = useState(null);
  const [sourceInvoice, setSourceInvoice] = useState(null);
  const [sourceLines, setSourceLines] = useState([]);   // lignes de la facture source (référence)
  const [alreadyCreditedCents, setAlreadyCreditedCents] = useState(0);
  const [issueDate, setIssueDate] = useState(todayISO());
  const [reason, setReason] = useState("error");
  const [reasonNote, setReasonNote] = useState("");
  const [notes, setNotes] = useState("");

  // Modèle UX simplifié : pour chaque ligne source on a un éditeur
  //   { source_id, description, unit, vat_rate, unit_price_ht, discount_pct,
  //     source_qty, qty (avoir), checked }
  const [pickerLines, setPickerLines] = useState([]);

  // Pour les avoirs existants (réouverture), on a les lignes stockées directement
  const [storedLines, setStoredLines] = useState([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [confirmIssue, setConfirmIssue] = useState(false);
  const [previewDoc, setPreviewDoc] = useState(null);
  const [toast, setToast] = useState(null);

  const isReadonly = creditNote && creditNote.status === "issued";

  function showToast(message, type = "success") {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }

  // ─── Chargement ─────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);

      if (!isNew) {
        // Édition d'un avoir existant
        const [cn, ls] = await Promise.all([
          sb.selectOne(token, "credit_notes", `id=eq.${id}`),
          sb.select(token, "document_lines", {
            filter: `document_type=eq.credit_note&document_id=eq.${id}`,
            order: "sort_order.asc"
          })
        ]);
        if (!alive) return;
        if (!cn) { setErr("Avoir introuvable"); setLoading(false); return; }

        const sourceInv = cn.invoice_id
          ? await sb.selectOne(token, "invoices", `id=eq.${cn.invoice_id}`)
          : null;
        setCreditNote(cn);
        setSourceInvoice(sourceInv);
        setStoredLines(ls || []);
        setIssueDate(cn.issue_date);
        setReason(parseReasonCode(cn.reason));
        setReasonNote(parseReasonNote(cn.reason));
        setNotes(cn.notes || "");
        setLoading(false);
        return;
      }

      // Création : il FAUT une facture source
      if (!fromInvoiceId) {
        setErr("Pour créer un avoir, ouvrez une facture émise puis cliquez « Créer un avoir »");
        setLoading(false);
        return;
      }
      const [inv, invLines, otherCNs] = await Promise.all([
        sb.selectOne(token, "invoices", `id=eq.${fromInvoiceId}`),
        sb.select(token, "document_lines", {
          filter: `document_type=eq.invoice&document_id=eq.${fromInvoiceId}`,
          order: "sort_order.asc"
        }),
        sb.select(token, "credit_notes", {
          filter: `invoice_id=eq.${fromInvoiceId}&status=eq.issued`,
          select: "total_ttc_cents"
        })
      ]);
      if (!alive) return;
      if (!inv) { setErr("Facture source introuvable"); setLoading(false); return; }
      if (!["issued", "sent", "partial", "paid", "overdue"].includes(inv.status)) {
        setErr("Seule une facture émise peut donner lieu à un avoir");
        setLoading(false);
        return;
      }

      const alreadyCredited = (otherCNs || []).reduce((s, c) => s + (c.total_ttc_cents || 0), 0);
      if (alreadyCredited >= (inv.total_ttc_cents || 0)) {
        setErr(`Cette facture est déjà entièrement créditée (${fmtEUR(alreadyCredited)} / ${fmtEUR(inv.total_ttc_cents)})`);
        setSourceInvoice(inv);
        setLoading(false);
        return;
      }

      setSourceInvoice(inv);
      setAlreadyCreditedCents(alreadyCredited);
      setSourceLines(invLines || []);
      setPickerLines((invLines || []).map(toPickerLine));
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [id, isNew, fromInvoiceId, token]);

  // ─── Calculs côté création ─────────────────────────────────
  const totals = useMemo(() => {
    if (!isNew) return null;
    // On ne somme que les lignes cochées avec amount > 0
    let ht = 0, vat = 0;
    const byRate = {};
    pickerLines.forEach((l) => {
      if (!l.checked) return;
      const amountHt = Number(l.amount_ht) || 0;
      if (amountHt <= 0) return;
      const fullHtCents = calcLine({
        quantity: l.source_qty,
        unit_price_ht: l.unit_price_ht,
        vat_rate: l.vat_rate,
        discount_pct: l.discount_pct
      }).line_ht_cents;
      if (fullHtCents <= 0) return;
      // Ratio = part créditée / part totale facturée pour cette ligne
      const ratio = Math.min(1, Math.round(amountHt * 100) / fullHtCents);
      const creditedQty = l.source_qty * ratio;
      const c = calcLine({
        quantity: creditedQty,
        unit_price_ht: l.unit_price_ht,
        vat_rate: l.vat_rate,
        discount_pct: l.discount_pct
      });
      ht += c.line_ht_cents;
      vat += c.line_vat_cents;
      const key = String(l.vat_rate);
      byRate[key] = byRate[key] || { rate: l.vat_rate, base_cents: 0, vat_cents: 0 };
      byRate[key].base_cents += c.line_ht_cents;
      byRate[key].vat_cents += c.line_vat_cents;
    });
    return {
      subtotal_ht_cents: ht,
      vat_total_cents: vat,
      total_ttc_cents: ht + vat,
      vat_breakdown: Object.values(byRate).sort((a, b) => a.rate - b.rate)
    };
  }, [pickerLines, isNew]);

  const maxRefundCents = sourceInvoice
    ? Math.max(0, (sourceInvoice.total_ttc_cents || 0) - alreadyCreditedCents)
    : 0;

  const overLimit = totals && totals.total_ttc_cents > maxRefundCents;

  // ─── Actions sur lignes ────────────────────────────────────
  function toggleLine(idx) {
    setPickerLines((ls) => ls.map((l, i) => i === idx ? { ...l, checked: !l.checked } : l));
  }
  function updateAmount(idx, newAmount) {
    setPickerLines((ls) => ls.map((l, i) => {
      if (i !== idx) return l;
      // Borne haute : montant HT total de la ligne facturée
      const fullHt = calcLine({
        quantity: l.source_qty,
        unit_price_ht: l.unit_price_ht,
        vat_rate: l.vat_rate,
        discount_pct: l.discount_pct
      }).line_ht_cents / 100;
      const amt = Math.max(0, Math.min(Number(newAmount) || 0, fullHt));
      return { ...l, amount_ht: amt.toFixed(2) };
    }));
  }
  function checkAll() {
    setPickerLines((ls) => ls.map((l) => {
      const fullHt = calcLine({
        quantity: l.source_qty,
        unit_price_ht: l.unit_price_ht,
        vat_rate: l.vat_rate,
        discount_pct: l.discount_pct
      }).line_ht_cents / 100;
      return { ...l, checked: true, amount_ht: fullHt.toFixed(2) };
    }));
  }
  function uncheckAll() {
    setPickerLines((ls) => ls.map((l) => ({ ...l, checked: false })));
  }

  // ─── Sauvegarde brouillon ──────────────────────────────────
  async function save({ thenStatus = null } = {}) {
    setErr("");
    if (!sourceInvoice) { setErr("Facture source manquante"); return null; }

    // Construire les lignes finales à partir du picker (création) ou stored (édition)
    const finalLines = isNew
      ? pickerLines
          .filter((l) => l.checked && Number(l.amount_ht) > 0 && l.description?.trim())
          .map((l) => {
            // Convertir le montant HT cible en quantité (proportionnelle)
            const fullHtCents = calcLine({
              quantity: l.source_qty,
              unit_price_ht: l.unit_price_ht,
              vat_rate: l.vat_rate,
              discount_pct: l.discount_pct
            }).line_ht_cents;
            const targetHtCents = Math.round(Number(l.amount_ht) * 100);
            const ratio = fullHtCents > 0 ? Math.min(1, targetHtCents / fullHtCents) : 0;
            const creditedQty = Number((l.source_qty * ratio).toFixed(4));
            return {
              description: l.description,
              quantity: creditedQty,
              unit: l.unit || "u",
              unit_price_ht_cents: Math.round(l.unit_price_ht * 100),
              vat_rate: Number(l.vat_rate || 0),
              discount_pct: Number(l.discount_pct || 0)
            };
          })
      : storedLines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unit: l.unit || "u",
          unit_price_ht_cents: l.unit_price_ht_cents,
          vat_rate: l.vat_rate,
          discount_pct: l.discount_pct || 0
        }));

    if (finalLines.length === 0) {
      setErr("Sélectionnez au moins une ligne à créditer");
      return null;
    }
    if (overLimit) {
      setErr(`Le montant total dépasse le maximum (${fmtEUR(maxRefundCents)} disponibles sur cette facture)`);
      return null;
    }

    setSaving(true);

    // Recalcul des totaux serveur-side (sécurité)
    let ht = 0, vat = 0;
    const byRate = {};
    finalLines.forEach((l) => {
      const c = calcLine({
        quantity: l.quantity,
        unit_price_ht: l.unit_price_ht_cents / 100,
        vat_rate: l.vat_rate,
        discount_pct: l.discount_pct
      });
      ht += c.line_ht_cents;
      vat += c.line_vat_cents;
      const key = String(l.vat_rate);
      byRate[key] = byRate[key] || { rate: l.vat_rate, base_cents: 0, vat_cents: 0 };
      byRate[key].base_cents += c.line_ht_cents;
      byRate[key].vat_cents += c.line_vat_cents;
    });

    const payload = {
      company_id: company.id,
      invoice_id: sourceInvoice.id,
      client_id: sourceInvoice.client_id,
      client_snapshot: sourceInvoice.client_snapshot,
      company_snapshot: sourceInvoice.company_snapshot,
      issue_date: issueDate,
      reason: reasonNote ? `${reason}: ${reasonNote}` : reason,
      subtotal_ht_cents: ht,
      vat_total_cents: vat,
      total_ttc_cents: ht + vat,
      vat_breakdown: Object.values(byRate).sort((a, b) => a.rate - b.rate),
      notes: notes || null
    };

    let saved;
    if (isNew && !creditNote) {
      const number = await sb.rpc(token, "allocate_document_number", {
        p_company_id: company.id,
        p_doc_type: "credit_note"
      });
      payload.number = number;
      payload.status = "draft";
      const created = await sb.insert(token, "credit_notes", payload);
      saved = created?.[0];
    } else {
      const updated = await sb.update(token, "credit_notes", `id=eq.${creditNote.id}`, payload);
      saved = updated?.[0];
    }

    if (!saved) { setSaving(false); setErr("Erreur d'enregistrement"); return null; }

    // Réécriture des lignes
    await sb.delete(token, "document_lines", `document_type=eq.credit_note&document_id=eq.${saved.id}`);
    const linesPayload = finalLines.map((l, idx) => {
      const c = calcLine({
        quantity: l.quantity,
        unit_price_ht: l.unit_price_ht_cents / 100,
        vat_rate: l.vat_rate,
        discount_pct: l.discount_pct
      });
      return {
        company_id: company.id,
        document_type: "credit_note",
        document_id: saved.id,
        sort_order: idx,
        description: l.description,
        quantity: Number(l.quantity),
        unit: l.unit || "u",
        unit_price_ht_cents: l.unit_price_ht_cents,
        vat_rate: l.vat_rate,
        discount_pct: l.discount_pct || 0,
        line_ht_cents: c.line_ht_cents,
        line_vat_cents: c.line_vat_cents,
        line_ttc_cents: c.line_ttc_cents
      };
    });
    if (linesPayload.length > 0) {
      await sb.insert(token, "document_lines", linesPayload);
    }

    if (thenStatus) {
      const updated = await sb.update(token, "credit_notes", `id=eq.${saved.id}`, { status: thenStatus });
      if (!updated || !updated[0]) {
        setSaving(false);
        setErr("Erreur lors de l'émission (vérifiez la migration v8.13.11 et v8.14)");
        return null;
      }
      saved = updated[0];
    }

    setSaving(false);
    setCreditNote(saved);
    if (isNew && !thenStatus) {
      navigate(`/credit-notes/${saved.id}`, { replace: true });
    }
    return saved;
  }

  async function issue() {
    const saved = await save({ thenStatus: "issued" });
    if (!saved) return;
    setConfirmIssue(false);
    showToast("Avoir émis et verrouillé ✓");
    // Retour à la liste après un court délai pour laisser voir le toast
    setTimeout(() => navigate("/credit-notes"), 800);
  }

  async function deleteDraft() {
    if (!creditNote) return;
    if (!confirm(`Supprimer définitivement l'avoir ${creditNote.number || "en brouillon"} ?`)) return;
    setSaving(true);
    await sb.delete(token, "document_lines", `document_type=eq.credit_note&document_id=eq.${creditNote.id}`);
    const ok = await sb.delete(token, "credit_notes", `id=eq.${creditNote.id}`);
    setSaving(false);
    if (ok) navigate("/credit-notes");
  }

  // ─── Actions post-émission ─────────────────────────────────
  async function generatePdf() {
    if (!creditNote) return;
    setSaving(true);
    try {
      const r = await fetch("/api/generate-facturx", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ document_type: "credit_note", document_id: creditNote.id })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Échec génération PDF");
      // Recharge l'avoir pour récupérer les URLs
      const updated = await sb.selectOne(token, "credit_notes", `id=eq.${creditNote.id}`);
      if (updated) setCreditNote(updated);
      showToast("PDF généré ✓");
    } catch (e) {
      showToast(e.message || "Erreur génération PDF", "error");
    }
    setSaving(false);
  }

  async function sendByEmail() {
    if (!creditNote) return;
    const to = (sourceInvoice?.client_snapshot?.email || "").trim();
    if (!to) {
      showToast("Aucun email client connu sur cette facture", "error");
      return;
    }
    setSaving(true);
    try {
      const r = await fetch("/api/send-document", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          document_type: "credit_note",
          document_id: creditNote.id,
          to_email: to
        })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Envoi échoué");
      await sb.update(token, "credit_notes", `id=eq.${creditNote.id}`, { sent_at: new Date().toISOString() });
      const updated = await sb.selectOne(token, "credit_notes", `id=eq.${creditNote.id}`);
      if (updated) setCreditNote(updated);
      showToast(`Avoir envoyé à ${to} ✓`);
    } catch (e) {
      showToast(e.message || "Erreur envoi", "error");
    }
    setSaving(false);
  }

  async function transmitPdp() {
    if (!creditNote) return;
    if (!confirm("Transmettre cet avoir à l'administration via la PDP configurée ?")) return;
    setSaving(true);
    try {
      const r = await fetch("/api/generate-facturx", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ document_type: "credit_note", document_id: creditNote.id, transmit_pdp: true })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Transmission échouée");
      const updated = await sb.selectOne(token, "credit_notes", `id=eq.${creditNote.id}`);
      if (updated) setCreditNote(updated);
      showToast("Avoir transmis ✓");
    } catch (e) {
      showToast(e.message || "Erreur transmission", "error");
    }
    setSaving(false);
  }

  function downloadPdf() {
    if (creditNote?.pdf_url) window.open(creditNote.pdf_url, "_blank");
  }

  // ─── Rendu ─────────────────────────────────────────────────
  if (loading) {
    return <div className="page"><div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Chargement...</div></div>;
  }

  if (err && !sourceInvoice) {
    return (
      <div className="page">
        <div className="card card-pad" style={{ textAlign: "center", padding: 50 }}>
          <div style={{ fontSize: 40, marginBottom: 14 }}>⚠️</div>
          <div style={{ marginBottom: 18 }}>{err}</div>
          <Link to="/credit-notes" className="btn btn-primary">Retour aux avoirs</Link>
        </div>
      </div>
    );
  }
  if (err && sourceInvoice && isNew) {
    // Facture déjà entièrement créditée
    return (
      <div className="page">
        <div className="card card-pad" style={{ textAlign: "center", padding: 50 }}>
          <div style={{ fontSize: 40, marginBottom: 14 }}>↩️</div>
          <div style={{ marginBottom: 18 }}>{err}</div>
          <Link to="/credit-notes" className="btn btn-primary">Retour aux avoirs</Link>
        </div>
      </div>
    );
  }

  const badge = creditNoteStatusBadge(creditNote?.status || "draft");
  const displayTotals = isReadonly && creditNote ? {
    subtotal_ht_cents: creditNote.subtotal_ht_cents,
    vat_total_cents: creditNote.vat_total_cents,
    total_ttc_cents: creditNote.total_ttc_cents,
    vat_breakdown: creditNote.vat_breakdown || []
  } : totals;

  return (
    <div className="page">
      <div style={{ marginBottom: 14 }}>
        <Link to="/credit-notes" style={{ fontSize: 12, color: "var(--gold)", textDecoration: "none" }}>
          ← Retour aux avoirs
        </Link>
      </div>

      <div className="page-header">
        <div>
          <div className="page-title">{isNew ? "NOUVEL AVOIR" : (creditNote?.number || "AVOIR")}</div>
          <div className="page-sub" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span className={"badge " + badge.cls}>{badge.label}</span>
            {sourceInvoice && (
              <span style={{ fontSize: 11 }}>
                Émis sur facture{" "}
                <button
                  type="button"
                  onClick={() => setPreviewDoc(sourceInvoice)}
                  style={{
                    background: "none", border: "none", padding: 0, cursor: "pointer",
                    color: "var(--gold)", textDecoration: "underline", fontSize: 11
                  }}
                  title="Aperçu de la facture source"
                >
                  {sourceInvoice.number}
                </button>
              </span>
            )}
            {creditNote?.content_hash && (
              <span className="mono" style={{ fontSize: 9, color: "var(--muted)" }}>
                hash: {creditNote.content_hash.slice(0, 16)}…
              </span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {/* Actions brouillon */}
          {!isReadonly && (
            <>
              <button className="btn btn-ghost" onClick={() => save()} disabled={saving}>
                {saving ? "..." : "Enregistrer brouillon"}
              </button>
              {creditNote?.status === "draft" && (
                <button className="btn btn-danger" onClick={deleteDraft} disabled={saving}>
                  <Icon name="trash" size={13} /> Supprimer
                </button>
              )}
              <button
                className="btn btn-primary"
                onClick={() => setConfirmIssue(true)}
                disabled={saving || (isNew && (!totals || totals.total_ttc_cents <= 0)) || overLimit}
              >
                <Icon name="check" size={13} /> Émettre l'avoir
              </button>
            </>
          )}
          {/* Actions post-émission */}
          {isReadonly && (
            <>
              <button className="btn btn-ghost" onClick={() => setPreviewDoc(creditNote)} disabled={saving}>
                📄 Aperçu PDF
              </button>
              {creditNote.pdf_url ? (
                <button className="btn btn-ghost" onClick={downloadPdf} disabled={saving}>
                  ↓ Télécharger
                </button>
              ) : (
                <button className="btn btn-ghost" onClick={generatePdf} disabled={saving}>
                  {saving ? "..." : "🛠 Générer PDF"}
                </button>
              )}
              <button className="btn btn-ghost" onClick={sendByEmail} disabled={saving}>
                {saving ? "..." : "📧 Envoyer au client"}
              </button>
              {!creditNote.pdp_transmitted_at && (
                <button className="btn btn-ghost" onClick={transmitPdp} disabled={saving}
                  style={{ color: "var(--green)", borderColor: "rgba(62,207,122,0.4)" }}>
                  🏛️ Transmettre
                </button>
              )}
              {creditNote.pdp_transmitted_at && (
                <span style={{ padding: "5px 10px", fontSize: 11, color: "var(--green)",
                  border: "1px solid rgba(62,207,122,0.3)", borderRadius: 6 }}>
                  ✓ Transmise
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {err && <div className="auth-error" style={{ marginBottom: 14 }}>{err}</div>}

      {isReadonly && (
        <div className="tipline" style={{ marginBottom: 16 }}>
          <Icon name="check" size={14} />
          Cet avoir est <strong>verrouillé</strong>. Les avoirs émis sont immuables (chaîne de hashs).
        </div>
      )}

      {/* Bandeau limite de remboursement */}
      {isNew && sourceInvoice && (
        <div className="card card-pad" style={{ marginBottom: 16, fontSize: 12, color: "var(--muted2)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
            <span>Total facture TTC : <strong style={{ color: "var(--text)" }}>{fmtEUR(sourceInvoice.total_ttc_cents)}</strong></span>
            {alreadyCreditedCents > 0 && (
              <span>Déjà crédité : <strong style={{ color: "var(--orange)" }}>{fmtEUR(alreadyCreditedCents)}</strong></span>
            )}
            <span>Maximum remboursable ici : <strong style={{ color: "var(--gold)" }}>{fmtEUR(maxRefundCents)}</strong></span>
          </div>
        </div>
      )}

      {/* IDENTITÉ */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 14 }}>
          <div className="form-row">
            <label className="form-label">Client</label>
            <div className="form-input" style={{ background: "var(--card2)", color: "var(--text)" }}>
              {snapshotDisplayName(sourceInvoice?.client_snapshot || creditNote?.client_snapshot)}
            </div>
          </div>
          <div className="form-row">
            <label className="form-label">Date d'émission</label>
            <input
              type="date"
              className="form-input"
              value={issueDate}
              onChange={(e) => setIssueDate(e.target.value)}
              disabled={isReadonly}
            />
          </div>
          <div className="form-row">
            <label className="form-label">Motif</label>
            <select
              className="form-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={isReadonly}
            >
              {CREDIT_NOTE_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
          </div>
        </div>
        <div className="form-row" style={{ marginTop: 8 }}>
          <label className="form-label">Précision motif (optionnel)</label>
          <input
            className="form-input"
            value={reasonNote}
            onChange={(e) => setReasonNote(e.target.value)}
            disabled={isReadonly}
            placeholder="Ex : défaut produit constaté à réception"
          />
        </div>
      </div>

      {/* LIGNES — version création (picker) vs édition/lecture (storedLines) */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 10 }}>
          <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase" }}>
            Lignes à créditer
          </div>
          {isNew && pickerLines.length > 0 && (
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-ghost btn-sm" onClick={checkAll}>Tout cocher</button>
              <button className="btn btn-ghost btn-sm" onClick={uncheckAll}>Tout décocher</button>
            </div>
          )}
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 12 }}>
          {isNew
            ? "Cochez les lignes à créditer puis ajustez le montant HT si vous souhaitez ne rembourser qu'une partie. La colonne « reste » indique ce qui restera dû au client sur cette ligne après l'avoir."
            : "Les montants sont enregistrés en positif (la comptabilité interprète automatiquement le signe négatif)."}
        </div>

        {isNew ? (
          <PickerTable lines={pickerLines} onToggle={toggleLine} onUpdateAmount={updateAmount} />
        ) : (
          <StoredLinesTable lines={storedLines} />
        )}

        {displayTotals && <TotalsBlock totals={displayTotals} />}

        {overLimit && (
          <div style={{ marginTop: 10, padding: 10, background: "rgba(229,92,92,0.1)", border: "1px solid rgba(229,92,92,0.4)", borderRadius: 6, fontSize: 12, color: "var(--red)" }}>
            ⚠ Le total de l'avoir ({fmtEUR(totals.total_ttc_cents)}) dépasse le maximum remboursable ({fmtEUR(maxRefundCents)}).
            Réduisez les quantités ou décochez des lignes.
          </div>
        )}
      </div>

      {/* NOTES */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 10 }}>
          Notes
        </div>
        <textarea
          className="form-input"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={isReadonly}
          rows={3}
          style={{ fontFamily: "DM Sans, sans-serif", resize: "vertical" }}
        />
      </div>

      {confirmIssue && (
        <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setConfirmIssue(false)}>
          <div className="modal" style={{ maxWidth: 460 }}>
            <div className="modal-hd">
              <div className="modal-title">Émettre l'avoir</div>
              <button className="close-btn" onClick={() => setConfirmIssue(false)}><Icon name="x" size={14} /></button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: 13, color: "var(--muted2)", marginBottom: 12, lineHeight: 1.6 }}>
                Une fois émis, l'avoir sera <strong style={{ color: "var(--text)" }}>verrouillé définitivement</strong>.
                Il sera intégré à la chaîne de hashs anti-fraude au même titre qu'une facture.
              </div>
              {totals && (
                <div style={{ padding: 10, background: "var(--card2)", borderRadius: 6, fontSize: 12, marginBottom: 12 }}>
                  Montant TTC à créditer : <strong style={{ color: "var(--gold)", fontSize: 16 }}>{fmtEUR(totals.total_ttc_cents)}</strong>
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="btn btn-ghost" onClick={() => setConfirmIssue(false)}>Annuler</button>
                <button className="btn btn-primary" onClick={issue} disabled={saving}>
                  {saving ? "Émission..." : "Émettre définitivement"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {previewDoc && (
        <DocumentPreviewModal
          token={token}
          docType={previewDoc === sourceInvoice ? "invoice" : "credit_note"}
          doc={previewDoc}
          onClose={() => setPreviewDoc(null)}
        />
      )}

      {toast && (
        <div style={{
          position: "fixed", bottom: 24, right: 24,
          background: toast.type === "error" ? "rgba(229,92,92,0.95)" : "rgba(62,207,122,0.95)",
          color: "#0b0c10", padding: "12px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600,
          zIndex: 9999
        }}>
          {toast.message}
        </div>
      )}
    </div>
  );
}

// ─── Tableau picker (mode création) ─────────────────────────
function PickerTable({ lines, onToggle, onUpdateAmount }) {
  if (lines.length === 0) {
    return <div style={{ padding: 30, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>Aucune ligne sur la facture source.</div>;
  }
  return (
    <table style={{ width: "100%" }}>
      <thead>
        <tr>
          <th style={{ width: 30 }}></th>
          <th>Désignation</th>
          <th style={{ width: 130, textAlign: "right" }}>Facturé HT</th>
          <th style={{ width: 130, textAlign: "right" }}>À créditer HT</th>
          <th style={{ width: 130, textAlign: "right" }}>Reste sur ligne</th>
          <th style={{ width: 60, textAlign: "right" }}>TVA</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l, idx) => {
          // Montant HT facturé pour cette ligne (en cents)
          const lineFullCalc = calcLine({
            quantity: l.source_qty,
            unit_price_ht: l.unit_price_ht,
            vat_rate: l.vat_rate,
            discount_pct: l.discount_pct
          });
          const fullHtCents = lineFullCalc.line_ht_cents;
          // Montant HT à créditer (en cents), basé sur l.amount_ht (euros)
          const creditedHtCents = l.checked
            ? Math.min(Math.round((Number(l.amount_ht) || 0) * 100), fullHtCents)
            : 0;
          const remainingCents = fullHtCents - creditedHtCents;
          return (
            <tr key={idx} style={{ opacity: l.checked ? 1 : 0.5 }}>
              <td>
                <input
                  type="checkbox"
                  checked={l.checked}
                  onChange={() => onToggle(idx)}
                  style={{ accentColor: "var(--gold)" }}
                />
              </td>
              <td style={{ fontSize: 13 }}>
                {l.description}
                <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
                  {l.source_qty} {l.unit} × {fmtEUR(l.unit_price_ht * 100)}
                  {l.discount_pct > 0 ? ` (remise ${l.discount_pct}%)` : ""}
                </div>
              </td>
              <td className="mono" style={{ textAlign: "right", fontSize: 12, color: "var(--muted2)" }}>
                {fmtEUR(fullHtCents)}
              </td>
              <td style={{ textAlign: "right" }}>
                <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 4 }}>
                  <input
                    type="number"
                    className="form-input"
                    min="0"
                    max={fullHtCents / 100}
                    step="0.01"
                    value={l.amount_ht}
                    disabled={!l.checked}
                    onChange={(e) => onUpdateAmount(idx, e.target.value)}
                    style={{ width: 110, textAlign: "right", padding: "4px 8px", fontSize: 12 }}
                  />
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>€</span>
                </div>
              </td>
              <td className="mono" style={{ textAlign: "right", fontSize: 12, color: remainingCents > 0 ? "var(--gold)" : "var(--muted)" }}>
                {fmtEUR(remainingCents)}
              </td>
              <td className="mono" style={{ textAlign: "right", fontSize: 12 }}>{l.vat_rate}%</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── Tableau lignes stockées (mode édition/lecture) ─────────
function StoredLinesTable({ lines }) {
  if (lines.length === 0) return null;
  return (
    <table style={{ width: "100%" }}>
      <thead>
        <tr>
          <th>Désignation</th>
          <th style={{ width: 80, textAlign: "right" }}>Qté</th>
          <th style={{ width: 100, textAlign: "right" }}>P.U. HT</th>
          <th style={{ width: 60, textAlign: "right" }}>TVA</th>
          <th style={{ width: 110, textAlign: "right" }}>Total HT</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.id}>
            <td style={{ fontSize: 13 }}>{l.description}</td>
            <td className="mono" style={{ textAlign: "right", fontSize: 12 }}>{l.quantity} {l.unit}</td>
            <td className="mono" style={{ textAlign: "right", fontSize: 12 }}>{fmtEUR(l.unit_price_ht_cents)}</td>
            <td className="mono" style={{ textAlign: "right", fontSize: 12 }}>{l.vat_rate}%</td>
            <td className="mono" style={{ textAlign: "right", fontSize: 12 }}>− {fmtEUR(l.line_ht_cents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ─── Helpers ────────────────────────────────────────────────
function toPickerLine(l) {
  const fullHt = calcLine({
    quantity: Number(l.quantity),
    unit_price_ht: Number(l.unit_price_ht_cents) / 100,
    vat_rate: Number(l.vat_rate),
    discount_pct: Number(l.discount_pct) || 0
  }).line_ht_cents;
  return {
    source_id: l.id,
    description: l.description,
    unit: l.unit || "u",
    vat_rate: Number(l.vat_rate),
    unit_price_ht: Number(l.unit_price_ht_cents) / 100,
    discount_pct: Number(l.discount_pct) || 0,
    source_qty: Number(l.quantity),
    // amount_ht : montant HT à créditer pour cette ligne (en euros, pour l'input)
    // Initialement, on prérenseigne au montant total facturé (= avoir total)
    amount_ht: (fullHt / 100).toFixed(2),
    checked: true                // par défaut, cochée
  };
}

function parseReasonCode(reasonStr) {
  if (!reasonStr) return "error";
  const code = reasonStr.split(":")[0].trim();
  const validCodes = CREDIT_NOTE_REASONS.map((r) => r.code);
  return validCodes.includes(code) ? code : "other";
}

function parseReasonNote(reasonStr) {
  if (!reasonStr) return "";
  const idx = reasonStr.indexOf(":");
  return idx >= 0 ? reasonStr.slice(idx + 1).trim() : "";
}
