import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { subscribe } from "../../lib/realtime.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtEUR, fmtDate } from "../../lib/helpers.js";
import { snapshotDisplayName } from "../../lib/snapshots.js";
import { INVOICE_STATUSES, invoiceStatusBadge, isInvoiceOverdue } from "./invoiceHelpers.js";
import { SkeletonTable } from "../../components/Skeleton.jsx";
import { InvoiceEditorModal } from "./InvoiceEditorModal.jsx";
import { ConfirmModal } from "../../components/ConfirmModal.jsx";
import { DocumentPreviewModal } from "../../components/DocumentPreviewModal.jsx";
import { capture } from "../../lib/telemetry.js";
import { syncVatCurrentPeriod } from "../../lib/vat-sync.js";
import { NotifBadge } from "../../components/NotifBadge.jsx";
import { useSignalCounts } from "../../lib/useSignalCounts.js";

export function InvoicesListPage({ token, company }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  // v8.27.5 — signalements ouverts du cabinet sur chaque facture
  const { byId: signalsByInvoiceId } = useSignalCounts(token, company?.id, "invoice");

  const [editModal, setEditModal] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [pendingIssue, setPendingIssue] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [toast, setToast] = useState(null);
  const [openMenu, setOpenMenu] = useState(null);
  // Modale de preview PDF : null ou objet facture
  const [previewInvoice, setPreviewInvoice] = useState(null);

  // Fermer le menu kebab si on clique en dehors ou si on scroll
  useEffect(() => {
    function close() { setOpenMenu(null); }
    if (openMenu) {
      const t = setTimeout(() => {
        document.addEventListener("click", close);
        window.addEventListener("scroll", close, true);
        window.addEventListener("resize", close);
      }, 50);
      return () => {
        clearTimeout(t);
        document.removeEventListener("click", close);
        window.removeEventListener("scroll", close, true);
        window.removeEventListener("resize", close);
      };
    }
  }, [openMenu]);

  useEffect(() => {
    if (searchParams.get("new") === "1") {
      setEditModal("new");
      const next = new URLSearchParams(searchParams);
      next.delete("new");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  async function refreshInvoices(silent = false) {
    if (!silent) setLoading(true);
    const list = await sb.select(token, "invoices", {
      filter: `company_id=eq.${company.id}`,
      order: "created_at.desc",
      limit: 300
    });
    const newList = list || [];
    if (silent) {
      setInvoices((prev) => {
        if (prev.length !== newList.length) return newList;
        for (let i = 0; i < newList.length; i++) {
          if (prev[i]?.id !== newList[i].id) return newList;
          if (prev[i]?.status !== newList[i].status) return newList;
          if (prev[i]?.paid_cents !== newList[i].paid_cents) return newList;
          if (prev[i]?.pdp_transmitted_at !== newList[i].pdp_transmitted_at) return newList;
          if (prev[i]?.sent_at !== newList[i].sent_at) return newList;
        }
        return prev;
      });
    } else {
      setInvoices(newList);
      setLoading(false);
    }
  }

  // Chargement initial + Realtime WebSocket + fallback polling
  useEffect(() => {
    let alive = true;
    let timer = null;
    refreshInvoices(false);

    // Realtime : reaction <1s aux INSERT/UPDATE/DELETE
    const unsubscribe = subscribe(
      token,
      "invoices",
      `company_id=eq.${company.id}`,
      () => { if (alive) refreshInvoices(true); }
    );

    // Fallback : polling 60s
    timer = setInterval(() => { if (alive) refreshInvoices(true); }, 60000);

    function onVisibility() {
      if (alive && document.visibilityState === "visible") refreshInvoices(true);
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
    };
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
      // On delegue tout au serveur : UPDATE statut + generation Factur-X en une seule API call
      // (evite la race condition entre UPDATE frontend et lecture serveur)
      const r = await fetch("/api/generate-facturx", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ invoice_id: inv.id, issue: true })
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || `Erreur ${r.status} lors de l'emission`);
      }
      capture("invoice_issued", { invoice_id: inv.id });
      // Sync TVA en arrière-plan (n'attend pas la réponse pour ne pas bloquer l'UI)
      syncVatCurrentPeriod(token, company);
      await refreshInvoices();
      setPendingIssue(null);
      showToast(`Facture ${inv.number} émise et PDF Factur-X généré !`);
    } catch (e) {
      showToast(e.message || "Erreur émission", "error");
    }
    setActionLoading(null);
  }

  async function transmitToAdmin(inv) {
    setActionLoading(`transmit-${inv.id}`);
    try {
      const r = await fetch("/api/generate-facturx", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ invoice_id: inv.id, transmit_pdp: true })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(j.error || `Erreur ${r.status}`);
      }
      capture("invoice_pdp_transmitted", { invoice_id: inv.id, provider: j.provider });
      await refreshInvoices();
      showToast(`Facture transmise via ${j.provider || "PDP"} (ID: ${j.transmission_id || "?"})`);
    } catch (e) {
      showToast(e.message || "Erreur transmission PDP", "error");
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

  function previewPdf(inv) {
    // Ouvre la modale d'apercu PDF (pattern IOcar PrintDoc)
    setPreviewInvoice(inv);
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
                // v8.37 — Factures venant d'une app externe (IOCAR, IOBTP...)
                // sont en LECTURE SEULE côté IOBILL. Les modifs se font dans
                // l'app source pour garantir la cohérence.
                const isExternal = !!inv.external_source && inv.external_source !== "iobill";
                const sourceLabel = inv.external_source === "iocar" ? "IO CAR"
                                  : inv.external_source === "iobtp" ? "IO BTP"
                                  : String(inv.external_source || "").toUpperCase();

                const canEdit = !isExternal && inv.status === "draft";
                const canIssue = !isExternal && inv.status === "draft";
                const canSend = !isExternal && ["issued", "sent", "partial", "overdue"].includes(inv.status);
                const canDelete = !isExternal && inv.status === "draft";
                // Transmettre PDP reste possible pour les factures externes
                // (utile : la PDP est gérée centralement côté IOBILL)
                const canTransmit = ["issued", "sent", "partial", "paid", "overdue"].includes(inv.status) && !inv.pdp_transmitted_at;
                const alreadyTransmitted = !!inv.pdp_transmitted_at;

                return (
                  <tr key={inv.id}>
                    <td className="mono">
                      {inv.number || <span style={{ color: "var(--muted)" }}>—</span>}
                      {isExternal && (
                        <span
                          title={`Facture créée et gérée depuis ${sourceLabel}. Lecture seule ici.`}
                          style={{
                            display: "inline-block",
                            marginLeft: 6,
                            padding: "1px 6px",
                            borderRadius: 8,
                            background: "rgba(212,168,67,0.15)",
                            color: "var(--gold, #d4a843)",
                            fontSize: 9,
                            fontWeight: 700,
                            letterSpacing: 0.3,
                            verticalAlign: "middle"
                          }}
                        >
                          🚗 {sourceLabel}
                        </span>
                      )}
                      {signalsByInvoiceId[inv.id] && (
                        <NotifBadge
                          count={signalsByInvoiceId[inv.id].count}
                          severity={signalsByInvoiceId[inv.id].maxSeverity}
                          title={`${signalsByInvoiceId[inv.id].count} signalement(s) ouvert(s) de votre cabinet`}
                        />
                      )}
                    </td>
                    <td>{snapshotDisplayName(inv.client_snapshot)}</td>
                    <td>{fmtDate(inv.issue_date)}</td>
                    <td style={{ fontSize: 12, color: eff === "overdue" ? "var(--red)" : "var(--muted2)" }}>
                      {fmtDate(inv.due_date)}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(inv.total_ttc_cents)}</td>
                    <td><span className={"badge " + badge.cls}>{badge.label}</span></td>
                    <td>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "nowrap" }}>
                        {/* Bouton principal : Voir (preview PDF) si emise, sinon Modifier */}
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => canEdit ? setEditModal(inv) : setPreviewInvoice(inv)}
                          style={{ padding: "5px 12px", fontSize: 11, whiteSpace: "nowrap" }}
                          title={canEdit ? "Modifier cette facture" : "Aperçu PDF avec statut"}
                        >
                          {canEdit ? "✏️ Modifier" : "👁 Voir"}
                        </button>

                        {/* Action contextuelle principale */}
                        {canIssue && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => setPendingIssue(inv)}
                            disabled={actionLoading === `issue-${inv.id}`}
                            style={{ padding: "5px 10px", fontSize: 11, color: "var(--gold)", borderColor: "rgba(212,168,67,0.4)", whiteSpace: "nowrap" }}
                            title="Émettre et verrouiller cette facture"
                          >
                            🔒 Émettre
                          </button>
                        )}
                        {canSend && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => sendInvoice(inv)}
                            disabled={actionLoading === `send-${inv.id}`}
                            style={{ padding: "5px 10px", fontSize: 11, color: "var(--gold)", borderColor: "rgba(212,168,67,0.4)", whiteSpace: "nowrap" }}
                            title="Envoyer la facture par email"
                          >
                            {actionLoading === `send-${inv.id}` ? "⏳" : "📧 Envoyer"}
                          </button>
                        )}
                        {canTransmit && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => transmitToAdmin(inv)}
                            disabled={actionLoading === `transmit-${inv.id}`}
                            style={{ padding: "5px 10px", fontSize: 11, color: "var(--green)", borderColor: "rgba(62,207,122,0.4)", whiteSpace: "nowrap" }}
                            title="Transmettre la facture à l'administration via votre PDP"
                          >
                            {actionLoading === `transmit-${inv.id}` ? "⏳ Transmission..." : "🏛️ Transmettre"}
                          </button>
                        )}
                        {alreadyTransmitted && (
                          <span
                            style={{ padding: "5px 10px", fontSize: 10, color: "var(--green)", border: "1px solid rgba(62,207,122,0.3)", borderRadius: 6, whiteSpace: "nowrap" }}
                            title={`Transmise via ${inv.pdp_provider || "PDP"} le ${new Date(inv.pdp_transmitted_at).toLocaleDateString("fr-FR")}`}
                          >
                            ✓ Transmise
                          </span>
                        )}

                        {/* Bouton kebab : trigger, menu rendu en portail plus bas */}
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (openMenu?.id === inv.id) {
                              setOpenMenu(null);
                              return;
                            }
                            const rect = e.currentTarget.getBoundingClientRect();
                            setOpenMenu({
                              id: inv.id,
                              invoice: inv,
                              right: window.innerWidth - rect.right,
                              top: rect.bottom + 4,
                              canEdit, canDelete
                            });
                          }}
                          style={{ padding: "5px 8px", fontSize: 14, lineHeight: 1 }}
                          title="Plus d'actions"
                        >
                          ⋯
                        </button>
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

      {/* ─── Apercu PDF en modale (pattern IOcar PrintDoc) ─── */}
      {previewInvoice && (
        <DocumentPreviewModal
          token={token}
          docType="invoice"
          doc={previewInvoice}
          onClose={() => setPreviewInvoice(null)}
          onSend={async (inv) => {
            await sendInvoice(inv);
          }}
        />
      )}

      {/* ─── Menu kebab : rendu en position:fixed ─── */}
      {openMenu && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            top: openMenu.top,
            right: openMenu.right,
            background: "var(--card)",
            border: "1px solid var(--border2)",
            borderRadius: 8,
            boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
            minWidth: 200,
            zIndex: 9999,
            overflow: "hidden"
          }}
        >
          <MenuItemInv onClick={() => { previewPdf(openMenu.invoice); setOpenMenu(null); }}>
            📄 Aperçu PDF
          </MenuItemInv>
          {!openMenu.canEdit && (
            <MenuItemInv onClick={() => { shareLink(openMenu.invoice); setOpenMenu(null); }}>
              🔗 Copier le lien public
            </MenuItemInv>
          )}
          {openMenu.canDelete && (
            <>
              <div style={{ height: 1, background: "var(--border2)", margin: "4px 0" }} />
              <MenuItemInv
                onClick={() => { setPendingDelete({ id: openMenu.invoice.id, label: openMenu.invoice.number || "cette facture" }); setOpenMenu(null); }}
                style={{ color: "var(--red)" }}
              >
                🗑 Supprimer
              </MenuItemInv>
            </>
          )}
        </div>
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

// ─── Composant MenuItem reutilisable ───
function MenuItemInv({ children, onClick, style = {} }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "10px 14px",
        background: hover ? "var(--card2)" : "transparent",
        border: "none",
        color: "var(--text)",
        fontSize: 12,
        cursor: "pointer",
        fontFamily: "inherit",
        ...style
      }}
    >
      {children}
    </button>
  );
}
