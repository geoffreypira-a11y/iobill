import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtEUR, fmtDate } from "../../lib/helpers.js";
import { snapshotDisplayName } from "../../lib/snapshots.js";
import { CREDIT_NOTE_STATUSES, creditNoteStatusBadge } from "./creditNoteHelpers.js";
import { SkeletonTable } from "../../components/Skeleton.jsx";
import { DocumentPreviewModal } from "../../components/DocumentPreviewModal.jsx";

export function CreditNotesListPage({ token, company }) {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  // Modale "Nouvel avoir" : sélection de la facture source
  const [showPicker, setShowPicker] = useState(false);
  // Aperçu de la facture source au clic sur "→ voir"
  const [previewInvoice, setPreviewInvoice] = useState(null);
  // v8.41 — Aperçu de l'avoir lui-même au clic sur "👁 Voir"
  const [previewCreditNote, setPreviewCreditNote] = useState(null);
  // v8.42 — Transmission PDP : loading + toast
  const [actionLoading, setActionLoading] = useState(null);
  const [toast, setToast] = useState(null);

  function showToast(msg, type = "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }

  async function refreshList() {
    const list = await sb.select(token, "credit_notes", {
      filter: `company_id=eq.${company.id}`,
      order: "issue_date.desc",
      limit: 200
    });
    setItems(list || []);
  }

  // v8.42 — Transmission PDP d'un avoir (équivalent transmitToAdmin pour factures)
  async function transmitCreditNote(cn) {
    setActionLoading(`transmit-${cn.id}`);
    try {
      const r = await fetch("/api/generate-facturx", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          document_type: "credit_note",
          document_id: cn.id,
          transmit_pdp: true
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Erreur ${r.status}`);
      await refreshList();
      showToast(`Avoir transmis via ${j.provider || "PDP"} (ID: ${j.transmission_id || "?"})`);
    } catch (e) {
      showToast(e.message || "Erreur transmission PDP", "error");
    }
    setActionLoading(null);
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const list = await sb.select(token, "credit_notes", {
        filter: `company_id=eq.${company.id}`,
        order: "issue_date.desc",
        limit: 200
      });
      if (!alive) return;
      setItems(list || []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, company.id]);

  const filtered = useMemo(() => {
    const s = search.toLowerCase().trim();
    return items.filter((c) => {
      const name = snapshotDisplayName(c.client_snapshot).toLowerCase();
      const matchS = !s || (c.number || "").toLowerCase().includes(s) || name.includes(s);
      const matchF = statusFilter === "all" || c.status === statusFilter;
      return matchS && matchF;
    });
  }, [items, search, statusFilter]);

  const counts = useMemo(() => {
    const c = { all: items.length };
    Object.keys(CREDIT_NOTE_STATUSES).forEach((k) => { c[k] = 0; });
    items.forEach((it) => { c[it.status] = (c[it.status] || 0) + 1; });
    return c;
  }, [items]);

  const totalIssued = items
    .filter((c) => c.status === "issued")
    .reduce((s, c) => s + (c.total_ttc_cents || 0), 0);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">AVOIRS</div>
          <div className="page-sub">
            {items.length} avoir{items.length > 1 ? "s" : ""} · {fmtEUR(totalIssued)} émis
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowPicker(true)}>
          <Icon name="plus" size={14} /> Nouvel avoir
        </button>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <input
          className="search-input"
          placeholder="Rechercher numéro, client..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="tabs" style={{ margin: 0 }}>
          <button className={"tab" + (statusFilter === "all" ? " active" : "")} onClick={() => setStatusFilter("all")}>
            Tous ({counts.all})
          </button>
          {Object.entries(CREDIT_NOTE_STATUSES)
            .sort((a, b) => a[1].order - b[1].order)
            .map(([key, s]) => (
              counts[key] > 0 ? (
                <button
                  key={key}
                  className={"tab" + (statusFilter === key ? " active" : "")}
                  onClick={() => setStatusFilter(key)}
                >
                  {s.label} ({counts[key]})
                </button>
              ) : null
            ))}
        </div>
      </div>

      {loading ? (
        <SkeletonTable rows={6} cols={6} />
      ) : filtered.length === 0 ? (
        <div className="card card-pad" style={{ textAlign: "center", padding: "60px 20px" }}>
          <div style={{ fontSize: 40, marginBottom: 14 }}>↩️</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
            {search || statusFilter !== "all" ? "Aucun avoir ne correspond" : "Aucun avoir pour l'instant"}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted2)", marginBottom: 16 }}>
            Cliquez sur « Nouvel avoir » ci-dessus, ou ouvrez une facture émise et choisissez « Créer un avoir » dans le menu.
          </div>
          {(search || statusFilter !== "all") && (
            <button className="btn btn-ghost" onClick={() => { setSearch(""); setStatusFilter("all"); }}>
              Effacer les filtres
            </button>
          )}
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th>N°</th>
                <th>Client</th>
                <th>Émis le</th>
                <th>Facture liée</th>
                <th style={{ textAlign: "right" }}>Montant TTC</th>
                <th>Statut</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => {
                const badge = creditNoteStatusBadge(c.status);
                return (
                  <tr key={c.id} onClick={() => navigate(`/credit-notes/${c.id}`)} style={{ cursor: "pointer" }}>
                    <td className="mono">{c.number}</td>
                    <td>{snapshotDisplayName(c.client_snapshot)}</td>
                    <td>{fmtDate(c.issue_date)}</td>
                    <td className="mono" style={{ fontSize: 11, color: "var(--muted2)" }}>
                      {c.invoice_id ? (
                        <button
                          type="button"
                          onClick={async (e) => {
                            e.stopPropagation();
                            // Charge la facture source pour la preview
                            const inv = await sb.selectOne(token, "invoices", `id=eq.${c.invoice_id}`);
                            if (inv) setPreviewInvoice(inv);
                          }}
                          style={{
                            background: "none", border: "none", padding: 0, cursor: "pointer",
                            color: "var(--gold)", textDecoration: "none", fontSize: 11
                          }}
                          title="Aperçu de la facture liée"
                        >
                          → voir
                        </button>
                      ) : "—"}
                    </td>
                    <td className="mono" style={{ textAlign: "right", color: "var(--orange)" }}>
                      − {fmtEUR(c.total_ttc_cents)}
                    </td>
                    <td><span className={"badge " + badge.cls}>{badge.label}</span></td>
                    {/* v8.41 — Boutons Voir + Transmettre (cohérent avec page Factures) */}
                    <td>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "nowrap" }}>
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPreviewCreditNote(c);
                          }}
                          style={{ padding: "5px 12px", fontSize: 11, whiteSpace: "nowrap" }}
                          title="Aperçu PDF de cet avoir"
                        >
                          👁 Voir
                        </button>
                        {/* v8.42 — Transmettre à la DGFiP via PDP (uniquement si émis et pas encore transmis) */}
                        {c.status === "issued" && !c.pdp_transmitted_at && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              transmitCreditNote(c);
                            }}
                            disabled={actionLoading === `transmit-${c.id}`}
                            style={{ padding: "5px 10px", fontSize: 11, color: "var(--green)", borderColor: "rgba(62,207,122,0.4)", whiteSpace: "nowrap" }}
                            title="Transmettre l'avoir à l'administration via votre PDP"
                          >
                            {actionLoading === `transmit-${c.id}` ? "⏳ Transmission..." : "🏛️ Transmettre"}
                          </button>
                        )}
                        {c.pdp_transmitted_at && (
                          <span
                            style={{ padding: "5px 10px", fontSize: 10, color: "var(--green)", border: "1px solid rgba(62,207,122,0.3)", borderRadius: 6, whiteSpace: "nowrap" }}
                            title={`Transmis via ${c.pdp_provider || "PDP"} le ${new Date(c.pdp_transmitted_at).toLocaleDateString("fr-FR")}`}
                          >
                            ✓ Transmis
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showPicker && (
        <InvoicePickerModal
          token={token}
          company={company}
          onCancel={() => setShowPicker(false)}
          onPick={(invoiceId) => {
            setShowPicker(false);
            navigate(`/credit-notes/new?from_invoice=${invoiceId}`);
          }}
        />
      )}

      {previewInvoice && (
        <DocumentPreviewModal
          token={token}
          docType="invoice"
          doc={previewInvoice}
          onClose={() => setPreviewInvoice(null)}
        />
      )}

      {/* v8.41 — Modale d'aperçu PDF de l'avoir lui-même */}
      {previewCreditNote && (
        <DocumentPreviewModal
          token={token}
          docType="credit_note"
          doc={previewCreditNote}
          onClose={() => setPreviewCreditNote(null)}
        />
      )}

      {/* v8.42 — Toast de feedback (transmission PDP, etc.) */}
      {toast && (
        <div style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          background: toast.type === "error" ? "rgba(229,92,92,0.95)" : "rgba(62,207,122,0.95)",
          color: "#0b0c10",
          padding: "12px 18px",
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 600,
          zIndex: 500,
          boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
          maxWidth: 400
        }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ─── Modale : sélection d'une facture source pour créer un avoir ───
function InvoicePickerModal({ token, company, onCancel, onPick }) {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      // On charge les factures émises (statuts éligibles à un avoir)
      const list = await sb.select(token, "invoices", {
        filter: `company_id=eq.${company.id}&status=in.(issued,sent,partial,paid,overdue)`,
        order: "issue_date.desc",
        limit: 100
      });
      if (!alive) return;
      setInvoices(list || []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, company.id]);

  const filtered = useMemo(() => {
    const s = search.toLowerCase().trim();
    if (!s) return invoices;
    return invoices.filter((inv) => {
      const name = snapshotDisplayName(inv.client_snapshot).toLowerCase();
      return (inv.number || "").toLowerCase().includes(s) || name.includes(s);
    });
  }, [invoices, search]);

  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal modal-md">
        <div className="modal-hd">
          <span className="modal-title">Choisir la facture à créditer</span>
          <button className="close-btn" onClick={onCancel}>×</button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: 12, color: "var(--muted2)", marginBottom: 12 }}>
            Un avoir doit toujours référencer une facture émise. Sélectionnez la facture concernée :
          </div>
          <input
            className="search-input"
            placeholder="Rechercher numéro, client..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: "100%", marginBottom: 12 }}
          />
          {loading ? (
            <div style={{ padding: 30, textAlign: "center", color: "var(--muted)" }}>Chargement…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 30, textAlign: "center", color: "var(--muted2)", fontSize: 13 }}>
              {invoices.length === 0
                ? "Aucune facture émise. Émettez d'abord une facture pour pouvoir créer un avoir."
                : "Aucune facture ne correspond à votre recherche."}
            </div>
          ) : (
            <div style={{ maxHeight: 360, overflow: "auto", border: "1px solid var(--border2)", borderRadius: 8 }}>
              <table>
                <thead>
                  <tr>
                    <th>N°</th>
                    <th>Client</th>
                    <th>Émise le</th>
                    <th style={{ textAlign: "right" }}>Montant TTC</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((inv) => (
                    <tr key={inv.id} onClick={() => onPick(inv.id)} style={{ cursor: "pointer" }}>
                      <td className="mono">{inv.number}</td>
                      <td>{snapshotDisplayName(inv.client_snapshot)}</td>
                      <td>{fmtDate(inv.issue_date)}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(inv.total_ttc_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onCancel}>Annuler</button>
        </div>
      </div>
    </div>
  );
}
