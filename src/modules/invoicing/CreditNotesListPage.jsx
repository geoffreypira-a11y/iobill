import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { sourceAppLabel, sourceAppEmoji } from "../../lib/sourceApps.js";
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
  // v8.193 — État de la transmission PDP, comme sur la page Factures.
  // Le bouton « Transmettre » s'affichait ici quelle que soit la
  // configuration : le serveur refusait bien (paSendCreditNote renvoie un 403
  // « Transmission PDP désactivée »), mais on proposait une action vouée à
  // l'échec. En cas d'échec de lecture on reste à true, donc au comportement
  // d'avant.
  const [pdpConfigured, setPdpConfigured] = useState(true);
  const [transmissionEnabled, setTransmissionEnabled] = useState(true);
  const [toast, setToast] = useState(null);

  function showToast(msg, type = "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/admin", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: "pa_config" })
        });
        const j = await r.json().catch(() => ({}));
        const cfg = j.config || j;
        if (alive && cfg) {
          setPdpConfigured(!!cfg.configured);
          setTransmissionEnabled(cfg.transmission_enabled !== false);
        }
      } catch (_) { /* on garde true */ }
    })();
    return () => { alive = false; };
  }, [token, company?.id]);

  // v8.194 — Statut PDP des avoirs transmis.
  //
  // Un avoir n'est pas payé par l'acheteur : seul compte « accepté ou rejeté ».
  // Jusqu'ici la pastille affichait « ✓ Transmis » même pour un avoir refusé
  // en fr:213 — autrement dit l'inverse de la réalité, sur un document dont
  // dépend une récupération de TVA.
  //
  // On interroge UNE SEULE FOIS par montage, et seulement les avoirs transmis
  // dont le statut n'est pas encore terminal. Pas de boucle : le polling
  // automatique des factures a été coupé en v8.57.6 parce qu'il réveillait le
  // Realtime, qui refetchait la liste et écrasait l'état des boutons. On ne
  // réintroduit pas ce défaut.
  const statutsDemandes = React.useRef(new Set());

  async function rafraichirStatutPdp(cn, { silencieux = true } = {}) {
    try {
      const r = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "pa_status", payload: { credit_note_id: cn.id } })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (!silencieux) showToast(j.error || `Erreur ${r.status}`, "error");
        return;
      }
      const nouveau = j.facturx_status;
      if (nouveau && nouveau !== cn.facturx_status) {
        setItems(prev => prev.map(x => x.id === cn.id ? { ...x, facturx_status: nouveau } : x));
      }
      if (!silencieux) {
        showToast(nouveau === "rejected"
          ? "Avoir refusé par la plateforme"
          : "Statut à jour : " + (nouveau || "transmis"),
          nouveau === "rejected" ? "error" : "success");
      }
    } catch (_) { if (!silencieux) showToast("Statut indisponible", "error"); }
  }

  useEffect(() => {
    // Borné aux 10 plus récents : chaque vérification interroge la plateforme,
    // et un abonné qui aurait cinquante avoirs en attente déclencherait
    // cinquante appels au simple affichage de la page. Les plus anciens
    // restent vérifiables d'un clic sur leur pastille.
    let restants = 10;
    for (const c of items) {
      if (restants <= 0) break;
      const terminal = c.facturx_status === "rejected" || c.facturx_status === "accepted";
      if (!c.pdp_transmitted_at || terminal) continue;
      if (statutsDemandes.current.has(c.id)) continue;
      statutsDemandes.current.add(c.id);
      restants -= 1;
      rafraichirStatutPdp(c);
    }
  }, [items]);

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
      // v8.182 — On appelait generate-facturx avec `transmit_pdp`, chemin
      // neutralisé en v8.47.1 qui répond 410 : la transmission échouait à tous
      // les coups. Elle passe désormais par la Plateforme Agréée réelle, comme
      // les factures.
      const r = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "pa_send_credit_note", payload: { credit_note_id: cn.id } })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Erreur ${r.status}`);
      await refreshList();
      showToast(`Avoir transmis à la Plateforme Agréée (ID : ${j.pa_document_id || "?"})`);
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
                // v8.49.10 — Badge "<icône> IO CAR" sur les avoirs venus d'une app source externe.
                // Cohérent avec l'affichage des factures externes dans InvoicesListPage.
                const isExternal = !!c.external_source && c.external_source !== "iobill";
                const sourceLabel = sourceAppLabel(c.external_source)
                                  || String(c.external_source || "").toUpperCase();
                return (
                  <tr key={c.id} onClick={() => navigate(`/credit-notes/${c.id}`)} style={{ cursor: "pointer" }}>
                    <td className="mono">
                      {c.number}
                      {isExternal && (
                        <span style={{
                          marginLeft: 6,
                          fontSize: 9,
                          padding: "1px 6px",
                          borderRadius: 8,
                          background: "rgba(212,168,67,0.15)",
                          color: "var(--gold, #d4a843)",
                          fontWeight: 700,
                          letterSpacing: 0.5
                        }}>
                          {sourceAppEmoji(c.external_source)} {sourceLabel}
                        </span>
                      )}
                    </td>
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
                        {/* v8.42 — Transmettre à la DGFiP via PDP (uniquement si émis et pas encore transmis)
                            v8.193 — …et seulement si la transmission est ouverte. */}
                        {c.status === "issued" && !c.pdp_transmitted_at && pdpConfigured && transmissionEnabled && (
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
                        {/* v8.193 — Sans cette mention, l'absence de bouton
                            ressemblait à un bug. L'avoir est bien émis et sa
                            Factur-X générée : seule la télétransmission est
                            fermée côté administrateur. */}
                        {c.status === "issued" && !c.pdp_transmitted_at && (!pdpConfigured || !transmissionEnabled) && (
                          <span
                            style={{ padding: "5px 10px", fontSize: 10, color: "var(--muted)", border: "1px dashed var(--border2, rgba(255,255,255,0.15))", borderRadius: 6, whiteSpace: "nowrap" }}
                            title={pdpConfigured
                              ? "La transmission à la Plateforme Agréée n'est pas activée pour cette entreprise. L'avoir reste valable et sa Factur-X est bien générée."
                              : "Aucune Plateforme Agréée n'est configurée pour cette entreprise."}
                          >
                            🏛️ Transmission désactivée
                          </span>
                        )}
                        {c.pdp_transmitted_at && (() => {
                          // v8.194 — La pastille dit ce que la plateforme a
                          // réellement répondu. « ✓ Transmis » sur un avoir
                          // refusé affirmait le contraire de la vérité.
                          const refuse = c.facturx_status === "rejected";
                          const quand = new Date(c.pdp_transmitted_at).toLocaleDateString("fr-FR");
                          const via = c.pdp_provider || "PDP";
                          return (
                          <span
                            onClick={(e) => { e.stopPropagation(); rafraichirStatutPdp(c, { silencieux: false }); }}
                            style={{
                              padding: "5px 10px", fontSize: 10, cursor: "pointer",
                              color: refuse ? "var(--red, #e54949)" : "var(--green)",
                              border: `1px solid ${refuse ? "rgba(229,73,73,0.4)" : "rgba(62,207,122,0.3)"}`,
                              borderRadius: 6, whiteSpace: "nowrap"
                            }}
                            title={refuse
                              ? `Refusé par ${via}. L'avoir n'est PAS parvenu à l'administration : la rectification de TVA n'est pas prise en compte. Cliquer pour revérifier.`
                              : `Transmis via ${via} le ${quand}. Cliquer pour revérifier le statut.`}
                          >
                            {refuse ? "❌ Refusé" : "✓ Transmis"}
                          </span>
                          );
                        })()}
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
      // v8.49.10 — On EXCLUT les factures externes (IOCAR, IOBTP...). Un avoir
      // sur une facture externe doit être créé dans l'app source (bouton ↩️ IOCAR)
      // puis synchronisé vers IOBILL via push_credit_note. Sinon on aurait 2
      // sources de vérité pour la même annulation → risque de double
      // comptabilisation TVA.
      const list = await sb.select(token, "invoices", {
        filter: `company_id=eq.${company.id}&status=in.(issued,sent,partial,paid,overdue)&external_source=is.null`,
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
