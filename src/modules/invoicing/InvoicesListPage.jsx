import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtEUR, fmtDate } from "../../lib/helpers.js";
import { snapshotDisplayName } from "../../lib/snapshots.js";
import { INVOICE_STATUSES, invoiceStatusBadge, isInvoiceOverdue } from "./invoiceHelpers.js";
import { SkeletonTable } from "../../components/Skeleton.jsx";
import { InvoiceEditorModal } from "./InvoiceEditorModal.jsx";
import { ConfirmModal } from "../../components/ConfirmModal.jsx";
import { capture } from "../../lib/telemetry.js";

export function InvoicesListPage({ token, company }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const [editModal, setEditModal] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [pendingIssue, setPendingIssue] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (searchParams.get("new") === "1") {
      setEditModal("new");
      const next = new URLSearchParams(searchParams);
      next.delete("new");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  async function refreshInvoices() {
    setLoading(true);
    const list = await sb.select(token, "invoices", {
      filter: `company_id=eq.${company.id}`,
      order: "created_at.desc",
      limit: 300
    });
    setInvoices(list || []);
    setLoading(false);
  }

  useEffect(() => {
    refreshInvoices();
  }, [token, company.id]);

  function effectiveStatus(inv) {
    if (isInvoiceOverdue(inv)) return "overdue";
    return inv.status;
  }

  const filtered = useMemo(() => {
    const s = search.toLowerCase().trim();
    return invoices.filter((inv) => {
      const name = snapshotDisplayName(inv.client_snapshot).toLowerCase();
      const matchS = !s || (inv.number || "").toLowerCase().includes(s) || name.includes(s);
      const matchF = statusFilter === "all" || effectiveStatus(inv) === statusFilter;
      return matchS && matchF;
    });
  }, [invoices, search, statusFilter]);

  const counts = useMemo(() => {
    const c = { all: invoices.length };
    Object.keys(INVOICE_STATUSES).forEach((k) => { c[k] = 0; });
    invoices.forEach((inv) => {
      const eff = effectiveStatus(inv);
      c[eff] = (c[eff] || 0) + 1;
    });
    return c;
  }, [invoices]);

  const totalUnpaid = invoices
    .filter((inv) => ["issued", "sent", "partial", "overdue"].includes(inv.status))
    .reduce((s, inv) => s + ((inv.total_ttc_cents || 0) - (inv.paid_cents || 0)), 0);

  function showToast(msg, type = "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }

  function onSavedFromModal(savedInvoice) {
    setInvoices((prev) => {
      const exists = prev.find((i) => i.id === savedInvoice.id);
      if (exists) return prev.map((i) => (i.id === savedInvoice.id ? savedInvoice : i));
      return [savedInvoice, ...prev];
    });
    setEditModal(null);
    showToast(`Facture ${savedInvoice.number} enregistrée`);
  }

  async function issueInvoice(inv) {
    setActionLoading(`issue-${inv.id}`);
    try {
      const updated = await sb.update(token, "invoices", `id=eq.${inv.id}`, {
        status: "issued",
        issued_at: new Date().toISOString()
      });
      if (!updated?.[0]) throw new Error("Erreur émission");
      capture("invoice_issued", { invoice_id: inv.id });

      // Génération facturx automatique (en async)
      fetch("/api/generate-facturx", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ invoice_id: inv.id })
      }).catch(() => {});

      await refreshInvoices();
      setPendingIssue(null);
      showToast(`Facture ${inv.number} émise !`);
    } catch (e) {
      showToast(e.message || "Erreur émission", "error");
    }
    setActionLoading(null);
  }

  async function sendInvoice(inv) {
    setActionLoading(`send-${inv.id}`);
    try {
      const r = await fetch("/api/send-document", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ document_type: "invoice", document_id: inv.id })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Erreur d'envoi");
      capture("invoice_sent", { invoice_id: inv.id });
      await refreshInvoices();
      showToast(`Facture envoyée à ${j.recipient}${j.pdf_attached ? " (PDF joint)" : ""}`);
    } catch (e) {
      showToast(e.message, "error");
    }
    setActionLoading(null);
  }

  async function previewPdf(inv) {
    setActionLoading(`pdf-${inv.id}`);
    try {
      if (inv.facturx_pdf_url) {
        window.open(inv.facturx_pdf_url, "_blank");
        setActionLoading(null);
        return;
      }
      const r = await fetch("/api/generate-facturx", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ invoice_id: inv.id, preview: true })
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "Erreur génération PDF");
      }
      const j = await r.json();
      if (j.pdf_url) {
        window.open(j.pdf_url, "_blank");
      } else if (j.pdf_base64) {
        const byteChars = atob(j.pdf_base64);
        const bytes = new Uint8Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
        const blob = new Blob([bytes], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank");
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    } catch (e) {
      showToast(e.message, "error");
    }
    setActionLoading(null);
  }

  async function shareLink(inv) {
    setActionLoading(`share-${inv.id}`);
    try {
      const r = await fetch("/api/public-share", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ scope: "invoice", resource_id: inv.id, expires_in_days: 90 })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Erreur");
      if (j.public_url) {
        try { await navigator.clipboard.writeText(j.public_url); } catch {}
        showToast("Lien copié dans le presse-papiers !");
      }
    } catch (e) {
      showToast(e.message, "error");
    }
    setActionLoading(null);
  }

  async function deleteInvoice(id) {
    try {
      await sb.delete(token, "document_lines", `document_type=eq.invoice&document_id=eq.${id}`);
      await sb.delete(token, "invoices", `id=eq.${id}`);
      setInvoices((prev) => prev.filter((i) => i.id !== id));
      setPendingDelete(null);
      showToast("Facture supprimée");
    } catch (e) {
      showToast(e.message || "Erreur suppression", "error");
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">FACTURES</div>
          <div className="page-sub">
            {invoices.length} factures · {fmtEUR(totalUnpaid)} en attente de règlement
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setEditModal("new")}>
          <Icon name="plus" size={14} /> Nouvelle facture
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
            Toutes ({counts.all})
          </button>
          {Object.entries(INVOICE_STATUSES)
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
        <SkeletonTable rows={6} cols={7} />
      ) : filtered.length === 0 ? (
        <div className="card card-pad" style={{ textAlign: "center", padding: "60px 20px" }}>
          <div style={{ fontSize: 40, marginBottom: 14 }}>🧾</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
            {search || statusFilter !== "all" ? "Aucune facture ne correspond" : "Aucune facture pour l'instant"}
          </div>
          {search || statusFilter !== "all" ? (
            <button className="btn btn-ghost" onClick={() => { setSearch(""); setStatusFilter("all"); }}>
              Effacer les filtres
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => setEditModal("new")}>
              <Icon name="plus" size={14} /> Créer une facture
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
                <th>Émise le</th>
                <th>Échéance</th>
                <th style={{ textAlign: "right" }}>Montant TTC</th>
                <th>Statut</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => {
                const eff = effectiveStatus(inv);
                const badge = invoiceStatusBadge(eff);
                const canEdit = inv.status === "draft";
                const canIssue = inv.status === "draft";
                const canSend = ["issued", "sent", "partial", "overdue"].includes(inv.status);
                const canDelete = inv.status === "draft";

                return (
                  <tr key={inv.id}>
                    <td className="mono">{inv.number || <span style={{ color: "var(--muted)" }}>—</span>}</td>
                    <td>{snapshotDisplayName(inv.client_snapshot)}</td>
                    <td>{fmtDate(inv.issue_date)}</td>
                    <td style={{ fontSize: 12, color: eff === "overdue" ? "var(--red)" : "var(--muted2)" }}>
                      {fmtDate(inv.due_date)}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(inv.total_ttc_cents)}</td>
                    <td><span className={"badge " + badge.cls}>{badge.label}</span></td>
                    <td>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        <button
                          className="btn btn-ghost btn-xs"
                          onClick={() => previewPdf(inv)}
                          disabled={actionLoading === `pdf-${inv.id}`}
                          title="Aperçu PDF"
                        >📄</button>
                        {canIssue && (
                          <button
                            className="btn btn-ghost btn-xs"
                            style={{ color: "var(--gold)" }}
                            onClick={() => setPendingIssue(inv)}
                            disabled={actionLoading === `issue-${inv.id}`}
                            title="Émettre (verrouille la facture)"
                          >🔒</button>
                        )}
                        {canSend && (
                          <button
                            className="btn btn-ghost btn-xs"
                            style={{ color: "var(--gold)" }}
                            onClick={() => sendInvoice(inv)}
                            disabled={actionLoading === `send-${inv.id}`}
                            title="Envoyer par email"
                          >📧</button>
                        )}
                        {!canEdit && (
                          <button
                            className="btn btn-ghost btn-xs"
                            onClick={() => shareLink(inv)}
                            disabled={actionLoading === `share-${inv.id}`}
                            title="Partager (lien public)"
                          >🔗</button>
                        )}
                        <button
                          className="btn btn-ghost btn-xs"
                          onClick={() => setEditModal(inv)}
                          title={canEdit ? "Modifier" : "Voir"}
                        >{canEdit ? "✏️" : "👁"}</button>
                        {canDelete && (
                          <button
                            className="btn btn-danger btn-xs"
                            onClick={() => setPendingDelete({ id: inv.id, label: inv.number || "cette facture" })}
                            title="Supprimer"
                          >🗑</button>
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

      {editModal && (
        <InvoiceEditorModal
          token={token}
          company={company}
          invoice={editModal === "new" ? null : editModal}
          onClose={() => setEditModal(null)}
          onSaved={onSavedFromModal}
        />
      )}

      {pendingDelete && (
        <ConfirmModal
          title="Supprimer cette facture ?"
          message={`Cette action est irréversible. La facture ${pendingDelete.label} et toutes ses lignes seront supprimées.`}
          confirmLabel="Supprimer"
          confirmType="danger"
          onConfirm={() => deleteInvoice(pendingDelete.id)}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {pendingIssue && (
        <ConfirmModal
          title="Émettre cette facture ?"
          message={
            <>
              La facture <strong>{pendingIssue.number}</strong> sera émise et verrouillée :
              elle ne pourra plus être modifiée. Un PDF Factur-X conforme sera généré automatiquement.
              <br /><br />
              <em style={{ fontSize: 11, color: "var(--muted)" }}>
                Pour corriger une facture émise, vous devrez créer un avoir.
              </em>
            </>
          }
          confirmLabel="Émettre la facture"
          confirmType="primary"
          onConfirm={() => issueInvoice(pendingIssue)}
          onCancel={() => setPendingIssue(null)}
        />
      )}

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
          maxWidth: 400,
          animation: "slideup 0.2s"
        }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
