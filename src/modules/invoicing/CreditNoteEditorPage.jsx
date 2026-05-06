import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams, Link } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { LineEditor, TotalsBlock, calcDocumentTotals, calcLine, newEmptyLine } from "../../components/LineEditor.jsx";
import { fmtEUR, fmtDate, todayISO, toCents } from "../../lib/helpers.js";
import { snapshotDisplayName } from "../../lib/snapshots.js";
import { creditNoteStatusBadge, CREDIT_NOTE_REASONS } from "./creditNoteHelpers.js";

export function CreditNoteEditorPage({ token, company }) {
  const { id } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const isNew = !id || id === "new";
  const fromInvoiceId = search.get("from_invoice");

  // état document
  const [creditNote, setCreditNote] = useState(null);
  const [sourceInvoice, setSourceInvoice] = useState(null);
  const [issueDate, setIssueDate] = useState(todayISO());
  const [reason, setReason] = useState("error");
  const [reasonNote, setReasonNote] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState([]);

  // ui
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [confirmIssue, setConfirmIssue] = useState(false);
  const [scope, setScope] = useState("partial"); // partial | total — pour la creation

  const isReadonly = creditNote && creditNote.status === "issued";

  // Chargement
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);

      if (!isNew) {
        // Edition d'un avoir existant
        const [cn, ls, inv] = await Promise.all([
          sb.selectOne(token, "credit_notes", `id=eq.${id}`),
          sb.select(token, "document_lines", {
            filter: `document_type=eq.credit_note&document_id=eq.${id}`,
            order: "sort_order.asc"
          }),
          null
        ]);
        if (!alive) return;
        if (!cn) { setErr("Avoir introuvable"); setLoading(false); return; }

        const sourceInv = cn.invoice_id ? await sb.selectOne(token, "invoices", `id=eq.${cn.invoice_id}`) : null;
        setCreditNote(cn);
        setSourceInvoice(sourceInv);
        setIssueDate(cn.issue_date);
        setReason(parseReasonCode(cn.reason));
        setReasonNote(parseReasonNote(cn.reason));
        setNotes(cn.notes || "");
        setLines((ls || []).map(toEditorLine));
        setLoading(false);
        return;
      }

      // Creation : il FAUT une facture source
      if (!fromInvoiceId) {
        setErr("Pour créer un avoir, ouvrez une facture émise puis cliquez « Créer un avoir »");
        setLoading(false);
        return;
      }
      const [inv, invLines] = await Promise.all([
        sb.selectOne(token, "invoices", `id=eq.${fromInvoiceId}`),
        sb.select(token, "document_lines", {
          filter: `document_type=eq.invoice&document_id=eq.${fromInvoiceId}`,
          order: "sort_order.asc"
        })
      ]);
      if (!alive) return;
      if (!inv) { setErr("Facture source introuvable"); setLoading(false); return; }
      if (!["issued", "sent", "partial", "paid", "overdue"].includes(inv.status)) {
        setErr("Seule une facture émise peut donner lieu à un avoir");
        setLoading(false);
        return;
      }
      setSourceInvoice(inv);
      // Par defaut on copie toutes les lignes
      setLines((invLines || []).map(toEditorLine));
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [id, isNew, fromInvoiceId, token]);

  const totals = useMemo(() => calcDocumentTotals(lines), [lines]);

  // ─── Sauvegarde brouillon ──────────────────────────────
  async function save({ thenStatus = null } = {}) {
    setErr("");
    if (!sourceInvoice) { setErr("Facture source manquante"); return null; }
    if (lines.length === 0 || lines.every((l) => !l.description?.trim())) {
      setErr("Ajoutez au moins une ligne");
      return null;
    }
    setSaving(true);
    const t = calcDocumentTotals(lines);

    const payload = {
      company_id: company.id,
      invoice_id: sourceInvoice.id,
      client_id: sourceInvoice.client_id,
      // Snapshot REPRIS de la facture (immutabilite : un avoir reflete l'etat de la facture)
      client_snapshot: sourceInvoice.client_snapshot,
      company_snapshot: sourceInvoice.company_snapshot,
      issue_date: issueDate,
      reason: reasonNote ? `${reason}: ${reasonNote}` : reason,
      subtotal_ht_cents: t.subtotal_ht_cents,
      vat_total_cents: t.vat_total_cents,
      total_ttc_cents: t.total_ttc_cents,
      vat_breakdown: t.vat_breakdown,
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

    // Reecriture des lignes (drafts uniquement)
    await sb.delete(token, "document_lines", `document_type=eq.credit_note&document_id=eq.${saved.id}`);
    const linesPayload = lines
      .filter((l) => l.description?.trim())
      .map((l, idx) => {
        const c = calcLine(l);
        return {
          company_id: company.id,
          document_type: "credit_note",
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

    if (thenStatus) {
      const updated = await sb.update(token, "credit_notes", `id=eq.${saved.id}`, { status: thenStatus });
      saved = updated?.[0] || saved;
    }

    setSaving(false);
    setCreditNote(saved);
    if (isNew) navigate(`/credit-notes/${saved.id}`, { replace: true });
    return saved;
  }

  async function issue() {
    setSaving(true);
    const saved = await save();
    if (!saved) { setSaving(false); return; }

    // Passage a "issued" → trigger Postgres calcule le hash chain de l'avoir
    const updated = await sb.update(token, "credit_notes", `id=eq.${saved.id}`, { status: "issued" });
    setSaving(false);
    setConfirmIssue(false);
    if (!updated || !updated[0]) { setErr("Erreur lors de l'émission"); return; }
    setCreditNote(updated[0]);

    // Si avoir total : passer la facture source en "canceled" ?
    // Choix produit : on NE touche pas au statut de la facture (restera "paid" ou "issued").
    // L'avoir compte comme une operation distincte en compta.
  }

  async function deleteDraft() {
    if (!creditNote) return;
    setSaving(true);
    const ok = await sb.delete(token, "credit_notes", `id=eq.${creditNote.id}`);
    setSaving(false);
    if (ok) navigate("/credit-notes");
  }

  // Apply scope = total : copie integrale
  function applyScopeTotal() {
    setScope("total");
    if (sourceInvoice) {
      sb.select(token, "document_lines", {
        filter: `document_type=eq.invoice&document_id=eq.${sourceInvoice.id}`,
        order: "sort_order.asc"
      }).then((ls) => setLines((ls || []).map(toEditorLine)));
    }
  }

  function applyScopePartial() {
    setScope("partial");
    // ne touche pas aux lignes — l'utilisateur les ajuste
  }

  if (loading) {
    return <div className="page"><div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Chargement...</div></div>;
  }

  if (err && !sourceInvoice) {
    return (
      <div className="page">
        <div className="card card-pad" style={{ textAlign: "center", padding: 50 }}>
          <div style={{ fontSize: 40, marginBottom: 14 }}>⚠️</div>
          <div style={{ marginBottom: 18 }}>{err}</div>
          <Link to="/invoices" className="btn btn-primary">Retour aux factures</Link>
        </div>
      </div>
    );
  }

  const badge = creditNoteStatusBadge(creditNote?.status || "draft");

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
                Émis sur facture <Link to={`/invoices/${sourceInvoice.id}`} style={{ color: "var(--gold)" }}>{sourceInvoice.number}</Link>
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
          {!isReadonly && (
            <>
              <button className="btn btn-ghost" onClick={save} disabled={saving}>
                {saving ? "..." : "Enregistrer brouillon"}
              </button>
              {creditNote?.status === "draft" && (
                <button className="btn btn-danger" onClick={deleteDraft} disabled={saving}>
                  <Icon name="trash" size={13} /> Supprimer
                </button>
              )}
              <button className="btn btn-primary" onClick={() => setConfirmIssue(true)} disabled={saving}>
                <Icon name="check" size={13} /> Émettre l'avoir
              </button>
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

      {/* SCOPE total/partiel — uniquement en creation */}
      {isNew && !creditNote && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, letterSpacing: 1.4, color: "var(--muted)", textTransform: "uppercase", marginBottom: 10 }}>
            Type d'avoir
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <label
              className="form-input"
              style={{
                display: "flex", alignItems: "center", gap: 10, cursor: "pointer", flex: 1,
                borderColor: scope === "total" ? "var(--gold)" : "var(--border2)"
              }}
            >
              <input
                type="radio"
                checked={scope === "total"}
                onChange={applyScopeTotal}
                style={{ accentColor: "var(--gold)" }}
              />
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>Avoir total</div>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>Copie toutes les lignes — annulation pure</div>
              </div>
            </label>
            <label
              className="form-input"
              style={{
                display: "flex", alignItems: "center", gap: 10, cursor: "pointer", flex: 1,
                borderColor: scope === "partial" ? "var(--gold)" : "var(--border2)"
              }}
            >
              <input
                type="radio"
                checked={scope === "partial"}
                onChange={applyScopePartial}
                style={{ accentColor: "var(--gold)" }}
              />
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>Avoir partiel</div>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>Ajustez les lignes selon le besoin</div>
              </div>
            </label>
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
            placeholder="Ex: défaut produit constaté à réception"
          />
        </div>
      </div>

      {/* LIGNES */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 12 }}>
          Lignes de l'avoir
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 12 }}>
          Les montants sont enregistrés en positif côté avoir (la comptabilité interprète automatiquement le signe).
        </div>
        <LineEditor
          lines={lines}
          onChange={setLines}
          defaultVatRate={company.vat_default_rate || 20}
          readonly={isReadonly}
          vatExempt={company.vat_regime === "franchise"}
        />
        <TotalsBlock
          totals={isReadonly && creditNote ? {
            subtotal_ht_cents: creditNote.subtotal_ht_cents,
            vat_total_cents: creditNote.vat_total_cents,
            total_ttc_cents: creditNote.total_ttc_cents,
            vat_breakdown: creditNote.vat_breakdown || []
          } : totals}
        />
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
    </div>
  );
}

function toEditorLine(l) {
  return {
    id: l.id,
    description: l.description,
    quantity: Number(l.quantity),
    unit: l.unit,
    unit_price_ht: Number(l.unit_price_ht_cents) / 100,
    vat_rate: Number(l.vat_rate),
    discount_pct: Number(l.discount_pct) || 0
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
