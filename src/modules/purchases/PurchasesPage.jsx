import React, { useEffect, useMemo, useState } from "react";
import { sb } from "../../lib/supabase.js";
import { subscribe } from "../../lib/realtime.js";
import { Icon } from "../../components/Icon.jsx";
import { CameraCapture } from "../../components/CameraCapture.jsx";
import { fmtEUR, fmtDate, todayISO, toCents, fromCents, uid } from "../../lib/helpers.js";
import { capture, bumpModuleUsage } from "../../lib/telemetry.js";

const PURCHASE_STATUTS = {
  pending:   { label: "En attente",        cls: "badge-muted",  icon: "📥" },
  validated: { label: "Validée",           cls: "badge-gold",   icon: "✅" },
  partial:   { label: "Partiellement payée", cls: "badge-gold", icon: "💸" },
  paid:      { label: "Payée",             cls: "badge-green",  icon: "💰" },
  archived:  { label: "Archivée",          cls: "badge-muted",  icon: "📦" }
};

const ACCOUNTING_CODES = [
  { code: "606300", label: "Petites fournitures" },
  { code: "606400", label: "Fournitures administratives" },
  { code: "611000", label: "Sous-traitance" },
  { code: "613200", label: "Locations immobilières" },
  { code: "613300", label: "Hébergement web / cloud" },
  { code: "613500", label: "Locations mobilières" },
  { code: "615000", label: "Entretien et réparations" },
  { code: "616000", label: "Primes d'assurances" },
  { code: "618000", label: "Documentation, formation" },
  { code: "622600", label: "Honoraires" },
  { code: "623000", label: "Publicité, communication" },
  { code: "624000", label: "Transports" },
  { code: "625100", label: "Voyages, déplacements" },
  { code: "626000", label: "Frais postaux, télécoms" },
  { code: "627000", label: "Services bancaires" }
];

