import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { ClientPicker } from "../../components/ClientPicker.jsx";
import { LineEditor, TotalsBlock, calcDocumentTotals, calcLine, newEmptyLine } from "../../components/LineEditor.jsx";
import { fmtEUR, fmtDate, todayISO, toCents } from "../../lib/helpers.js";
import { buildClientSnapshot, buildCompanySnapshot, snapshotDisplayName } from "../../lib/snapshots.js";
import { invoiceStatusBadge, isInvoiceLocked, isInvoiceOverdue, paymentMethodLabel } from "./invoiceHelpers.js";
import { capture, bumpModuleUsage } from "../../lib/telemetry.js";
import { CURRENCIES, VAT_CATEGORIES, suggestVatCategory } from "../../lib/currency.js";

// Helper : appelle l'API public-share et copie le lien
async function sharePublicLink(token, scope, resourceId) {
  try {
    const r = await fetch("/api/public-share", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ scope, resource_id: resourceId, expires_in_days: 90 })
    });
    if (!r.ok) { alert("Erreur lors de la génération du lien"); return; }
    const j = await r.json();
    if (j.public_url) {
      try { await navigator.clipboard.writeText(j.public_url); } catch {}
      alert("Lien copié dans le presse-papiers :\n\n" + j.public_url);
    }
  } catch (e) {
    alert("Erreur réseau");
  }
}

