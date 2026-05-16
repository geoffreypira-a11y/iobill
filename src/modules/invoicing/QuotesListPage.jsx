import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtEUR, fmtDate, daysUntil } from "../../lib/helpers.js";
import { snapshotDisplayName } from "../../lib/snapshots.js";
import { QUOTE_STATUSES, quoteStatusBadge, isQuoteExpired } from "./quoteHelpers.js";
import { SkeletonTable } from "../../components/Skeleton.jsx";
import { QuoteEditorModal } from "./QuoteEditorModal.jsx";
import { ConfirmModal } from "../../components/ConfirmModal.jsx";
import { DocumentPreviewModal } from "../../components/DocumentPreviewModal.jsx";
import { capture } from "../../lib/telemetry.js";

export function QuotesListPage({ token, company }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  // Modale d'édition : null = fermée, "new" = création, objet quote = édition
  const [editModal, setEditModal] = useState(null);
  // Modale de confirmation suppression : null ou { id, label }
  const [pendingDelete, setPendingDelete] = useState(null);
  // Modale de confirmation conversion en facture : null ou quote
  const [pendingConvert, setPendingConvert] = useState(null);
  // Action en cours (pour disable boutons)
  const [actionLoading, setActionLoading] = useState(null);
  // Notification de succès (toast simple)
  const [toast, setToast] = useState(null);
  // Versions de devis depliees (root_quote_id du groupe ouvert)
  const [expandedRoots, setExpandedRoots] = useState(new Set());
  // Menu kebab ouvert (id du devis dont le menu est ouvert)
  const [openMenuId, setOpenMenuId] = useState(null);
  // Modale de preview PDF : null ou objet devis
  const [previewQuote, setPreviewQuote] = useState(null);

  // Fermer le menu kebab si on clique en dehors
  useEffect(() => {
    function handleClickOutside() { setOpenMenuId(null); }
    if (openMenuId) {
      // delai pour eviter de capturer le clic d'ouverture
      const t = setTimeout(() => {
        document.addEventListener("click", handleClickOutside);
      }, 50);
      return () => {
        clearTimeout(t);
        document.removeEventListener("click", handleClickOutside);
      };
    }
  }, [openMenuId]);

  // Auto-ouverture modale si ?new=1
  useEffect(() => {
    if (searchParams.get("new") === "1") {
      setEditModal("new");
      // Clean l'URL
      const next = new URLSearchParams(searchParams);
      next.delete("new");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // ─── Chargement ─────
  async function refreshQuotes() {
    setLoading(true);
    const list = await sb.select(token, "quotes", {
      filter: `company_id=eq.${company.id}`,
      order: "issue_date.desc",
      limit: 200
    });
    setQuotes(list || []);
    setLoading(false);
  }

  useEffect(() => {
    refreshQuotes();
  }, [token, company.id]);

  // ─── Filtres ─────
  const filtered = useMemo(() => {
    const s = search.toLowerCase().trim();
    return quotes.filter((q) => {
      const name = snapshotDisplayName(q.client_snapshot).toLowerCase();
      const matchS = !s || (q.number || "").toLowerCase().includes(s) || name.includes(s);
      const effectiveStatus = isQuoteExpired(q) ? "expired" : q.status;
      const matchF = statusFilter === "all" || effectiveStatus === statusFilter;
      return matchS && matchF;
    });
  }, [quotes, search, statusFilter]);

  const counts = useMemo(() => {
    const c = { all: quotes.length };
    Object.keys(QUOTE_STATUSES).forEach((k) => { c[k] = 0; });
    quotes.forEach((q) => {
      const eff = isQuoteExpired(q) ? "expired" : q.status;
      c[eff] = (c[eff] || 0) + 1;
    });
    return c;
  }, [quotes]);

  const totalPending = quotes
    .filter((q) => q.status === "sent" && !isQuoteExpired(q))
    .reduce((s, q) => s + (q.total_ttc_cents || 0), 0);

  // ─── Groupement par root_quote_id (versions imbriquees facon arborescence) ─────
  // On ne montre que la DERNIERE version de chaque arbre, et un bouton expand
  // pour voir les versions precedentes.
  const grouped = useMemo(() => {
    // Construire map root_id -> [versions triees par version desc]
    const byRoot = new Map();
    for (const q of filtered) {
      const rootId = q.root_quote_id || q.id;
      if (!byRoot.has(rootId)) byRoot.set(rootId, []);
      byRoot.get(rootId).push(q);
    }
    // Pour chaque groupe, trier par version desc (la plus recente en premier)
    const result = [];
    for (const [rootId, versions] of byRoot) {
      versions.sort((a, b) => (b.version || 1) - (a.version || 1));
      result.push({
        rootId,
        latest: versions[0],
        versions,
        hasMultipleVersions: versions.length > 1
      });
    }
    // Trier les groupes par date de la derniere version (desc)
    result.sort((a, b) => new Date(b.latest.issue_date) - new Date(a.latest.issue_date));
    return result;
  }, [filtered]);

  function toggleExpand(rootId) {
    setExpandedRoots((prev) => {
      const next = new Set(prev);
      if (next.has(rootId)) next.delete(rootId);
      else next.add(rootId);
      return next;
    });
  }

  // ─── Toast helper ─────
  function showToast(msg, type = "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }

  // ─── Sauvegarde depuis modale ─────
  function onSavedFromModal(savedQuote) {
    setQuotes((prev) => {
      const exists = prev.find((q) => q.id === savedQuote.id);
      if (exists) return prev.map((q) => (q.id === savedQuote.id ? savedQuote : q));
      return [savedQuote, ...prev];
    });
    setEditModal(null);
    showToast(`Devis ${savedQuote.number} enregistré`);
  }

  // ─── Actions sur ligne ─────
  async function sendQuote(q) {
    if (q.status !== "draft" && q.status !== "sent") {
      showToast("Ce devis ne peut plus être envoyé (statut : " + q.status + ")", "error");
      return;
    }
    setActionLoading(`send-${q.id}`);
    try {
      const r = await fetch("/api/send-document", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ document_type: "quote", document_id: q.id })
      });
      const j = await r.json();
      if (!r.ok) {
        throw new Error(j.error || "Erreur d'envoi");
      }
      capture("quote_sent", { quote_id: q.id });
      // Refresh pour récupérer le statut "sent" mis à jour
      await refreshQuotes();
      showToast(`Devis envoyé à ${j.recipient}${j.pdf_attached ? " (PDF joint)" : ""}`);
    } catch (e) {
      showToast(e.message, "error");
    }
    setActionLoading(null);
  }

  function previewPdf(q) {
    // Ouvre la modale d'apercu PDF (pattern IOcar PrintDoc)
    setPreviewQuote(q);
  }

  async function shareLink(q) {
    setActionLoading(`share-${q.id}`);
    try {
      const r = await fetch("/api/public-share", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ scope: "quote", resource_id: q.id, expires_in_days: 90 })
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

  async function createVersion(q) {
    setActionLoading(`v2-${q.id}`);
    try {
      const r = await fetch("/api/quote-version", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ quote_id: q.id })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Erreur création version");
      await refreshQuotes();
      showToast(`Nouvelle version ${j.new_quote_number} créée (v${j.version})`);
      // Recharge le nouveau devis et l'ouvre pour édition
      if (j.new_quote_id) {
        const newQ = await sb.selectOne(token, "quotes", `id=eq.${j.new_quote_id}`);
        if (newQ) setEditModal(newQ);
      }
    } catch (e) {
      showToast(e.message, "error");
    }
    setActionLoading(null);
  }

  async function convertToInvoice(q) {
    setActionLoading(`convert-${q.id}`);
    try {
      // Create invoice from quote (côté frontend pour simplicité)
      const number = await sb.rpc(token, "allocate_document_number", {
        p_company_id: company.id,
        p_doc_type: "invoice"
      });
      const today = new Date().toISOString().slice(0, 10);
      const due = new Date();
      due.setDate(due.getDate() + (company.payment_terms_days || 30));
      const invoicePayload = {
        company_id: company.id,
        client_id: q.client_id,
        client_snapshot: q.client_snapshot,
        company_snapshot: q.company_snapshot,
        issue_date: today,
        due_date: due.toISOString().slice(0, 10),
        subtotal_ht_cents: q.subtotal_ht_cents,
        vat_total_cents: q.vat_total_cents,
        total_ttc_cents: q.total_ttc_cents,
        currency: q.currency,
        vat_category: q.vat_category,
        vat_legal_mention: q.vat_legal_mention,
        notes: q.notes,
        terms: q.terms,
        number,
        status: "draft",
        quote_id: q.id
      };
      const created = await sb.insert(token, "invoices", invoicePayload);
      const newInvoice = created?.[0];
      if (!newInvoice) throw new Error("Création facture échouée");

      // Copier les lignes
      const quoteLines = await sb.select(token, "document_lines", {
        filter: `document_type=eq.quote&document_id=eq.${q.id}`,
        order: "sort_order.asc"
      });
      if (quoteLines && quoteLines.length > 0) {
        const invoiceLines = quoteLines.map((l, idx) => ({
          company_id: company.id,
          document_type: "invoice",
          document_id: newInvoice.id,
          sort_order: idx,
          description: l.description,
          quantity: l.quantity,
          unit: l.unit,
          unit_price_ht_cents: l.unit_price_ht_cents,
          vat_rate: l.vat_rate,
          discount_pct: l.discount_pct,
          line_ht_cents: l.line_ht_cents,
          line_vat_cents: l.line_vat_cents,
          line_ttc_cents: l.line_ttc_cents
        }));
        await sb.insert(token, "document_lines", invoiceLines);
      }

      // Marquer le devis comme converti
      await sb.update(token, "quotes", `id=eq.${q.id}`, {
        status: "converted",
        converted_invoice_id: newInvoice.id
      });
      await refreshQuotes();
      capture("quote_converted", { quote_id: q.id, invoice_id: newInvoice.id });
      showToast(`Facture ${newInvoice.number} créée !`);
      setPendingConvert(null);
    } catch (e) {
      showToast(e.message || "Erreur conversion", "error");
    }
    setActionLoading(null);
  }

  async function deleteQuote(id) {
    try {
      await sb.delete(token, "document_lines", `document_type=eq.quote&document_id=eq.${id}`);
      await sb.delete(token, "quotes", `id=eq.${id}`);
      setQuotes((prev) => prev.filter((q) => q.id !== id));
      setPendingDelete(null);
      showToast("Devis supprimé");
    } catch (e) {
      showToast(e.message || "Erreur suppression", "error");
    }
  }

  // ─── Rendu d'une ligne devis (utilise dans le tableau groupe) ─────
  function renderQuoteRow(q, opts = {}) {
    const { isLatest = true, hasMultipleVersions = false, isExpanded = false, totalVersions = 1, onToggleExpand, isChild = false } = opts;
    const expired = isQuoteExpired(q);
    const effectiveStatus = expired ? "expired" : q.status;
    const badge = quoteStatusBadge(effectiveStatus);
    const validity = q.expires_at ? daysUntil(q.expires_at) : null;
    const canEdit = !["signed", "converted", "refused"].includes(q.status);
    const canSend = ["draft", "sent"].includes(q.status);
    // Conversion possible dès le brouillon (à condition de ne pas déjà être converti ou refusé)
    const canConvert = !["converted", "refused"].includes(q.status) && !q.converted_invoice_id;
    const canDelete = q.status === "draft";
    const canVersion = !["converted", "refused"].includes(q.status);
    const version = q.version || 1;

    return (
      <tr key={q.id} style={isChild ? { background: "rgba(212,168,67,0.04)" } : null}>
        {/* Colonne expand : chevron si latest avec versions multiples, ⤷ si enfant */}
        <td style={{ textAlign: "center", width: 30 }}>
          {isLatest && hasMultipleVersions ? (
            <button
              onClick={onToggleExpand}
              style={{
                background: "transparent", border: "none", cursor: "pointer",
                color: "var(--gold)", fontSize: 12, padding: 4
              }}
              title={isExpanded ? "Masquer les versions" : `Voir les ${totalVersions} versions`}
            >
              {isExpanded ? "▼" : "▶"}
            </button>
          ) : isChild ? (
            <span style={{ color: "var(--muted)", fontSize: 12, paddingLeft: 12 }}>⤷</span>
          ) : null}
        </td>
        <td className="mono" style={isChild ? { paddingLeft: 22, fontSize: 11, color: "var(--muted2)" } : null}>
          {q.number || <span style={{ color: "var(--muted)" }}>—</span>}
          {hasMultipleVersions && isLatest && (
            <span style={{ marginLeft: 8, fontSize: 10, color: "var(--gold)", fontWeight: 600 }}>
              v{version}{totalVersions > 1 ? ` (sur ${totalVersions})` : ""}
            </span>
          )}
          {isChild && (
            <span style={{ marginLeft: 8, fontSize: 10, color: "var(--muted)" }}>
              v{version}
            </span>
          )}
        </td>
        <td style={isChild ? { fontSize: 11, color: "var(--muted2)" } : null}>
          {snapshotDisplayName(q.client_snapshot)}
        </td>
        <td style={isChild ? { fontSize: 11, color: "var(--muted2)" } : null}>{fmtDate(q.issue_date)}</td>
        <td style={{ fontSize: 12, color: q.status === "sent" && validity !== null && validity < 7 ? "var(--orange)" : "var(--muted2)" }}>
          {q.expires_at ? (
            validity > 0 ? `${validity} j` : validity === 0 ? "Aujourd'hui" : "Expiré"
          ) : "—"}
        </td>
        <td className="mono" style={{ textAlign: "right", ...(isChild ? { fontSize: 11, color: "var(--muted2)" } : {}) }}>
          {fmtEUR(q.total_ttc_cents)}
        </td>
        <td><span className={"badge " + badge.cls}>{badge.label}</span></td>
        <td>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "nowrap" }}>
            {/* Bouton principal : Voir / Modifier */}
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setEditModal(q)}
              style={{ padding: "5px 12px", fontSize: 11, whiteSpace: "nowrap" }}
              title={canEdit ? "Modifier ce devis" : "Voir le devis"}
            >
              {canEdit ? "✏️ Modifier" : "👁 Voir"}
            </button>

            {/* Action contextuelle principale selon le statut */}
            {canSend && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => sendQuote(q)}
                disabled={actionLoading === `send-${q.id}`}
                style={{ padding: "5px 10px", fontSize: 11, color: "var(--gold)", borderColor: "rgba(212,168,67,0.4)", whiteSpace: "nowrap" }}
                title="Envoyer le devis par email au client"
              >
                {actionLoading === `send-${q.id}` ? "⏳" : "📧 Envoyer"}
              </button>
            )}
            {canConvert && !canSend && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setPendingConvert(q)}
                disabled={actionLoading === `convert-${q.id}`}
                style={{ padding: "5px 10px", fontSize: 11, color: "var(--green)", borderColor: "rgba(62,207,122,0.4)", whiteSpace: "nowrap" }}
                title="Convertir ce devis en facture"
              >
                🧾 Facturer
              </button>
            )}

            {/* Menu kebab pour actions secondaires */}
            <div style={{ position: "relative" }}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenuId(openMenuId === q.id ? null : q.id);
                }}
                style={{ padding: "5px 8px", fontSize: 14, lineHeight: 1 }}
                title="Plus d'actions"
              >
                ⋯
              </button>
              {openMenuId === q.id && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: "absolute",
                    right: 0,
                    top: "100%",
                    marginTop: 4,
                    background: "var(--card)",
                    border: "1px solid var(--border2)",
                    borderRadius: 8,
                    boxShadow: "0 10px 30px rgba(0,0,0,0.4)",
                    minWidth: 180,
                    zIndex: 100,
                    overflow: "hidden"
                  }}
                >
                  <MenuItem onClick={() => { previewPdf(q); setOpenMenuId(null); }}>
                    📄 Aperçu PDF
                  </MenuItem>
                  <MenuItem onClick={() => { shareLink(q); setOpenMenuId(null); }}>
                    🔗 Copier le lien public
                  </MenuItem>
                  {canConvert && canSend && (
                    <MenuItem
                      onClick={() => { setPendingConvert(q); setOpenMenuId(null); }}
                      style={{ color: "var(--green)" }}
                    >
                      🧾 Convertir en facture
                    </MenuItem>
                  )}
                  {canSend && !canConvert && (
                    // déjà visible en bouton principal, pas de doublon
                    null
                  )}
                  {canVersion && (
                    <MenuItem onClick={() => { createVersion(q); setOpenMenuId(null); }}>
                      ↪️ Créer une nouvelle version (v{version + 1})
                    </MenuItem>
                  )}
                  {canDelete && (
                    <>
                      <div style={{ height: 1, background: "var(--border2)", margin: "4px 0" }} />
                      <MenuItem
                        onClick={() => { setPendingDelete({ id: q.id, label: q.number || "ce devis" }); setOpenMenuId(null); }}
                        style={{ color: "var(--red)" }}
                      >
                        🗑 Supprimer
                      </MenuItem>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">DEVIS</div>
          <div className="page-sub">
            {quotes.length} devis · {fmtEUR(totalPending)} en attente de signature
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setEditModal("new")}>
          <Icon name="plus" size={14} /> Nouveau devis
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
          {Object.entries(QUOTE_STATUSES)
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
          <div style={{ fontSize: 40, marginBottom: 14 }}>📄</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
            {search || statusFilter !== "all" ? "Aucun devis ne correspond" : "Aucun devis pour l'instant"}
          </div>
          {search || statusFilter !== "all" ? (
            <button className="btn btn-ghost" onClick={() => { setSearch(""); setStatusFilter("all"); }}>
              Effacer les filtres
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => setEditModal("new")}>
              <Icon name="plus" size={14} /> Créer un devis
            </button>
          )}
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 30 }}></th>
                <th>N°</th>
                <th>Client</th>
                <th>Émis le</th>
                <th>Validité</th>
                <th style={{ textAlign: "right" }}>Montant TTC</th>
                <th>Statut</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map((group) => {
                const { rootId, latest, versions, hasMultipleVersions } = group;
                const isExpanded = expandedRoots.has(rootId);
                const rows = [];

                // ─── Ligne principale (derniere version) ─────
                rows.push(renderQuoteRow(latest, {
                  isLatest: true,
                  hasMultipleVersions,
                  isExpanded,
                  totalVersions: versions.length,
                  onToggleExpand: () => toggleExpand(rootId)
                }));

                // ─── Lignes des versions precedentes (si deplie) ─────
                if (isExpanded && hasMultipleVersions) {
                  for (let i = 1; i < versions.length; i++) {
                    rows.push(renderQuoteRow(versions[i], { isLatest: false, isChild: true }));
                  }
                }

                return rows;
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Fonction de rendu d'une ligne devis (definie inline pour acceder au closure) */}
      {/* On stocke pas la fonction, on l'inline ici via renderQuoteRow definie en dessous */}

      {/* ─── Modale d'édition ─── */}
      {editModal && (
        <QuoteEditorModal
          token={token}
          company={company}
          quote={editModal === "new" ? null : editModal}
          onClose={() => setEditModal(null)}
          onSaved={onSavedFromModal}
        />
      )}

      {/* ─── Confirmation suppression ─── */}
      {pendingDelete && (
        <ConfirmModal
          title="Supprimer ce devis ?"
          message={`Cette action est irréversible. Le devis ${pendingDelete.label} et toutes ses lignes seront supprimés.`}
          confirmLabel="Supprimer"
          confirmType="danger"
          onConfirm={() => deleteQuote(pendingDelete.id)}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {/* ─── Confirmation conversion en facture ─── */}
      {pendingConvert && (
        <ConfirmModal
          title="Convertir en facture ?"
          message={`Une nouvelle facture sera créée à partir du devis ${pendingConvert.number} avec les mêmes lignes. Le devis passera au statut "converti".`}
          confirmLabel="Créer la facture"
          confirmType="primary"
          onConfirm={() => convertToInvoice(pendingConvert)}
          onCancel={() => setPendingConvert(null)}
        />
      )}

      {/* ─── Apercu PDF en modale (pattern IOcar PrintDoc) ─── */}
      {previewQuote && (
        <DocumentPreviewModal
          token={token}
          docType="quote"
          doc={previewQuote}
          onClose={() => setPreviewQuote(null)}
        />
      )}

      {/* ─── Toast ─── */}
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

// ─── Composant MenuItem reutilisable (pour le menu kebab des actions) ───
function MenuItem({ children, onClick, style = {} }) {
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