export function PurchasesPage({ token, company }) {
  const [purchases, setPurchases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);   // PDF viewer modal
  const [partialFor, setPartialFor] = useState(null); // Modal paiement partiel
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("active"); // "active" | "all" | <status>
  const [openMenu, setOpenMenu] = useState(null); // id row pour le menu kebab
  const [menuPos, setMenuPos] = useState(null);
  const [actionLoading, setActionLoading] = useState(null); // id en cours d'action
  const [toast, setToast] = useState(null);

  // ── Refresh smart ──
  async function refreshPurchases(silent = false) {
    if (!silent) setLoading(true);
    const list = await sb.select(token, "purchases", {
      filter: `company_id=eq.${company.id}`,
      order: "issue_date.desc.nullslast"
    });
    const newList = list || [];
    if (silent) {
      setPurchases((prev) => {
        if (prev.length !== newList.length) return newList;
        for (let i = 0; i < newList.length; i++) {
          if (prev[i]?.id !== newList[i].id) return newList;
          if (prev[i]?.status !== newList[i].status) return newList;
          if (prev[i]?.paid_cents !== newList[i].paid_cents) return newList;
        }
        return prev;
      });
    } else {
      setPurchases(newList);
      setLoading(false);
    }
  }

  useEffect(() => {
    let alive = true;
    let timer = null;
    refreshPurchases(false);
    const unsubscribe = subscribe(token, "purchases", `company_id=eq.${company.id}`,
      () => { if (alive) refreshPurchases(true); });
    timer = setInterval(() => { if (alive) refreshPurchases(true); }, 60000);
    function onVisibility() {
      if (alive && document.visibilityState === "visible") refreshPurchases(true);
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [token, company.id]);

  // ── Toast helper ──
  function showToast(msg, type = "success") {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2500);
  }

  // ── Filtrage ──
  const filtered = useMemo(() => purchases.filter((p) => {
    const s = search.toLowerCase().trim();
    const matchS = !s || (p.vendor_name || "").toLowerCase().includes(s) || (p.number || "").toLowerCase().includes(s);
    let matchF = true;
    if (statusFilter === "all") matchF = true;
    else if (statusFilter === "active") matchF = ["pending", "validated", "partial"].includes(p.status);
    else matchF = p.status === statusFilter;
    return matchS && matchF;
  }), [purchases, search, statusFilter]);

  // ── Stats header ──
  const totalHT = useMemo(() => purchases
    .filter((p) => ["validated", "paid", "partial", "pending"].includes(p.status))
    .reduce((s, p) => s + (p.subtotal_ht_cents || 0), 0), [purchases]);
  const totalVAT = useMemo(() => purchases
    .filter((p) => ["validated", "paid", "partial"].includes(p.status))
    .reduce((s, p) => s + (p.vat_total_cents || 0), 0), [purchases]);

  // ── Actions rapides sur ligne ──
  async function quickSetStatus(p, newStatus) {
    setActionLoading(p.id);
    const updates = { status: newStatus, updated_at: new Date().toISOString() };
    if (newStatus === "paid") {
      updates.paid_at = todayISO();
      updates.paid_cents = p.total_ttc_cents || 0;
    } else if (newStatus === "pending") {
      updates.paid_at = null;
      updates.paid_cents = 0;
    }
    const r = await sb.update(token, "purchases", `id=eq.${p.id}`, updates);
    if (r && r[0]) {
      // Mise a jour optimiste du state local (le Realtime confirmera)
      setPurchases((prev) => prev.map((x) => x.id === p.id ? { ...x, ...r[0] } : x));
      showToast(`Achat ${newStatus === "paid" ? "marqué payé" : "remis en attente"} ✓`);
      capture("purchase_status_changed", { from: p.status, to: newStatus });
    } else {
      showToast("Erreur mise à jour", "error");
    }
    setActionLoading(null);
  }

  async function deletePurchase(p) {
    setActionLoading(p.id);
    const r = await sb.delete(token, "purchases", `id=eq.${p.id}`);
    if (r !== null) {
      // Mise a jour optimiste du state local (le Realtime fera le reste)
      setPurchases((prev) => prev.filter((x) => x.id !== p.id));
      showToast("Achat supprimé");
      capture("purchase_deleted");
    } else {
      showToast("Erreur suppression", "error");
    }
    setActionLoading(null);
    setConfirmDelete(null);
  }

  // ── Menu kebab : position fixed (anti overflow) ──
  function openKebab(e, p) {
    e.stopPropagation();
    if (openMenu === p.id) {
      setOpenMenu(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    setMenuPos({
      top: rect.bottom + window.scrollY + 4,
      left: Math.max(12, rect.right - 200 + window.scrollX)
    });
    setOpenMenu(p.id);
  }

  useEffect(() => {
    if (!openMenu) return;
    function close() { setOpenMenu(null); }
    const t = setTimeout(() => {
      document.addEventListener("mousedown", close);
      window.addEventListener("scroll", close, true);
      window.addEventListener("resize", close);
    }, 50);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [openMenu]);

  // ── PDF viewer : signed URL ──
  async function viewDocument(p) {
    if (!p.file_url) {
      showToast("Aucun document scanné pour cet achat — utilisez Modifier pour en attacher un", "error");
      return;
    }
    console.log("[viewDocument] file_url:", p.file_url, "mime:", p.file_mime);
    const signed = await sb.getSignedUrl(token, "purchases-attach", p.file_url, 600);
    console.log("[viewDocument] signed URL:", signed);
    if (signed) {
      setViewing({ url: signed, purchase: p });
    } else {
      showToast("Impossible d'accéder au document (fichier introuvable ou supprimé)", "error");
    }
  }

  // Compteurs pour les tabs
  const counts = useMemo(() => ({
    all: purchases.length,
    active: purchases.filter((p) => ["pending", "validated", "partial"].includes(p.status)).length,
    pending: purchases.filter((p) => p.status === "pending").length,
    partial: purchases.filter((p) => p.status === "partial").length,
    paid: purchases.filter((p) => p.status === "paid").length
  }), [purchases]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">ACHATS</div>
          <div className="page-sub">
            {purchases.length} facture{purchases.length !== 1 ? "s" : ""} fournisseur · Total HT : <span className="mono" style={{ color: "var(--gold)" }}>{fmtEUR(totalHT)}</span> · TVA déductible : <span className="mono">{fmtEUR(totalVAT)}</span>
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing("add")}>
          <Icon name="plus" size={14} /> Nouvel achat
        </button>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap", alignItems: "center" }}>
        <input
          className="search-input"
          placeholder="Rechercher fournisseur, numéro..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="tabs" style={{ margin: 0 }}>
          <button
            className={"tab" + (statusFilter === "all" ? " active" : "")}
            onClick={() => setStatusFilter("all")}
          >
            Tous ({counts.all})
          </button>
          <button
            className={"tab" + (statusFilter === "active" ? " active" : "")}
            onClick={() => setStatusFilter("active")}
            title="Factures en cours (en attente, validées, partiellement payées)"
          >
            ⏳ En cours ({counts.active})
          </button>
          {counts.partial > 0 && (
            <button
              className={"tab" + (statusFilter === "partial" ? " active" : "")}
              onClick={() => setStatusFilter("partial")}
            >
              💸 Partielle ({counts.partial})
            </button>
          )}
          {counts.paid > 0 && (
            <button
              className={"tab" + (statusFilter === "paid" ? " active" : "")}
              onClick={() => setStatusFilter("paid")}
            >
              💰 Payée ({counts.paid})
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: 60, color: "var(--muted)" }}>Chargement...</div>
      ) : filtered.length === 0 ? (
        <div className="card card-pad" style={{ textAlign: "center", padding: "60px 20px" }}>
          {purchases.length === 0 ? (
            <>
              <div style={{ fontSize: 44, marginBottom: 14 }}>🛒</div>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Aucun achat enregistré</div>
              <div style={{ fontSize: 13, color: "var(--muted2)", marginBottom: 18 }}>
                Importez vos factures fournisseurs (PDF, photo) — l'OCR Mistral extrait les données automatiquement.
              </div>
              <button className="btn btn-primary" onClick={() => setEditing("add")}>
                <Icon name="upload" size={14} /> Importer un achat
              </button>
            </>
          ) : (
            <div style={{ color: "var(--muted2)", fontSize: 14 }}>Aucun achat ne correspond à votre recherche.</div>
          )}
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Fournisseur</th>
                <th>N° doc</th>
                <th>Catégorie</th>
                <th style={{ textAlign: "right" }}>HT</th>
                <th style={{ textAlign: "right" }}>TVA</th>
                <th style={{ textAlign: "right" }}>TTC</th>
                <th>Statut</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const isPaid = p.status === "paid";
                const isPending = p.status === "pending" || p.status === "validated";
                const isPartial = p.status === "partial";
                const remaining = (p.total_ttc_cents || 0) - (p.paid_cents || 0);
                return (
                  <tr key={p.id}>
                    <td>{fmtDate(p.issue_date)}</td>
                    <td>
                      {p.vendor_name}
                      {p.ocr_status === "done" && (
                        <span style={{ marginLeft: 6, fontSize: 9, color: "var(--green)" }} title="OCR validé">🤖</span>
                      )}
                    </td>
                    <td className="mono">{p.number || "—"}</td>
                    <td>
                      {p.accounting_code && <span className="mono" style={{ fontSize: 11 }}>{p.accounting_code}</span>}
                      {p.category && <span style={{ marginLeft: 6, fontSize: 11, color: "var(--muted)" }}>{p.category}</span>}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(p.subtotal_ht_cents)}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(p.vat_total_cents)}</td>
                    <td className="mono" style={{ textAlign: "right", fontWeight: 600 }}>
                      {fmtEUR(p.total_ttc_cents)}
                      {isPartial && (
                        <div style={{ fontSize: 9, color: "var(--gold)", marginTop: 2 }}>
                          Reste : {fmtEUR(remaining)}
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={"badge " + PURCHASE_STATUTS[p.status]?.cls}>
                        {PURCHASE_STATUTS[p.status]?.icon} {PURCHASE_STATUTS[p.status]?.label}
                      </span>
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                        {/* Voir : si fichier → modale viewer, sinon → ouvre l'editeur (consultation) */}
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => p.file_url ? viewDocument(p) : setEditing(p)}
                          style={{ padding: "5px 10px", fontSize: 11, whiteSpace: "nowrap" }}
                          title={p.file_url ? "Voir le document scanné" : "Voir les détails (aucun document attaché)"}
                        >
                          👁 Voir
                        </button>

                        {/* Action rapide : SEULEMENT pour les non payées (Payé sur 1 clic) */}
                        {(isPending || isPartial) && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => quickSetStatus(p, "paid")}
                            disabled={actionLoading === p.id}
                            style={{
                              padding: "5px 10px", fontSize: 11,
                              color: "var(--green)", borderColor: "rgba(62,207,122,0.4)",
                              whiteSpace: "nowrap"
                            }}
                            title="Marquer comme payée"
                          >
                            {actionLoading === p.id ? "⏳" : "💰 Payé"}
                          </button>
                        )}

                        {/* Kebab : toujours visible */}
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={(e) => openKebab(e, p)}
                          style={{ padding: "5px 8px", fontSize: 13 }}
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

      {/* ─── Menu kebab (position fixed) ─── */}
      {openMenu && menuPos && (() => {
        const p = purchases.find((x) => x.id === openMenu);
        if (!p) return null;
        return (
          <div
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              top: menuPos.top, left: menuPos.left,
              background: "var(--card)", border: "1px solid var(--border2)",
              borderRadius: 8, zIndex: 9999, minWidth: 200,
              boxShadow: "0 12px 32px rgba(0,0,0,0.6)",
              overflow: "hidden"
            }}
          >
            <KebabItem icon="✏️" label="Modifier" onClick={() => { setEditing(p); setOpenMenu(null); }} />
            {(p.status === "pending" || p.status === "validated" || p.status === "partial") && (
              <KebabItem icon="💸" label="Paiement partiel" onClick={() => { setPartialFor(p); setOpenMenu(null); }} />
            )}
            {p.status === "paid" && (
              <KebabItem icon="⏳" label="Remettre en attente" onClick={() => { quickSetStatus(p, "pending"); setOpenMenu(null); }} />
            )}
            <KebabItem icon="🗑️" label="Supprimer" danger onClick={() => { setConfirmDelete(p); setOpenMenu(null); }} />
          </div>
        );
      })()}

      {/* ─── Toast ─── */}
      {toast && (
        <div style={{
          position: "fixed", bottom: 24, right: 24, zIndex: 10000,
          padding: "10px 18px", borderRadius: 8,
          background: toast.type === "error" ? "rgba(255,82,82,0.95)" : "rgba(62,207,122,0.95)",
          color: "#0b0c10", fontSize: 13, fontWeight: 600,
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)"
        }}>
          {toast.msg}
        </div>
      )}

      {/* ─── Modale modification / création ─── */}
      {editing && (
        <PurchaseModal
          token={token}
          company={company}
          purchase={editing === "add" ? null : editing}
          onSave={(p) => {
            setEditing(null);
            setPurchases((arr) => {
              const exists = arr.find((x) => x.id === p.id);
              return exists ? arr.map((x) => (x.id === p.id ? p : x)) : [p, ...arr];
            });
          }}
          onDelete={(id) => {
            setEditing(null);
            setPurchases((arr) => arr.filter((x) => x.id !== id));
          }}
          onClose={() => setEditing(null)}
        />
      )}

      {/* ─── Modale PDF viewer ─── */}
      {viewing && (
        <PdfViewerModal
          url={viewing.url}
          purchase={viewing.purchase}
          onEdit={() => { setEditing(viewing.purchase); setViewing(null); }}
          onClose={() => setViewing(null)}
        />
      )}

      {/* ─── Modale paiement partiel ─── */}
      {partialFor && (
        <PartialPaymentModal
          token={token}
          purchase={partialFor}
          onClose={() => setPartialFor(null)}
          onSaved={() => {
            setPartialFor(null);
            showToast("Paiement enregistré ✓");
          }}
        />
      )}

      {/* ─── Confirmation suppression ─── */}
      {confirmDelete && (
        <div className="modal-bg" onClick={() => setConfirmDelete(null)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-hd">
              <div style={{ fontSize: 15, fontWeight: 600 }}>Supprimer cet achat ?</div>
              <button className="close-btn" onClick={() => setConfirmDelete(null)}>×</button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: "var(--muted2)", lineHeight: 1.6 }}>
                L'achat <strong>{confirmDelete.vendor_name}</strong>
                {confirmDelete.number ? ` (${confirmDelete.number})` : ""} de {fmtEUR(confirmDelete.total_ttc_cents)} sera supprimé définitivement.
              </p>
              <p style={{ fontSize: 12, color: "var(--orange)", marginTop: 10 }}>
                ⚠️ Cette action est irréversible. Le document attaché sera également supprimé.
              </p>
            </div>
            <div className="modal-foot">
              <button className="btn btn-ghost" onClick={() => setConfirmDelete(null)}>Annuler</button>
              <button
                className="btn btn-primary"
                onClick={() => deletePurchase(confirmDelete)}
                disabled={actionLoading === confirmDelete.id}
                style={{ background: "var(--red)", borderColor: "var(--red)", color: "#fff" }}
              >
                {actionLoading === confirmDelete.id ? "Suppression..." : "Supprimer"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Item menu kebab ─── */
function KebabItem({ icon, label, onClick, danger }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 10,
        width: "100%", padding: "10px 14px", border: "none",
        background: "transparent",
        color: danger ? "var(--red)" : "var(--text)",
        cursor: "pointer", fontSize: 12, textAlign: "left",
        fontFamily: "inherit",
        transition: "background 0.15s"
      }}
      onMouseEnter={(e) => e.currentTarget.style.background = "var(--card2)"}
      onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
    >
      <span style={{ fontSize: 14 }}>{icon}</span>
      {label}
    </button>
  );
}