export function InvoiceEditorPage({ token, company }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === "new";

  // état document
  const [invoice, setInvoice] = useState(null);
  const [clientId, setClientId] = useState(null);
  const [client, setClient] = useState(null);
  const [issueDate, setIssueDate] = useState(todayISO());
  const [dueDate, setDueDate] = useState("");
  const [paymentTermsDays, setPaymentTermsDays] = useState(30);
  const [notes, setNotes] = useState("");
  const [terms, setTerms] = useState("");
  const [currency, setCurrency] = useState("EUR");
  const [vatCategory, setVatCategory] = useState("standard");
  const [lines, setLines] = useState([newEmptyLine({ vat_rate: company.vat_default_rate || 20 })]);
  const [payments, setPayments] = useState([]);

  // ui
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [confirmIssue, setConfirmIssue] = useState(false);
  const [paymentModal, setPaymentModal] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const vatExempt = company.vat_regime === "franchise";
  const locked = invoice && isInvoiceLocked(invoice.status);
  const isReadonly = locked || (invoice && invoice.status === "canceled");

  // chargement (édition)
  useEffect(() => {
    if (isNew) return;
    let alive = true;
    (async () => {
      const [inv, ls, pays] = await Promise.all([
        sb.selectOne(token, "invoices", `id=eq.${id}`),
        sb.select(token, "document_lines", {
          filter: `document_type=eq.invoice&document_id=eq.${id}`,
          order: "sort_order.asc"
        }),
        sb.select(token, "payments", {
          filter: `invoice_id=eq.${id}`,
          order: "paid_at.desc"
        })
      ]);
      if (!alive) return;
      if (!inv) { setErr("Facture introuvable"); setLoading(false); return; }
      setInvoice(inv);
      setClientId(inv.client_id);
      setIssueDate(inv.issue_date);
      setDueDate(inv.due_date || "");
      setPaymentTermsDays(inv.payment_terms_days || 30);
      setNotes(inv.notes || "");
      setTerms(inv.terms || "");
      setCurrency(inv.currency || "EUR");
      setVatCategory(inv.vat_category || "standard");
      const localLines = (ls || []).map((l) => ({
        id: l.id,
        description: l.description,
        quantity: Number(l.quantity),
        unit: l.unit,
        unit_price_ht: Number(l.unit_price_ht_cents) / 100,
        vat_rate: Number(l.vat_rate),
        discount_pct: Number(l.discount_pct) || 0
      }));
      setLines(localLines.length ? localLines : [newEmptyLine({ vat_rate: company.vat_default_rate || 20 })]);
      setPayments(pays || []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [id, isNew, token, company.vat_default_rate]);

  useEffect(() => {
    if (!clientId) { setClient(null); return; }
    sb.selectOne(token, "clients", `id=eq.${clientId}`).then((c) => {
      setClient(c);
      // Auto délai paiement si facture vide
      if (c?.payment_terms_days && !invoice && isNew) {
        setPaymentTermsDays(c.payment_terms_days);
      }
      // Auto-suggest categorie TVA tant que la facture est en draft
      if (c && (!invoice || invoice.status === "draft")) {
        const suggested = suggestVatCategory(c, company);
        setVatCategory(suggested);
      }
    });
  }, [clientId, token, invoice, isNew, company]);

  // Calcul automatique de l'échéance à partir de la date d'émission
  useEffect(() => {
    if (locked) return;
    if (issueDate && paymentTermsDays) {
      const d = new Date(issueDate);
      d.setDate(d.getDate() + Number(paymentTermsDays));
      setDueDate(d.toISOString().slice(0, 10));
    }
  }, [issueDate, paymentTermsDays, locked]);

  const totals = useMemo(() => calcDocumentTotals(lines), [lines]);
  const totalPaid = useMemo(() => payments.reduce((s, p) => s + (p.amount_cents || 0), 0), [payments]);
  const remaining = (invoice?.total_ttc_cents || totals.total_ttc_cents) - totalPaid;

  // ─── Sauvegarde brouillon ──────────────────────────────
  async function save() {
    setErr("");
    if (!clientId) { setErr("Sélectionnez un client"); return null; }
    if (lines.length === 0 || lines.every((l) => !l.description?.trim())) {
      setErr("Ajoutez au moins une ligne décrite");
      return null;
    }
    if (!client) { setErr("Client introuvable"); return null; }

    setSaving(true);
    const t = calcDocumentTotals(lines);
    const cat = VAT_CATEGORIES[vatCategory] || VAT_CATEGORIES.standard;

    const payload = {
      company_id: company.id,
      client_id: clientId,
      client_snapshot: buildClientSnapshot(client),
      company_snapshot: buildCompanySnapshot(company),
      issue_date: issueDate,
      due_date: dueDate || null,
      payment_terms_days: Number(paymentTermsDays),
      subtotal_ht_cents: t.subtotal_ht_cents,
      vat_total_cents: t.vat_total_cents,
      total_ttc_cents: t.total_ttc_cents,
      vat_breakdown: t.vat_breakdown,
      currency,
      vat_category: vatCategory,
      vat_legal_mention: cat.legal_mention || null,
      notes: notes || null,
      terms: terms || null
    };

    let saved;
    if (isNew && !invoice) {
      payload.status = "draft";
      // Pas d'allocation de numéro tant que brouillon : numéro alloué à l'émission.
      // (Attention : la table NOT NULL number → on alloue dès la création pour respecter la contrainte.)
      const number = await sb.rpc(token, "allocate_document_number", {
        p_company_id: company.id,
        p_doc_type: "invoice"
      });
      payload.number = number;
      const created = await sb.insert(token, "invoices", payload);
      saved = created?.[0];
    } else {
      const updated = await sb.update(token, "invoices", `id=eq.${invoice.id}`, payload);
      saved = updated?.[0];
    }

    if (!saved) { setSaving(false); setErr("Erreur d'enregistrement"); return null; }

    await sb.delete(token, "document_lines", `document_type=eq.invoice&document_id=eq.${saved.id}`);
    const linesPayload = lines
      .filter((l) => l.description?.trim())
      .map((l, idx) => {
        const c = calcLine(l);
        return {
          company_id: company.id,
          document_type: "invoice",
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

    setSaving(false);
    setInvoice(saved);
    if (isNew) navigate(`/invoices/${saved.id}`, { replace: true });
    return saved;
  }

  // ─── Émission (passage à "issued" => verrouillage + hash chain) ─
  async function issueInvoice() {
    setSaving(true);
    setErr("");
    // 1) Sauvegarder d'abord le brouillon pour s'assurer que tout est synchro
    const saved = await save();
    if (!saved) { setSaving(false); return; }

    // 2) Passer status à "issued" → le trigger Postgres calcule le hash
    const updated = await sb.update(token, "invoices", `id=eq.${saved.id}`, { status: "issued" });
    setSaving(false);
    setConfirmIssue(false);
    if (!updated || !updated[0]) { setErr("Erreur lors de l'émission"); return; }
    setInvoice(updated[0]);

    // ─── Telemetrie produit ──
    capture("invoice_issued", {
      invoice_id: saved.id,
      number: saved.number,
      total_ttc: saved.total_ttc_cents / 100,
      currency: saved.currency || "EUR",
      vat_category: saved.vat_category || "standard"
    });
    bumpModuleUsage(token, company.id, "invoicing");

    // 3) Générer le PDF Factur-X (PDF/A-3 + XML CII embarqué) en arrière-plan
    fetch("/api/generate-facturx", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ invoice_id: saved.id })
    }).then(async (r) => {
      if (r.ok) {
        const j = await r.json();
        // Recharger la facture pour afficher le PDF URL
        const refreshed = await sb.selectOne(token, "invoices", `id=eq.${saved.id}`);
        if (refreshed) setInvoice(refreshed);
      }
    }).catch(() => { /* silencieux : le PDF peut être regénéré plus tard */ });

    // 4) Générer un Stripe Payment Link en arrière-plan (si module abonnement actif)
    if (company.stripe_customer_id) {
      fetch("/api/stripe-payment-link", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ invoice_id: saved.id })
      }).then(async (r) => {
        if (r.ok) {
          const refreshed = await sb.selectOne(token, "invoices", `id=eq.${saved.id}`);
          if (refreshed) setInvoice(refreshed);
        }
      }).catch(() => {});
    }
  }

  // ─── Annulation (uniquement avant émission) ────────────
  async function cancelInvoice() {
    if (!invoice) return;
    if (invoice.status !== "draft") {
      setErr("Une facture émise doit être annulée par un avoir.");
      return;
    }
    setSaving(true);
    const ok = await sb.delete(token, "invoices", `id=eq.${invoice.id}`);
    setSaving(false);
    if (ok) navigate("/invoices");
  }

  // ─── Enregistrement d'un paiement ──────────────────────
  async function recordPayment(payment) {
    if (!invoice) return;
    setSaving(true);
    const inserted = await sb.insert(token, "payments", {
      company_id: company.id,
      invoice_id: invoice.id,
      amount_cents: toCents(payment.amount),
      method: payment.method,
      reference: payment.reference || null,
      paid_at: payment.paid_at,
      match_method: "manual"
    });
    if (inserted?.[0]) {
      const newPayments = [inserted[0], ...payments];
      setPayments(newPayments);

      // Recalcul status sur facture
      const newPaid = newPayments.reduce((s, p) => s + (p.amount_cents || 0), 0);
      let newStatus = invoice.status;
      if (newPaid >= invoice.total_ttc_cents) newStatus = "paid";
      else if (newPaid > 0) newStatus = "partial";

      const updated = await sb.update(token, "invoices", `id=eq.${invoice.id}`, {
        paid_cents: newPaid,
        status: newStatus
      });
      if (updated?.[0]) setInvoice(updated[0]);
    }
    setSaving(false);
    setPaymentModal(false);
  }

  async function deletePayment(p) {
    setSaving(true);
    await sb.delete(token, "payments", `id=eq.${p.id}`);
    const newPayments = payments.filter((x) => x.id !== p.id);
    setPayments(newPayments);
    const newPaid = newPayments.reduce((s, x) => s + (x.amount_cents || 0), 0);
    let newStatus = invoice.status;
    if (newPaid === 0 && ["partial", "paid"].includes(invoice.status)) newStatus = "issued";
    else if (newPaid < invoice.total_ttc_cents && invoice.status === "paid") newStatus = "partial";
    const updated = await sb.update(token, "invoices", `id=eq.${invoice.id}`, {
      paid_cents: newPaid,
      status: newStatus
    });
    if (updated?.[0]) setInvoice(updated[0]);
    setSaving(false);
  }

  if (loading) {
    return <div className="page"><div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Chargement...</div></div>;
  }

  const effectiveStatus = invoice && isInvoiceOverdue(invoice) ? "overdue" : invoice?.status || "draft";
  const badge = invoiceStatusBadge(effectiveStatus);

  return (
    <div className="page">
      <div style={{ marginBottom: 14 }}>
        <Link to="/invoices" style={{ fontSize: 12, color: "var(--gold)", textDecoration: "none" }}>
          ← Retour aux factures
        </Link>
      </div>

      <div className="page-header">
        <div>
          <div className="page-title">{isNew ? "NOUVELLE FACTURE" : (invoice?.number || "FACTURE")}</div>
          <div className="page-sub" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span className={"badge " + badge.cls}>{badge.label}</span>
            {invoice?.issued_at && <span style={{ fontSize: 11 }}>Émise le {fmtDate(invoice.issued_at)}</span>}
            {invoice?.quote_id && (
              <Link to={`/quotes/${invoice.quote_id}`} style={{ color: "var(--muted2)", fontSize: 11 }}>
                ← Issue d'un devis
              </Link>
            )}
            {invoice?.content_hash && (
              <span className="mono" style={{ fontSize: 9, color: "var(--muted)", letterSpacing: 0.5 }}>
                hash: {invoice.content_hash.slice(0, 16)}…
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
              {invoice?.status === "draft" && (
                <button className="btn btn-danger" onClick={() => setConfirmCancel(true)} disabled={saving}>
                  <Icon name="trash" size={13} /> Supprimer
                </button>
              )}
              <button className="btn btn-primary" onClick={() => setConfirmIssue(true)} disabled={saving}>
                <Icon name="check" size={13} /> Émettre la facture
              </button>
            </>
          )}
          {locked && remaining > 0 && (
            <button className="btn btn-primary" onClick={() => setPaymentModal(true)}>
              <Icon name="euro" size={13} /> Saisir un paiement
            </button>
          )}
          {locked && (
            <button
              className="btn btn-ghost"
              onClick={async () => {
                const r = await fetch("/api/send-document", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                  body: JSON.stringify({ document_type: "invoice", document_id: invoice.id })
                });
                if (r.ok) alert("Facture envoyée par email.");
                else alert("Envoi impossible. Vérifiez la configuration Resend.");
              }}
            >
              <Icon name="send" size={13} /> Envoyer par email
            </button>
          )}
          {invoice?.facturx_pdf_url && (
            <a className="btn btn-ghost" href={invoice.facturx_pdf_url} target="_blank" rel="noopener noreferrer">
              <Icon name="download" size={13} /> Télécharger PDF
            </a>
          )}
          {locked && (
            <button className="btn btn-ghost" onClick={() => sharePublicLink(token, "invoice", invoice.id)}>
              🔗 Partager
            </button>
          )}
          {locked && (
            <Link className="btn btn-ghost" to={`/credit-notes/new?from_invoice=${invoice.id}`}>
              <Icon name="quote" size={13} /> Créer un avoir
            </Link>
          )}
        </div>
      </div>

      {err && <div className="auth-error" style={{ marginBottom: 14 }}>{err}</div>}

      {locked && (
        <div className="tipline" style={{ marginBottom: 16 }}>
          <Icon name="check" size={14} />
          Cette facture est <strong>verrouillée</strong>. Les modifications doivent passer par un avoir (CGI art. 286-I-3, hash chain anti-fraude).
        </div>
      )}

      {/* IDENTITÉ */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 14 }}>
          <ClientPicker
            token={token}
            company={company}
            value={clientId}
            onChange={(id) => !isReadonly && setClientId(id)}
          />
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
            <label className="form-label">Délai (jours)</label>
            <input
              type="number"
              className="form-input mono"
              value={paymentTermsDays}
              onChange={(e) => setPaymentTermsDays(Number(e.target.value))}
              disabled={isReadonly}
            />
          </div>
          <div className="form-row">
            <label className="form-label">Échéance</label>
            <input
              type="date"
              className="form-input"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              disabled={isReadonly}
            />
          </div>
        </div>

        {/* Multi-devises + categorie TVA */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, marginTop: 8 }}>
          <div className="form-row">
            <label className="form-label">Devise</label>
            <select
              className="form-input"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              disabled={isReadonly}
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
              ))}
            </select>
          </div>
          <div className="form-row">
            <label className="form-label">Régime TVA</label>
            <select
              className="form-input"
              value={vatCategory}
              onChange={(e) => setVatCategory(e.target.value)}
              disabled={isReadonly}
            >
              {Object.entries(VAT_CATEGORIES).map(([key, info]) => (
                <option key={key} value={key}>{info.label}</option>
              ))}
            </select>
            {VAT_CATEGORIES[vatCategory]?.legal_mention && (
              <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4, fontStyle: "italic" }}>
                Mention : {VAT_CATEGORIES[vatCategory].legal_mention}
              </div>
            )}
          </div>
        </div>

        {(client || invoice?.client_snapshot) && (
          <div style={{ background: "var(--card2)", padding: "10px 14px", borderRadius: 7, fontSize: 12, color: "var(--muted2)", marginTop: 4 }}>
            <strong style={{ color: "var(--text)" }}>
              {locked ? snapshotDisplayName(invoice.client_snapshot) : (client && snapshotDisplayName(buildClientSnapshot(client)))}
            </strong>
            {!locked && client?.email && <> · {client.email}</>}
            {locked && invoice.client_snapshot?.email && <> · {invoice.client_snapshot.email}</>}
            {vatExempt && <span style={{ marginLeft: 8, color: "var(--orange)" }}>· Franchise TVA active</span>}
          </div>
        )}
      </div>

      {/* LIGNES */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 12 }}>
          Détail
        </div>
        <LineEditor
          lines={lines}
          onChange={setLines}
          defaultVatRate={company.vat_default_rate || 20}
          readonly={isReadonly}
          vatExempt={vatExempt}
        />
        <TotalsBlock totals={locked ? {
          subtotal_ht_cents: invoice.subtotal_ht_cents,
          vat_total_cents: invoice.vat_total_cents,
          total_ttc_cents: invoice.total_ttc_cents,
          vat_breakdown: invoice.vat_breakdown || []
        } : totals} />
        {vatExempt && (
          <div className="tipline" style={{ marginTop: 14 }}>
            <Icon name="alert" size={14} />
            TVA non applicable, art. 293 B du CGI (franchise en base).
          </div>
        )}
      </div>

      {/* PAIEMENTS (uniquement si émise) */}
      {locked && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase" }}>
              Paiements ({payments.length})
            </div>
            <div style={{ display: "flex", gap: 14, alignItems: "center", fontSize: 13 }}>
              <span style={{ color: "var(--muted)" }}>Encaissé : <span className="mono" style={{ color: "var(--green)" }}>{fmtEUR(totalPaid)}</span></span>
              <span style={{ color: "var(--muted)" }}>Restant : <span className="mono" style={{ color: remaining > 0 ? "var(--orange)" : "var(--green)" }}>{fmtEUR(remaining)}</span></span>
            </div>
          </div>
          {payments.length === 0 ? (
            <div style={{ padding: "16px 0", color: "var(--muted)", fontSize: 12 }}>Aucun paiement enregistré.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Méthode</th>
                  <th>Référence</th>
                  <th style={{ textAlign: "right" }}>Montant</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id}>
                    <td>{fmtDate(p.paid_at)}</td>
                    <td>{paymentMethodLabel(p.method)}</td>
                    <td className="mono" style={{ fontSize: 11, color: "var(--muted2)" }}>{p.reference || "—"}</td>
                    <td className="mono" style={{ textAlign: "right", color: "var(--green)" }}>{fmtEUR(p.amount_cents)}</td>
                    <td style={{ textAlign: "right" }}>
                      <button
                        onClick={() => deletePayment(p)}
                        style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", padding: 4 }}
                        title="Supprimer ce paiement"
                      >
                        <Icon name="trash" size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* NOTES & CONDITIONS */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <div className="card card-pad">
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
        <div className="card card-pad">
          <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 10 }}>
            Conditions de paiement
          </div>
          <textarea
            className="form-input"
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
            disabled={isReadonly}
            rows={3}
            style={{ fontFamily: "DM Sans, sans-serif", resize: "vertical" }}
          />
        </div>
      </div>

      {/* MODAL : confirmation émission */}
      {confirmIssue && (
        <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setConfirmIssue(false)}>
          <div className="modal" style={{ maxWidth: 500 }}>
            <div className="modal-hd">
              <div className="modal-title">Émettre la facture</div>
              <button className="close-btn" onClick={() => setConfirmIssue(false)}><Icon name="x" size={14} /></button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: 13, color: "var(--muted2)", marginBottom: 12, lineHeight: 1.6 }}>
                Une fois émise, la facture sera <strong style={{ color: "var(--text)" }}>verrouillée définitivement</strong>.
                Les éventuelles erreurs ne pourront être corrigées que par un avoir.
              </div>
              <div style={{ background: "var(--card2)", padding: 14, borderRadius: 7, fontSize: 12, color: "var(--muted2)", lineHeight: 1.6, marginBottom: 18 }}>
                ✓ Numérotation chaînée (sans rupture)<br />
                ✓ Hash SHA-256 chaîné avec la facture précédente<br />
                ✓ Snapshot client/société immuable<br />
                ✓ Conformité CGI art. 286-I-3 (anti-fraude DGFiP)
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="btn btn-ghost" onClick={() => setConfirmIssue(false)}>Annuler</button>
                <button className="btn btn-primary" onClick={issueInvoice} disabled={saving}>
                  {saving ? "Émission..." : "Émettre définitivement"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL : suppression brouillon */}
      {confirmCancel && (
        <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setConfirmCancel(false)}>
          <div className="modal" style={{ maxWidth: 440 }}>
            <div className="modal-hd">
              <div className="modal-title">Supprimer le brouillon</div>
              <button className="close-btn" onClick={() => setConfirmCancel(false)}><Icon name="x" size={14} /></button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: 13, color: "var(--muted2)", marginBottom: 18 }}>
                Cette facture brouillon sera supprimée définitivement. Le numéro alloué pourra être réutilisé.
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="btn btn-ghost" onClick={() => setConfirmCancel(false)}>Annuler</button>
                <button className="btn btn-danger" onClick={cancelInvoice} disabled={saving}>Supprimer</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL : saisie paiement */}
      {paymentModal && (
        <PaymentModal
          remaining={remaining}
          onSave={recordPayment}
          onClose={() => setPaymentModal(false)}
        />
      )}
    </div>
  );
}

