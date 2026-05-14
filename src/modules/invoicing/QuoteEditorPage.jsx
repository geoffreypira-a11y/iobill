import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { ClientPicker } from "../../components/ClientPicker.jsx";
import { LineEditor, TotalsBlock, calcDocumentTotals, calcLine, newEmptyLine } from "../../components/LineEditor.jsx";
import { fmtEUR, fmtDate, todayISO, toCents } from "../../lib/helpers.js";
import { buildClientSnapshot, buildCompanySnapshot, snapshotDisplayName } from "../../lib/snapshots.js";
import { quoteStatusBadge, isQuoteExpired } from "./quoteHelpers.js";
import { capture, bumpModuleUsage } from "../../lib/telemetry.js";
import { CURRENCIES, VAT_CATEGORIES, suggestVatCategory } from "../../lib/currency.js";

// Helper : appelle l'API public-share et copie le lien dans le presse-papiers
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

export function QuoteEditorPage({ token, company }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id || id === "new";

  // état document
  const [quote, setQuote] = useState(null);
  const [clientId, setClientId] = useState(null);
  const [client, setClient] = useState(null);
  const [issueDate, setIssueDate] = useState(todayISO());
  const [validityDays, setValidityDays] = useState(30);
  const [notes, setNotes] = useState("");
  const [terms, setTerms] = useState("");
  const [currency, setCurrency] = useState("EUR");
  const [vatCategory, setVatCategory] = useState("standard");
  const [lines, setLines] = useState([newEmptyLine({ vat_rate: company.vat_default_rate || 20 })]);
  const [versionsHistory, setVersionsHistory] = useState([]);

  // ui
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [confirmConvert, setConfirmConvert] = useState(false);

  const vatExempt = company.vat_regime === "franchise";

  // chargement (édition)
  useEffect(() => {
    if (isNew) return;
    let alive = true;
    (async () => {
      const [q, ls] = await Promise.all([
        sb.selectOne(token, "quotes", `id=eq.${id}`),
        sb.select(token, "document_lines", {
          filter: `document_type=eq.quote&document_id=eq.${id}`,
          order: "sort_order.asc"
        })
      ]);
      if (!alive) return;
      if (!q) { setErr("Devis introuvable"); setLoading(false); return; }
      setQuote(q);
      setClientId(q.client_id);
      setIssueDate(q.issue_date);
      setValidityDays(q.validity_days || 30);
      setNotes(q.notes || "");
      setTerms(q.terms || "");
      setCurrency(q.currency || "EUR");
      setVatCategory(q.vat_category || "standard");
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

      // Charger l'historique des versions (chaine root_quote_id)
      const rootId = q.root_quote_id || q.id;
      const allVersions = await sb.select(token, "quotes", {
        filter: `root_quote_id=eq.${rootId}`,
        select: "id,number,version,status,issue_date,total_ttc_cents",
        order: "version.asc"
      });
      if (alive) setVersionsHistory(allVersions || []);

      setLoading(false);
    })();
    return () => { alive = false; };
  }, [id, isNew, token, company.vat_default_rate]);

  // recharge client si changement
  useEffect(() => {
    if (!clientId) { setClient(null); return; }
    sb.selectOne(token, "clients", `id=eq.${clientId}`).then((c) => {
      setClient(c);
      // Auto-suggestion de la categorie TVA selon le client
      if (c && (!quote || quote.status === "draft")) {
        const suggested = suggestVatCategory(c, company);
        setVatCategory(suggested);
      }
    });
  }, [clientId, token, quote?.status, company]);

  const totals = useMemo(() => calcDocumentTotals(lines), [lines]);

  // expiration calculée
  const expiresAt = useMemo(() => {
    if (!issueDate || !validityDays) return null;
    const d = new Date(issueDate);
    d.setDate(d.getDate() + Number(validityDays));
    return d.toISOString().slice(0, 10);
  }, [issueDate, validityDays]);

  const isReadonly = quote && ["signed", "converted", "refused"].includes(quote.status);

  // ─── Sauvegarde brouillon (création ou maj) ────────────
  async function save({ thenStatus = null } = {}) {
    setErr("");
    if (!clientId) { setErr("Sélectionnez un client"); return null; }
    if (!issueDate) { setErr("Date d'émission requise"); return null; }
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

    let saved;
    if (isNew && !quote) {
      // Allocation du numéro à la création (même brouillon — comme ça il est immédiatement identifiable)
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

    if (!saved) { setSaving(false); setErr("Erreur d'enregistrement"); return null; }

    // Réécriture des lignes : delete + insert (simple et fiable pour les drafts)
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

    // Changement de statut éventuel (envoi)
    if (thenStatus) {
      const updated = await sb.update(token, "quotes", `id=eq.${saved.id}`, { status: thenStatus });
      saved = updated?.[0] || saved;
    }

    setSaving(false);
    setQuote(saved);

    if (isNew) {
      navigate(`/quotes/${saved.id}`, { replace: true });
    }
    return saved;
  }

  // ─── Envoi du devis (passage en "sent") ────────────────
  // Aperçu PDF : génère et ouvre dans un nouvel onglet
  async function previewPdf(quoteId) {
    setSaving(true);
    try {
      const r = await fetch("/api/generate-quote-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ quote_id: quoteId })
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "Erreur génération PDF");
      }
      const j = await r.json();
      setSaving(false);
      if (j.pdf_url) {
        window.open(j.pdf_url, "_blank");
      } else if (j.pdf_base64) {
        // Fallback : base64 → blob → ouvrir
        const byteChars = atob(j.pdf_base64);
        const bytes = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
        const blob = new Blob([bytes], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } else {
        alert("PDF généré mais aucune URL n'a été retournée.");
      }
    } catch (e) {
      setSaving(false);
      alert(e.message);
    }
  }

  // Créer une nouvelle version (v2, v3...) du devis courant
  async function createVersion(sourceQuoteId) {
    if (!confirm("Créer une nouvelle version de ce devis ? L'original sera marqué comme remplacé et restera consultable.")) return;
    setSaving(true);
    try {
      const r = await fetch("/api/quote-version", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ quote_id: sourceQuoteId })
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "Erreur");
      }
      const j = await r.json();
      setSaving(false);
      // Naviguer vers la nouvelle version pour la modifier
      navigate(`/quotes/${j.new_quote_id}`);
    } catch (e) {
      setSaving(false);
      alert(e.message);
    }
  }

  async function sendQuote() {
    const saved = await save({ thenStatus: "sent" });
    if (!saved) return;

    // Telemetrie
    capture("quote_sent", {
      quote_id: saved.id,
      number: saved.number,
      total_ttc: saved.total_ttc_cents / 100,
      currency: saved.currency || "EUR",
      via_esign: !!company.modules?.esign
    });
    bumpModuleUsage(token, company.id, "invoicing");

    // 1) Si le module esign est actif, on declenche Yousign
    if (company.modules?.esign) {
      try {
        const r = await fetch("/api/yousign-create", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ quote_id: saved.id })
        });
        if (r.ok) {
          alert("Devis envoyé pour signature électronique. Le client va recevoir un email Yousign.");
          return;
        }
      } catch (e) {
        // tombe en fallback sur send-document
      }
    }

    // 2) Fallback / module esign desactive : envoi par email simple
    try {
      const r = await fetch("/api/send-document", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ document_type: "quote", document_id: saved.id })
      });
      if (r.ok) {
        alert("Devis envoyé par email au client.");
      } else {
        const err = await r.json().catch(() => ({}));
        alert("Devis enregistré comme envoyé. Email non envoyé : " + (err.error || "API indisponible"));
      }
    } catch (e) {
      alert("Devis enregistré. L'envoi automatique est indisponible — partagez-le manuellement.");
    }
  }

  // ─── Conversion en facture ─────────────────────────────
  async function convertToInvoice() {
    if (!quote || quote.status === "converted") return;
    setSaving(true);

    // 1) Numéro facture
    const invoiceNumber = await sb.rpc(token, "allocate_document_number", {
      p_company_id: company.id,
      p_doc_type: "invoice"
    });

    // 2) Snapshots à jour (au moment de la conversion)
    const t = calcDocumentTotals(lines);
    const dueDate = new Date(issueDate);
    dueDate.setDate(dueDate.getDate() + (client?.payment_terms_days || 30));

    const invPayload = {
      company_id: company.id,
      client_id: clientId,
      quote_id: quote.id,
      number: invoiceNumber,
      client_snapshot: quote.client_snapshot,
      company_snapshot: quote.company_snapshot,
      issue_date: todayISO(),
      due_date: dueDate.toISOString().slice(0, 10),
      payment_terms_days: client?.payment_terms_days || 30,
      subtotal_ht_cents: t.subtotal_ht_cents,
      vat_total_cents: t.vat_total_cents,
      total_ttc_cents: t.total_ttc_cents,
      vat_breakdown: t.vat_breakdown,
      status: "draft",
      notes: notes || null,
      terms: terms || null
    };

    const createdInv = await sb.insert(token, "invoices", invPayload);
    const invoice = createdInv?.[0];
    if (!invoice) { setSaving(false); setErr("Erreur lors de la création de la facture"); return; }

    // 3) Recopie des lignes
    const linesPayload = lines
      .filter((l) => l.description?.trim())
      .map((l, idx) => {
        const c = calcLine(l);
        return {
          company_id: company.id,
          document_type: "invoice",
          document_id: invoice.id,
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

    // 4) Marquer le devis comme converti
    await sb.update(token, "quotes", `id=eq.${quote.id}`, {
      status: "converted",
      converted_invoice_id: invoice.id
    });

    // Telemetrie : conversion devis -> facture (event clef pour win rate)
    capture("quote_converted", {
      quote_id: quote.id,
      invoice_id: invoice.id,
      total_ttc: quote.total_ttc_cents / 100,
      currency: quote.currency || "EUR"
    });
    bumpModuleUsage(token, company.id, "invoicing");

    setSaving(false);
    navigate(`/invoices/${invoice.id}`);
  }

  if (loading) {
    return <div className="page"><div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Chargement...</div></div>;
  }

  const effectiveStatus = quote && isQuoteExpired(quote) ? "expired" : quote?.status || "draft";
  const badge = quoteStatusBadge(effectiveStatus);

  return (
    <div className="page">
      <div style={{ marginBottom: 14 }}>
        <Link to="/quotes" style={{ fontSize: 12, color: "var(--gold)", textDecoration: "none" }}>
          ← Retour aux devis
        </Link>
      </div>

      <div className="page-header">
        <div>
          <div className="page-title">{isNew ? "NOUVEAU DEVIS" : (quote?.number || "DEVIS")}</div>
          <div className="page-sub" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span className={"badge " + badge.cls}>{badge.label}</span>
            {quote?.version > 1 && (
              <span className="badge badge-gold" style={{ fontSize: 10 }}>v{quote.version}</span>
            )}
            {quote?.superseded_by_id && (
              <span className="badge badge-muted" style={{ fontSize: 10 }}>Remplacé</span>
            )}
            {quote?.signed_at && <span style={{ fontSize: 11 }}>Signé le {fmtDate(quote.signed_at)}</span>}
            {quote?.converted_invoice_id && (
              <Link to={`/invoices/${quote.converted_invoice_id}`} style={{ color: "var(--green)", fontSize: 11 }}>
                → Facture associée
              </Link>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {!isReadonly && (
            <>
              <button className="btn btn-ghost" onClick={() => save()} disabled={saving}>
                {saving ? "..." : "Enregistrer brouillon"}
              </button>
              {(quote?.status === "draft" || isNew) && (
                <button className="btn btn-primary" onClick={sendQuote} disabled={saving}>
                  <Icon name="send" size={13} /> Envoyer pour signature
                </button>
              )}
              {quote?.status === "signed" && (
                <button className="btn btn-primary" onClick={() => setConfirmConvert(true)} disabled={saving}>
                  Convertir en facture →
                </button>
              )}
            </>
          )}
          {quote?.id && quote?.status !== "converted" && !quote?.superseded_by_id && (
            <button className="btn btn-ghost" onClick={() => createVersion(quote.id)} disabled={saving} title="Dupliquer ce devis en nouvelle version">
              ↪️ Créer v{(quote.version || 1) + 1}
            </button>
          )}
          {quote?.id && (
            <button className="btn btn-ghost" onClick={() => previewPdf(quote.id)} disabled={saving}>
              📄 Aperçu PDF
            </button>
          )}
          {quote?.id && (
            <button className="btn btn-ghost" onClick={() => sharePublicLink(token, "quote", quote.id)}>
              🔗 Partager
            </button>
          )}
          {isReadonly && quote?.status === "signed" && !quote.converted_invoice_id && (
            <button className="btn btn-primary" onClick={() => setConfirmConvert(true)} disabled={saving}>
              Convertir en facture →
            </button>
          )}
        </div>
      </div>

      {err && <div className="auth-error" style={{ marginBottom: 14 }}>{err}</div>}

      {/* Bandeau si version remplacée */}
      {quote?.superseded_by_id && (() => {
        const replacement = versionsHistory.find((v) => v.id === quote.superseded_by_id);
        return (
          <div className="card card-pad" style={{
            marginBottom: 14, borderLeft: "3px solid var(--orange)",
            display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap"
          }}>
            <div style={{ fontSize: 22 }}>↪️</div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
                Cette version a été remplacée
              </div>
              <div style={{ fontSize: 11, color: "var(--muted2)" }}>
                Une version plus récente {replacement ? `(v${replacement.version})` : ""} a été créée.
                Cette version reste consultable à titre d'historique.
              </div>
            </div>
            {replacement && (
              <Link to={`/quotes/${replacement.id}`} className="btn btn-primary btn-sm">
                Voir v{replacement.version} →
              </Link>
            )}
          </div>
        );
      })()}

      {/* Historique des versions (si > 1) */}
      {versionsHistory.length > 1 && (
        <div className="card card-pad" style={{ marginBottom: 14 }}>
          <div style={{
            fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase",
            color: "var(--muted)", fontWeight: 600, marginBottom: 10
          }}>
            Historique des versions ({versionsHistory.length})
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {versionsHistory.map((v) => {
              const isCurrent = v.id === quote?.id;
              return (
                <Link
                  key={v.id}
                  to={`/quotes/${v.id}`}
                  style={{
                    textDecoration: "none",
                    background: isCurrent ? "var(--gold)" : "var(--card2)",
                    color: isCurrent ? "#0b0c10" : "var(--text)",
                    padding: "8px 12px", borderRadius: 7,
                    fontSize: 11, fontWeight: 600,
                    display: "flex", flexDirection: "column", gap: 2,
                    minWidth: 110
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span>v{v.version}</span>
                    {isCurrent && <span style={{ fontSize: 9 }}>● ACTUEL</span>}
                  </div>
                  <div className="mono" style={{ fontSize: 10, opacity: 0.8 }}>
                    {v.number}
                  </div>
                  <div style={{ fontSize: 10, opacity: 0.7 }}>
                    {fmtDate(v.issue_date)} · {v.status}
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 14 }}>
          <ClientPicker
            token={token}
            company={company}
            value={clientId}
            onChange={(id) => setClientId(id)}
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
            <label className="form-label">Validité (jours)</label>
            <input
              type="number"
              className="form-input mono"
              value={validityDays}
              onChange={(e) => setValidityDays(Number(e.target.value))}
              disabled={isReadonly}
            />
            <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 3 }}>
              Expire le {fmtDate(expiresAt)}
            </div>
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

        {client && (
          <div style={{ background: "var(--card2)", padding: "10px 14px", borderRadius: 7, fontSize: 12, color: "var(--muted2)", marginTop: 4 }}>
            <strong style={{ color: "var(--text)" }}>{snapshotDisplayName(buildClientSnapshot(client))}</strong>
            {client.email && <> · {client.email}</>}
            {client.payment_terms_days && <> · Délai paiement : <span className="mono">{client.payment_terms_days} j</span></>}
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
        <TotalsBlock totals={totals} />
        {vatExempt && (
          <div className="tipline" style={{ marginTop: 14 }}>
            <Icon name="alert" size={14} />
            TVA non applicable, art. 293 B du CGI (franchise en base).
          </div>
        )}
      </div>

      {/* NOTES & CONDITIONS */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <div className="card card-pad">
          <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 10 }}>
            Notes (visibles sur le devis)
          </div>
          <textarea
            className="form-input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={isReadonly}
            rows={4}
            placeholder="Précisions, conditions particulières..."
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
            rows={4}
            placeholder="Acompte, délais, pénalités de retard..."
            style={{ fontFamily: "DM Sans, sans-serif", resize: "vertical" }}
          />
        </div>
      </div>

      {confirmConvert && (
        <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setConfirmConvert(false)}>
          <div className="modal" style={{ maxWidth: 460 }}>
            <div className="modal-hd">
              <div className="modal-title">Convertir en facture</div>
              <button className="close-btn" onClick={() => setConfirmConvert(false)}><Icon name="x" size={14} /></button>
            </div>
            <div className="modal-body">
              <div style={{ fontSize: 13, color: "var(--muted2)", marginBottom: 18, lineHeight: 1.6 }}>
                Une facture <strong style={{ color: "var(--text)" }}>brouillon</strong> sera créée avec les mêmes lignes.
                Vous pourrez encore la modifier avant de l'émettre. Le devis sera marqué comme converti.
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button className="btn btn-ghost" onClick={() => setConfirmConvert(false)}>Annuler</button>
                <button className="btn btn-primary" onClick={convertToInvoice} disabled={saving}>
                  {saving ? "Conversion..." : "Créer la facture"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