/* ─── Modale viewer PDF ─── */
function PdfViewerModal({ url, purchase, onEdit, onClose }) {
  // Detection robuste : MIME en priorite, puis extension du file_url
  const mime = (purchase.file_mime || "").toLowerCase();
  const filePath = (purchase.file_url || "").toLowerCase();
  const ext = filePath.split(".").pop() || "";
  const imageMimes = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"];
  const imageExts = ["jpg", "jpeg", "png", "webp", "gif", "heic", "heif"];
  const isImage = imageMimes.some((m) => mime.startsWith(m)) || imageExts.includes(ext);
  const isPdf = mime === "application/pdf" || ext === "pdf";
  // Si on ne sait pas, on tente d'abord image (plus tolerant que iframe)
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 900, width: "92vw", height: "85vh", display: "flex", flexDirection: "column" }}>
        <div className="modal-hd">
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>
              {purchase.vendor_name}
              {purchase.number && <span style={{ color: "var(--muted)", fontWeight: 400, marginLeft: 8 }}>· {purchase.number}</span>}
            </div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
              {fmtDate(purchase.issue_date)} · {fmtEUR(purchase.total_ttc_cents)} TTC
              {(mime || ext) && (
                <span style={{ marginLeft: 8, color: "var(--muted2)" }}>· {mime || ext.toUpperCase()}</span>
              )}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={onEdit}
              style={{ padding: "5px 12px", fontSize: 11 }}
            >
              ✏️ Modifier
            </button>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost btn-sm"
              style={{ padding: "5px 12px", fontSize: 11, textDecoration: "none" }}
            >
              ⬇ Télécharger
            </a>
            <button className="close-btn" onClick={onClose}>×</button>
          </div>
        </div>
        <div style={{ flex: 1, overflow: "hidden", background: "#1a1b22" }}>
          {isPdf ? (
            <iframe src={url} title={purchase.vendor_name} style={{ width: "100%", height: "100%", border: "none" }} />
          ) : isImage ? (
            <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto", padding: 16 }}>
              <img
                src={url}
                alt={purchase.vendor_name}
                style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 4 }}
                onError={(e) => {
                  // Si l'image ne charge pas, fallback en iframe (peut etre un PDF mal taggue)
                  e.currentTarget.style.display = "none";
                  const fallback = e.currentTarget.parentElement.querySelector(".pdf-fallback");
                  if (fallback) fallback.style.display = "block";
                }}
              />
              <iframe
                className="pdf-fallback"
                src={url}
                title={purchase.vendor_name}
                style={{ display: "none", width: "100%", height: "100%", border: "none" }}
              />
            </div>
          ) : (
            // Format inconnu : on essaye iframe en dernier recours, sinon message
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              <iframe
                src={url}
                title={purchase.vendor_name}
                style={{ flex: 1, width: "100%", border: "none" }}
              />
              <div style={{ padding: 10, textAlign: "center", fontSize: 11, color: "var(--muted)", background: "var(--card)" }}>
                Format non reconnu — utilisez "⬇ Télécharger" si l'aperçu ne fonctionne pas.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Modale paiement partiel ─── */
function PartialPaymentModal({ token, purchase, onClose, onSaved }) {
  const totalTtc = purchase.total_ttc_cents || 0;
  const alreadyPaid = purchase.paid_cents || 0;
  const remaining = totalTtc - alreadyPaid;
  const [amount, setAmount] = useState(fromCents(remaining).toFixed(2));
  const [paidAt, setPaidAt] = useState(todayISO());
  const [method, setMethod] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const amountCents = toCents(amount);
  const newTotal = alreadyPaid + amountCents;
  const newRemaining = totalTtc - newTotal;
  const willBeFullyPaid = newRemaining <= 0;

  async function save() {
    setErr("");
    if (!amount || amountCents <= 0) {
      setErr("Montant invalide");
      return;
    }
    if (newTotal > totalTtc) {
      setErr(`Le montant total (${fmtEUR(newTotal)}) dépasse le TTC de la facture (${fmtEUR(totalTtc)}).`);
      return;
    }
    setSaving(true);
    const newStatus = willBeFullyPaid ? "paid" : "partial";
    const updates = {
      paid_cents: newTotal,
      status: newStatus,
      payment_partial_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    if (willBeFullyPaid) {
      updates.paid_at = paidAt;
    }
    if (method) updates.payment_method = method;
    if (notes) {
      const existingNotes = purchase.notes || "";
      const sep = existingNotes ? "\n" : "";
      updates.notes = existingNotes + sep + `[${fmtDate(paidAt)}] Paiement ${fmtEUR(amountCents)}${method ? ` (${method})` : ""}${notes ? ` — ${notes}` : ""}`;
    }
    const r = await sb.update(token, "purchases", `id=eq.${purchase.id}`, updates);
    setSaving(false);
    if (r) {
      capture("purchase_partial_payment", { amount: amountCents, fully_paid: willBeFullyPaid });
      onSaved();
    } else {
      setErr("Erreur d'enregistrement");
    }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal modal-md" onClick={(e) => e.stopPropagation()}>
        <div className="modal-hd">
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>💸 Paiement partiel</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
              {purchase.vendor_name}
              {purchase.number && ` · ${purchase.number}`}
            </div>
          </div>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {/* Récap */}
          <div style={{
            background: "var(--card2)", padding: 14, borderRadius: 8,
            marginBottom: 18, fontSize: 12, lineHeight: 1.8
          }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--muted)" }}>Total TTC :</span>
              <span className="mono" style={{ fontWeight: 600 }}>{fmtEUR(totalTtc)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--muted)" }}>Déjà payé :</span>
              <span className="mono" style={{ color: "var(--green)" }}>{fmtEUR(alreadyPaid)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 6, marginTop: 4 }}>
              <span style={{ color: "var(--muted)" }}>Reste à payer :</span>
              <span className="mono" style={{ color: "var(--gold)", fontWeight: 600 }}>{fmtEUR(remaining)}</span>
            </div>
          </div>

          {err && <div className="auth-error" style={{ marginBottom: 14 }}>{err}</div>}

          <div className="form-row">
            <label className="form-label">Montant payé maintenant (€ TTC)</label>
            <input
              className="form-input mono"
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
          </div>

          <div className="form-row">
            <label className="form-label">Date du paiement</label>
            <input
              className="form-input"
              type="date"
              value={paidAt}
              onChange={(e) => setPaidAt(e.target.value)}
            />
          </div>

          <div className="form-row">
            <label className="form-label">Moyen de paiement (optionnel)</label>
            <input
              className="form-input"
              placeholder="Virement, CB, espèces..."
              value={method}
              onChange={(e) => setMethod(e.target.value)}
            />
          </div>

          <div className="form-row">
            <label className="form-label">Note (optionnel)</label>
            <input
              className="form-input"
              placeholder="Référence virement, n° chèque..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {/* Aperçu après paiement */}
          {amountCents > 0 && amountCents <= remaining && (
            <div style={{
              background: willBeFullyPaid ? "rgba(62,207,122,0.10)" : "rgba(212,168,67,0.10)",
              border: "1px solid " + (willBeFullyPaid ? "rgba(62,207,122,0.4)" : "rgba(212,168,67,0.4)"),
              padding: 12, borderRadius: 8, marginTop: 14, fontSize: 12, lineHeight: 1.6
            }}>
              {willBeFullyPaid ? (
                <>
                  ✅ <strong>Facture entièrement payée</strong> après ce paiement.
                  <br />Le statut passera en <strong style={{ color: "var(--green)" }}>Payée</strong>.
                </>
              ) : (
                <>
                  💸 Il restera <strong className="mono">{fmtEUR(newRemaining)}</strong> à payer après ce versement.
                  <br />Statut : <strong style={{ color: "var(--gold)" }}>Partiellement payée</strong>.
                </>
              )}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Annuler</button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !amount || amountCents <= 0}>
            {saving ? "Enregistrement..." : (willBeFullyPaid ? "💰 Marquer comme payée" : "💸 Enregistrer paiement")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Modal achat (avec upload + OCR) ──────────────────── */
function PurchaseModal({ token, company, purchase, onSave, onDelete, onClose }) {
  const isEdit = Boolean(purchase);
  const [data, setData] = useState({
    vendor_name: purchase?.vendor_name || "",
    vendor_siret: purchase?.vendor_siret || "",
    vendor_vat_number: purchase?.vendor_vat_number || "",
    number: purchase?.number || "",
    issue_date: purchase?.issue_date || todayISO(),
    due_date: purchase?.due_date || "",
    subtotal_ht: fromCents(purchase?.subtotal_ht_cents || 0).toFixed(2),
    vat_total: fromCents(purchase?.vat_total_cents || 0).toFixed(2),
    total_ttc: fromCents(purchase?.total_ttc_cents || 0).toFixed(2),
    category: purchase?.category || "",
    accounting_code: purchase?.accounting_code || "",
    status: purchase?.status || "pending",
    notes: purchase?.notes || ""
  });
  const [file, setFile] = useState(null);
  const [filePreviewUrl, setFilePreviewUrl] = useState(null);
  const [ocring, setOcring] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);

  function onCameraCapture(blob, dataUrl) {
    // On reconstruit un File avec un nom plausible pour l'OCR
    const fileName = `scan-${Date.now()}.jpg`;
    const f = new File([blob], fileName, { type: "image/jpeg" });
    setFile(f);
    setFilePreviewUrl(dataUrl);
    setCameraOpen(false);
  }

  function update(k, v) {
    const next = { ...data, [k]: v };
    // Auto-calcul TTC si HT et TVA bougent
    if (k === "subtotal_ht" || k === "vat_total") {
      const ht = parseFloat(k === "subtotal_ht" ? v : next.subtotal_ht) || 0;
      const tva = parseFloat(k === "vat_total" ? v : next.vat_total) || 0;
      next.total_ttc = (ht + tva).toFixed(2);
    }
    setData(next);
  }

  async function handleFile(f) {
    if (!f) return;
    setFile(f);
    setFilePreviewUrl(URL.createObjectURL(f));
  }

  async function runOCR() {
    if (!file) return;
    setOcring(true);
    setErr("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("company_id", company.id);
      const r = await fetch("/api/ocr-purchase", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // Message d'erreur cible selon le status code
        const msg = j.error || `Erreur OCR (${r.status})`;
        setErr(msg);
        setOcring(false);
        return;
      }
      // Pré-remplit le formulaire avec les données extraites
      const extracted = {};
      if (j.vendor_name) extracted.vendor_name = j.vendor_name;
      if (j.vendor_siret) extracted.vendor_siret = j.vendor_siret;
      if (j.vendor_vat_number) extracted.vendor_vat_number = j.vendor_vat_number;
      if (j.number) extracted.number = j.number;
      if (j.issue_date) extracted.issue_date = j.issue_date;
      if (j.subtotal_ht !== null && j.subtotal_ht !== undefined) extracted.subtotal_ht = Number(j.subtotal_ht).toFixed(2);
      if (j.vat_total !== null && j.vat_total !== undefined) extracted.vat_total = Number(j.vat_total).toFixed(2);
      if (j.total_ttc !== null && j.total_ttc !== undefined) extracted.total_ttc = Number(j.total_ttc).toFixed(2);
      if (j.category) extracted.category = j.category;
      if (j.accounting_code) extracted.accounting_code = j.accounting_code;

      setData((d) => ({ ...d, ...extracted }));

      // Compter combien de champs ont ete extraits avec succes
      const nbExtracted = Object.keys(extracted).length;
      if (nbExtracted === 0) {
        setErr("Aucune donnee extraite. Verifiez la qualite du document ou saisissez manuellement.");
      }
    } catch (e) {
      setErr("OCR : erreur reseau. Saisissez manuellement.");
    }
    setOcring(false);
  }

  async function save() {
    setErr("");
    if (!data.vendor_name.trim()) { setErr("Nom du fournisseur requis"); return; }
    setSaving(true);

    // 1. Si fichier, on upload vers Storage
    let fileUrl = purchase?.file_url || null;
    if (file) {
      const path = `${company.id}/${uid()}-${file.name}`;
      const uploaded = await sb.uploadFile(token, "purchases-attach", path, file);
      if (uploaded) fileUrl = path;
    }

    const payload = {
      vendor_name: data.vendor_name.trim(),
      vendor_siret: data.vendor_siret.trim() || null,
      vendor_vat_number: data.vendor_vat_number.trim() || null,
      number: data.number.trim() || null,
      issue_date: data.issue_date,
      due_date: data.due_date || null,
      subtotal_ht_cents: toCents(data.subtotal_ht),
      vat_total_cents: toCents(data.vat_total),
      total_ttc_cents: toCents(data.total_ttc),
      category: data.category || null,
      accounting_code: data.accounting_code || null,
      status: data.status,
      notes: data.notes || null,
      file_url: fileUrl,
      file_size: file?.size || purchase?.file_size,
      file_mime: file?.type || purchase?.file_mime,
      source: file && !purchase?.source ? "manual" : (purchase?.source || "manual"),
      ocr_status: purchase?.ocr_status || "pending"
    };

    let result;
    if (isEdit) {
      result = await sb.update(token, "purchases", `id=eq.${purchase.id}`, payload);
    } else {
      result = await sb.insert(token, "purchases", { ...payload, company_id: company.id });
    }
    setSaving(false);
    if (!result || !result[0]) { setErr("Erreur d'enregistrement"); return; }

    // Telemetrie
    if (!isEdit) {
      capture("purchase_added", {
        source: result[0].source || "manual",
        total_ttc: (result[0].total_ttc_cents || 0) / 100,
        ocr_status: result[0].ocr_status
      });
      bumpModuleUsage(token, company.id, "purchases");
    }
    onSave(result[0]);
  }

  async function del() {
    if (!confirm("Supprimer cet achat ?")) return;
    await sb.delete(token, "purchases", `id=eq.${purchase.id}`);
    onDelete(purchase.id);
  }

  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 720 }}>
        <div className="modal-hd">
          <div className="modal-title">{isEdit ? "Modifier l'achat" : "Nouvel achat fournisseur"}</div>
          <button className="close-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="modal-body">
          {err && <div className="auth-error" style={{ marginBottom: 14 }}>{err}</div>}

          {!isEdit && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--muted)", marginBottom: 8, fontWeight: 600 }}>
                Étape 1 — Importer le justificatif
              </div>
              <div
                style={{
                  border: "2px dashed var(--border)",
                  borderRadius: 10,
                  padding: filePreviewUrl ? 14 : 30,
                  textAlign: "center",
                  background: "rgba(212,168,67,0.04)",
                  cursor: "pointer",
                  transition: "all 0.15s"
                }}
                onClick={() => document.getElementById("purchase-file-input").click()}
                onDragOver={(e) => { e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}
              >
                {filePreviewUrl && file?.type?.startsWith("image/") ? (
                  <img src={filePreviewUrl} alt="" style={{ maxHeight: 140, borderRadius: 6 }} />
                ) : file ? (
                  <div style={{ fontSize: 13, color: "var(--gold)" }}>📄 {file.name} ({(file.size / 1024).toFixed(0)} Ko)</div>
                ) : (
                  <>
                    <Icon name="upload" size={28} />
                    <div style={{ fontSize: 13, marginTop: 8 }}>Glissez un PDF / une photo, ou cliquez</div>
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>PDF · JPG · PNG · HEIC</div>
                  </>
                )}
                <input
                  id="purchase-file-input"
                  type="file"
                  accept="application/pdf,image/*"
                  onChange={(e) => handleFile(e.target.files[0])}
                  style={{ display: "none" }}
                />
              </div>

              {/* Bouton camera mobile (mode terrain) */}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={(e) => { e.stopPropagation(); setCameraOpen(true); }}
                style={{ marginTop: 8, width: "100%" }}
              >
                📸 Scanner avec l'appareil photo
              </button>

              {file && (
                <button
                  className="btn btn-primary btn-sm"
                  onClick={runOCR}
                  disabled={ocring}
                  style={{ marginTop: 10 }}
                >
                  {ocring ? "Extraction en cours..." : "🤖 Extraire avec OCR Mistral"}
                </button>
              )}

              {cameraOpen && (
                <CameraCapture
                  onCapture={onCameraCapture}
                  onClose={() => setCameraOpen(false)}
                />
              )}
            </div>
          )}

          <div style={{ fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--muted)", marginBottom: 8, fontWeight: 600 }}>
            {isEdit ? "Informations" : "Étape 2 — Vérifier / Compléter"}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Fournisseur *" value={data.vendor_name} onChange={(v) => update("vendor_name", v)} />
            <Field label="N° de la facture" value={data.number} onChange={(v) => update("number", v)} />
            <Field label="SIRET fournisseur" value={data.vendor_siret} onChange={(v) => update("vendor_siret", v)} />
            <Field label="N° TVA fournisseur" value={data.vendor_vat_number} onChange={(v) => update("vendor_vat_number", v)} />
            <Field label="Date de facture" value={data.issue_date} onChange={(v) => update("issue_date", v)} type="date" />
            <Field label="Échéance paiement" value={data.due_date} onChange={(v) => update("due_date", v)} type="date" />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 4 }}>
            <Field label="Total HT" value={data.subtotal_ht} onChange={(v) => update("subtotal_ht", v)} type="number" step="0.01" />
            <Field label="TVA" value={data.vat_total} onChange={(v) => update("vat_total", v)} type="number" step="0.01" />
            <Field label="Total TTC" value={data.total_ttc} onChange={(v) => update("total_ttc", v)} type="number" step="0.01" />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <SelectField
              label="Compte comptable"
              value={data.accounting_code}
              onChange={(v) => update("accounting_code", v)}
              options={[{ value: "", label: "—" }, ...ACCOUNTING_CODES.map((c) => ({ value: c.code, label: `${c.code} · ${c.label}` }))]}
            />
            <Field label="Catégorie libre" value={data.category} onChange={(v) => update("category", v)} placeholder="Ex : OVH, café client..." />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
            <SelectField
              label="Statut"
              value={data.status}
              onChange={(v) => update("status", v)}
              options={Object.entries(PURCHASE_STATUTS).map(([k, s]) => ({ value: k, label: s.label }))}
            />
            <div className="form-row">
              <label className="form-label">Notes</label>
              <textarea className="form-input" value={data.notes} onChange={(e) => update("notes", e.target.value)} rows={2} style={{ resize: "vertical", fontFamily: "DM Sans, sans-serif" }} />
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 18, justifyContent: "space-between" }}>
            {isEdit && (
              <button className="btn btn-danger btn-sm" onClick={del}>
                <Icon name="trash" size={12} /> Supprimer
              </button>
            )}
            <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
              <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Annuler</button>
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? "Enregistrement..." : (isEdit ? "Mettre à jour" : "Enregistrer")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", placeholder, step }) {
  return (
    <div className="form-row">
      <label className="form-label">{label}</label>
      <input
        type={type}
        step={step}
        className={"form-input" + (type === "number" ? " mono" : "")}
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

function SelectField({ label, value, onChange, options }) {
  return (
    <div className="form-row">
      <label className="form-label">{label}</label>
      <select className="form-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