function PaymentModal({ remaining, onSave, onClose }) {
  const [amount, setAmount] = useState((remaining / 100).toFixed(2));
  const [method, setMethod] = useState("bank_transfer");
  const [reference, setReference] = useState("");
  const [paidAt, setPaidAt] = useState(todayISO());
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!amount || Number(amount) <= 0) return;
    setSaving(true);
    await onSave({ amount, method, reference, paid_at: paidAt });
    setSaving(false);
  }

  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 460 }}>
        <div className="modal-hd">
          <div className="modal-title">Saisir un paiement</div>
          <button className="close-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="modal-body">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-row">
              <label className="form-label">Montant (€)</label>
              <input
                type="number"
                step="0.01"
                className="form-input mono"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                autoFocus
              />
              <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 3 }}>
                Restant : {fmtEUR(remaining)}
              </div>
            </div>
            <div className="form-row">
              <label className="form-label">Date</label>
              <input
                type="date"
                className="form-input"
                value={paidAt}
                onChange={(e) => setPaidAt(e.target.value)}
              />
            </div>
            <div className="form-row">
              <label className="form-label">Méthode</label>
              <select className="form-input" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="bank_transfer">Virement</option>
                <option value="stripe">Stripe / CB</option>
                <option value="cash">Espèces</option>
                <option value="check">Chèque</option>
                <option value="other">Autre</option>
              </select>
            </div>
            <div className="form-row">
              <label className="form-label">Référence</label>
              <input
                className="form-input"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="N° chèque, libellé virement..."
              />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
            <button className="btn btn-ghost" onClick={onClose}>Annuler</button>
            <button className="btn btn-primary" onClick={submit} disabled={saving || !amount}>
              {saving ? "..." : "Enregistrer"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
