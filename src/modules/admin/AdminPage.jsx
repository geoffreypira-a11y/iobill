import React, { useEffect, useState } from "react";
import { fmtEUR, fmtDate } from "../../lib/helpers.js";
import { AdminFirmsTab } from "./AdminFirmsTab.jsx";

/**
 * AdminPage — Panel admin IO BILL
 *
 * Réservé aux comptes is_admin. Onglets :
 *   1) Abonnés : liste + détail + archivage + suppression docs + export/backup
 *   2) Tickets : liste + filtres + édition statut/notes + suppression
 *
 * Inspiré du pattern IOCar.
 */
export function AdminPage({ token, company }) {
  const [tab, setTab] = useState("companies"); // "companies" | "firms" | "tickets"

  // Companies
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [expandedCompany, setExpandedCompany] = useState(null);
  const [companyData, setCompanyData] = useState(null);
  const [showArchiveModal, setShowArchiveModal] = useState(null); // companyId

  // Backup
  const [backupInfo, setBackupInfo] = useState(null);
  const [backupLoading, setBackupLoading] = useState(false);

  // Tickets
  const [tickets, setTickets] = useState([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [ticketStatusFilter, setTicketStatusFilter] = useState("all");
  const [ticketsCountNew, setTicketsCountNew] = useState(0);
  const [expandedTicket, setExpandedTicket] = useState(null);
  const [ticketEditNotes, setTicketEditNotes] = useState({});

  // ─── Helper : appel à l'API admin ─────────────────────────
  const adminCall = async (action, payload, opts = {}) => {
    const r = await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, payload })
    });
    if (opts.raw) return r;
    if (!r.ok) {
      let msg = `Erreur ${r.status}`;
      try { const j = await r.json(); msg = j.error || msg; } catch {}
      throw new Error(msg);
    }
    return r.json();
  };

  // ─── Chargement initial ───────────────────────────────────
  useEffect(() => {
    if (company?.is_admin !== true) {
      setLoading(false);
      return;
    }
    adminCall("list")
      .then(({ companies }) => { setCompanies(companies || []); setLoading(false); })
      .catch((e) => { console.error(e); setLoading(false); });
    adminCall("backup_info").then(({ backup }) => setBackupInfo(backup)).catch(() => {});
    adminCall("tickets_count_new").then(({ count }) => setTicketsCountNew(count || 0)).catch(() => {});
  }, [token, company?.is_admin]);

  useEffect(() => {
    if (tab !== "tickets") return;
    setTicketsLoading(true);
    const p = ticketStatusFilter === "all" ? {} : { status: ticketStatusFilter };
    adminCall("tickets_list", p)
      .then(({ tickets }) => { setTickets(tickets || []); setTicketsLoading(false); })
      .catch(() => { setTickets([]); setTicketsLoading(false); });
  }, [tab, ticketStatusFilter]);

  if (company?.is_admin !== true) {
    return (
      <div className="page">
        <div className="card card-pad" style={{ textAlign: "center", padding: 60 }}>
          <div style={{ fontSize: 40, marginBottom: 14 }}>🔒</div>
          <div>Réservé aux administrateurs IO BILL.</div>
        </div>
      </div>
    );
  }

  // ─── Actions companies ────────────────────────────────────
  async function loadCompanyData(companyId) {
    if (expandedCompany === companyId) { setExpandedCompany(null); setCompanyData(null); return; }
    setExpandedCompany(companyId);
    try {
      const { data } = await adminCall("company_data", { companyId });
      setCompanyData(data);
    } catch (e) {
      console.error(e);
      setCompanyData({});
    }
  }

  async function deleteDoc(table, id) {
    if (!confirm(`Supprimer DÉFINITIVEMENT cette entrée de ${table} ?\n\nCette action est irréversible.`)) return;
    try {
      await adminCall("delete_doc", { table, id });
      setCompanyData((prev) => ({ ...prev, [table]: (prev?.[table] || []).filter((x) => x.id !== id) }));
    } catch (e) { alert("Erreur : " + e.message); }
  }

  async function toggleActive(c) {
    try {
      await adminCall("toggle_active", { companyId: c.id, value: !c.is_active });
      setCompanies((prev) => prev.map((x) => x.id === c.id ? { ...x, is_active: !c.is_active } : x));
    } catch (e) { alert("Erreur : " + e.message); }
  }

  async function archiveCompany(companyId, reason) {
    try {
      await adminCall("archive_company", { companyId, reason });
      setCompanies((prev) => prev.map((x) => x.id === companyId
        ? { ...x, _archived: true, is_active: false, archive_date: new Date().toISOString(), archive_reason: reason }
        : x));
      setShowArchiveModal(null);
    } catch (e) { alert("Erreur : " + e.message); }
  }

  async function unarchiveCompany(companyId, reactivate) {
    if (!confirm(reactivate
      ? "Désarchiver ET réactiver ce compte ? L'abonné pourra à nouveau se connecter."
      : "Désarchiver ce compte ? L'abonné devra réactiver son abonnement Stripe pour se connecter."
    )) return;
    try {
      await adminCall("unarchive_company", { companyId, reactivate });
      setCompanies((prev) => prev.map((x) => x.id === companyId
        ? { ...x, _archived: false, is_active: !!reactivate, archive_date: null, archive_reason: null }
        : x));
    } catch (e) { alert("Erreur : " + e.message); }
  }

  async function deleteCompany(c) {
    const confirmText = c.legal_name || c.email || c.id;
    const typed = prompt(`⚠ SUPPRESSION DÉFINITIVE de "${confirmText}".\n\nToutes les données (factures, devis, avoirs, clients, achats) seront supprimées.\n\nTapez "SUPPRIMER" pour confirmer :`);
    if (typed !== "SUPPRIMER") return;
    try {
      await adminCall("delete_company", { companyId: c.id });
      setCompanies((prev) => prev.filter((x) => x.id !== c.id));
      if (expandedCompany === c.id) { setExpandedCompany(null); setCompanyData(null); }
    } catch (e) { alert("Erreur : " + e.message); }
  }

  async function exportCompany(c) {
    try {
      const data = await adminCall("export_company", { companyId: c.id });
      downloadJson(data, `iobill_${c.legal_name || c.id}_${new Date().toISOString().slice(0, 10)}.json`);
    } catch (e) { alert("Erreur : " + e.message); }
  }

  async function backupNow() {
    setBackupLoading(true);
    try {
      const res = await adminCall("backup_save");
      alert(`✅ Backup créé\n${res.filename}\n${res.total_companies} abonnés · ${res.size_kb} KB`);
      const { backup } = await adminCall("backup_info");
      setBackupInfo(backup);
    } catch (e) { alert("Erreur : " + e.message); }
    setBackupLoading(false);
  }

  async function backupDownload() {
    try {
      const r = await adminCall("backup_download", null, { raw: true });
      if (!r.ok) { alert("Aucun backup disponible"); return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `iobill_backup_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) { alert("Erreur : " + e.message); }
  }

  // ─── Actions tickets ──────────────────────────────────────
  async function updateTicket(ticketId, updates) {
    try {
      const { ticket } = await adminCall("tickets_update", { ticketId, ...updates });
      setTickets((prev) => prev.map((t) => t.id === ticketId ? { ...t, ...ticket } : t));
      adminCall("tickets_count_new").then(({ count }) => setTicketsCountNew(count || 0)).catch(() => {});
    } catch (e) { alert("Erreur : " + e.message); }
  }

  async function deleteTicket(ticketId) {
    if (!confirm("Supprimer définitivement ce ticket ?")) return;
    try {
      await adminCall("tickets_delete", { ticketId });
      setTickets((prev) => prev.filter((t) => t.id !== ticketId));
      if (expandedTicket === ticketId) setExpandedTicket(null);
      adminCall("tickets_count_new").then(({ count }) => setTicketsCountNew(count || 0)).catch(() => {});
    } catch (e) { alert("Erreur : " + e.message); }
  }

  async function purgeClosedTickets() {
    if (!confirm("Supprimer définitivement TOUS les tickets fermés ?")) return;
    try {
      const { deleted } = await adminCall("tickets_purge_closed");
      const p = ticketStatusFilter === "all" ? {} : { status: ticketStatusFilter };
      const { tickets: refreshed } = await adminCall("tickets_list", p);
      setTickets(refreshed || []);
      alert(`${deleted} ticket${deleted > 1 ? "s" : ""} supprimé${deleted > 1 ? "s" : ""}.`);
    } catch (e) { alert("Erreur : " + e.message); }
  }

  // ─── Rendu ────────────────────────────────────────────────
  const filteredCompanies = companies.filter((c) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (c.legal_name || "").toLowerCase().includes(s)
      || (c.email || "").toLowerCase().includes(s)
      || (c.siret || "").includes(s);
  });

  return (
    <div className="page">
      <div className="page-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div className="page-title">🛡 Dashboard Admin</div>
          <div className="page-sub">IO BILL — Vue globale des abonnés et tickets</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-ghost" onClick={backupNow} disabled={backupLoading}>
            {backupLoading ? "..." : "💾 Sauvegarder maintenant"}
          </button>
          {backupInfo && (
            <button className="btn btn-ghost" onClick={backupDownload}>
              ⬇ Dernier backup ({backupInfo.updated_at ? fmtDate(backupInfo.updated_at) : "?"})
            </button>
          )}
        </div>
      </div>

      <div className="tabs" style={{ marginBottom: 18, display: "flex", gap: 8 }}>
        <button
          className={"tab" + (tab === "companies" ? " active" : "")}
          onClick={() => setTab("companies")}
        >
          🏢 Abonnés ({companies.length})
        </button>
        <button
          className={"tab" + (tab === "firms" ? " active" : "")}
          onClick={() => setTab("firms")}
        >
          📋 Cabinets
        </button>
        <button
          className={"tab" + (tab === "tickets" ? " active" : "")}
          onClick={() => setTab("tickets")}
          style={{ position: "relative" }}
        >
          🎫 Tickets
          {ticketsCountNew > 0 && (
            <span style={{
              marginLeft: 8, background: "var(--red, #e0556a)", color: "white",
              borderRadius: 10, padding: "2px 7px", fontSize: 10, fontWeight: 600
            }}>
              {ticketsCountNew}
            </span>
          )}
        </button>
      </div>

      {/* ─── ONGLET ABONNÉS ─── */}
      {tab === "companies" && (
        <>
          <div style={{ marginBottom: 12 }}>
            <input
              type="text"
              className="form-input"
              placeholder="🔍 Rechercher (nom, email, SIRET)..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ maxWidth: 400 }}
            />
          </div>

          {loading ? (
            <div className="card card-pad" style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>Chargement...</div>
          ) : filteredCompanies.length === 0 ? (
            <div className="card card-pad" style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>Aucun abonné.</div>
          ) : (
            filteredCompanies.map((c) => (
              <CompanyCard
                key={c.id}
                c={c}
                expanded={expandedCompany === c.id}
                data={expandedCompany === c.id ? companyData : null}
                onToggle={() => loadCompanyData(c.id)}
                onToggleActive={() => toggleActive(c)}
                onArchive={() => setShowArchiveModal(c.id)}
                onUnarchive={(reactivate) => unarchiveCompany(c.id, reactivate)}
                onDelete={() => deleteCompany(c)}
                onExport={() => exportCompany(c)}
                onDeleteDoc={(table, id) => deleteDoc(table, id)}
              />
            ))
          )}
        </>
      )}

      {/* ─── ONGLET CABINETS (Mode Comptable) ─── */}
      {tab === "firms" && (
        <AdminFirmsTab token={token} />
      )}

      {/* ─── ONGLET TICKETS ─── */}
      {tab === "tickets" && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
            <button
              className={"btn " + (ticketStatusFilter === "all" ? "btn-gold" : "btn-ghost")}
              onClick={() => setTicketStatusFilter("all")}
            >Tous</button>
            <button
              className={"btn " + (ticketStatusFilter === "new" ? "btn-gold" : "btn-ghost")}
              onClick={() => setTicketStatusFilter("new")}
            >🔴 Nouveaux</button>
            <button
              className={"btn " + (ticketStatusFilter === "in_progress" ? "btn-gold" : "btn-ghost")}
              onClick={() => setTicketStatusFilter("in_progress")}
            >🟡 En cours</button>
            <button
              className={"btn " + (ticketStatusFilter === "resolved" ? "btn-gold" : "btn-ghost")}
              onClick={() => setTicketStatusFilter("resolved")}
            >🟢 Résolus</button>
            <button
              className={"btn " + (ticketStatusFilter === "closed" ? "btn-gold" : "btn-ghost")}
              onClick={() => setTicketStatusFilter("closed")}
            >⚫ Fermés</button>
            <div style={{ marginLeft: "auto" }}>
              <button className="btn btn-ghost" onClick={purgeClosedTickets} style={{ color: "var(--red, #e0556a)" }}>
                🗑 Purger les tickets fermés
              </button>
            </div>
          </div>

          {ticketsLoading ? (
            <div className="card card-pad" style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>Chargement...</div>
          ) : tickets.length === 0 ? (
            <div className="card card-pad" style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>
              <div style={{ fontSize: 30, marginBottom: 10 }}>🎫</div>
              Aucun ticket pour le moment
            </div>
          ) : (
            tickets.map((t) => (
              <TicketCard
                key={t.id}
                t={t}
                expanded={expandedTicket === t.id}
                editNotes={ticketEditNotes[t.id]}
                onToggle={() => setExpandedTicket(expandedTicket === t.id ? null : t.id)}
                onStatusChange={(s) => updateTicket(t.id, { status: s })}
                onNotesChange={(v) => setTicketEditNotes((p) => ({ ...p, [t.id]: v }))}
                onSaveNotes={() => updateTicket(t.id, { admin_notes: ticketEditNotes[t.id] ?? t.admin_notes ?? "" })}
                onDelete={() => deleteTicket(t.id)}
              />
            ))
          )}
        </>
      )}

      {/* ─── MODAL ARCHIVAGE ─── */}
      {showArchiveModal && (
        <ArchiveModal
          companyId={showArchiveModal}
          companyName={companies.find((c) => c.id === showArchiveModal)?.legal_name || ""}
          onClose={() => setShowArchiveModal(null)}
          onConfirm={(reason) => archiveCompany(showArchiveModal, reason)}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// CompanyCard
// ═══════════════════════════════════════════════════════════
function CompanyCard({ c, expanded, data, onToggle, onToggleActive, onArchive, onUnarchive, onDelete, onExport, onDeleteDoc }) {
  const statusBadge = (() => {
    if (c._archived) return { label: "Archivé", color: "var(--muted)", bg: "rgba(255,255,255,0.05)" };
    if (c.sub_status === "active") return { label: "Abonné", color: "var(--green, #3ecf7a)", bg: "rgba(62,207,122,0.12)" };
    if (c.sub_status === "trialing") return { label: "Essai", color: "var(--gold, #d4a843)", bg: "rgba(212,168,67,0.12)" };
    if (c.sub_status === "past_due") return { label: "Impayé", color: "var(--orange)", bg: "rgba(232,150,61,0.12)" };
    if (c.sub_status === "canceled") return { label: "Annulé", color: "var(--red, #e0556a)", bg: "rgba(224,85,106,0.12)" };
    return { label: c.sub_status || "—", color: "var(--muted)", bg: "rgba(255,255,255,0.05)" };
  })();

  return (
    <div className="card" style={{ marginBottom: 10, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 15 }}>{c.legal_name || c.email || c.id}</strong>
            <span style={{
              padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 500,
              color: statusBadge.color, background: statusBadge.bg
            }}>
              {statusBadge.label}
            </span>
            {!c.is_active && !c._archived && (
              <span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 11, color: "var(--muted)", background: "rgba(255,255,255,0.05)" }}>
                Désactivé
              </span>
            )}
            {c.is_admin && (
              <span style={{ padding: "2px 8px", borderRadius: 6, fontSize: 11, color: "var(--gold)", background: "rgba(212,168,67,0.12)" }}>
                ⭐ Admin
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
            {c.email} {c.siret ? "· SIRET " + c.siret : ""} · Créé {fmtDate(c.created_at)}
          </div>
          {c._archived && c.archive_reason && (
            <div style={{ fontSize: 11, color: "var(--orange)", marginTop: 4, fontStyle: "italic" }}>
              📁 Archivé le {fmtDate(c.archive_date)} — {c.archive_reason}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="btn btn-ghost" onClick={onToggle} style={{ fontSize: 12 }}>
            {expanded ? "▲ Masquer" : "▼ Détails"}
          </button>
          <button className="btn btn-ghost" onClick={onExport} style={{ fontSize: 12 }} title="Export JSON">
            ⬇ Export
          </button>
          {!c._archived ? (
            <>
              <button className="btn btn-ghost" onClick={onToggleActive} style={{ fontSize: 12 }}>
                {c.is_active ? "⏸ Désactiver" : "▶ Activer"}
              </button>
              <button className="btn btn-ghost" onClick={onArchive} style={{ fontSize: 12, color: "var(--orange)" }}>
                📁 Archiver
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-ghost" onClick={() => onUnarchive(false)} style={{ fontSize: 12 }}>
                📂 Désarchiver
              </button>
              <button className="btn btn-ghost" onClick={() => onUnarchive(true)} style={{ fontSize: 12, color: "var(--green)" }}>
                ✓ Désarchiver + Réactiver
              </button>
            </>
          )}
          <button className="btn btn-ghost" onClick={onDelete} style={{ fontSize: 12, color: "var(--red, #e0556a)" }}>
            🗑 Supprimer
          </button>
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border, rgba(255,255,255,0.06))" }}>
          {!data ? (
            <div style={{ color: "var(--muted)", fontSize: 12 }}>Chargement des données...</div>
          ) : (
            <>
              <CompanyDocSection title="Factures" rows={data.invoices || []} table="invoices" onDelete={onDeleteDoc} />
              <CompanyDocSection title="Avoirs" rows={data.credit_notes || []} table="credit_notes" onDelete={onDeleteDoc} />
              <CompanyDocSection title="Devis" rows={data.quotes || []} table="quotes" onDelete={onDeleteDoc} />
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 12 }}>
                Clients : {(data.clients || []).length} · Achats : {(data.purchases || []).length} · Paiements : {(data.payments || []).length}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CompanyDocSection({ title, rows, table, onDelete }) {
  if (!rows || rows.length === 0) {
    return (
      <div style={{ marginBottom: 8, fontSize: 12, color: "var(--muted)" }}>
        <strong>{title}</strong> : aucun
      </div>
    );
  }
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{title} ({rows.length})</div>
      <div style={{ fontSize: 11, maxHeight: 200, overflowY: "auto" }}>
        {rows.slice(0, 50).map((r) => (
          <div key={r.id} style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "4px 0", borderBottom: "1px dashed rgba(255,255,255,0.04)"
          }}>
            <span className="mono">
              {r.number || "(brouillon)"} · {fmtDate(r.issue_date || r.created_at)} · {r.status}
              {typeof r.total_ttc_cents === "number" ? " · " + fmtEUR(r.total_ttc_cents) : ""}
            </span>
            <button
              onClick={() => onDelete(table, r.id)}
              style={{
                background: "transparent", border: "1px solid rgba(224,85,106,0.4)",
                color: "var(--red, #e0556a)", borderRadius: 4,
                padding: "2px 6px", fontSize: 10, cursor: "pointer"
              }}
              title="Supprimer définitivement"
            >🗑</button>
          </div>
        ))}
        {rows.length > 50 && (
          <div style={{ marginTop: 4, color: "var(--muted)", fontSize: 10 }}>
            …et {rows.length - 50} autre{rows.length - 50 > 1 ? "s" : ""}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// TicketCard
// ═══════════════════════════════════════════════════════════
function TicketCard({ t, expanded, editNotes, onToggle, onStatusChange, onNotesChange, onSaveNotes, onDelete }) {
  const TYPES = {
    incident: { label: "🔴 Incident", color: "var(--red)" },
    amelioration: { label: "💡 Amélioration", color: "var(--gold)" },
    question: { label: "❓ Question", color: "var(--muted2)" },
    facturation: { label: "💳 Facturation", color: "var(--orange)" }
  };
  const STATUSES = {
    new: "🔴 Nouveau", in_progress: "🟡 En cours",
    resolved: "🟢 Résolu", closed: "⚫ Fermé"
  };
  const tt = TYPES[t.type] || { label: t.type, color: "var(--muted)" };
  return (
    <div className="card" style={{ marginBottom: 10, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ color: tt.color, fontSize: 12, fontWeight: 600 }}>{tt.label}</span>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>· {fmtDate(t.created_at)}</span>
            <span style={{ fontSize: 12 }}>· {t.company?.legal_name || "—"}</span>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>{t.company?.email || ""}</span>
          </div>
          <div style={{ marginTop: 6, fontSize: 13, whiteSpace: "pre-wrap" }}>
            {expanded ? t.message : t.message.slice(0, 200) + (t.message.length > 200 ? "…" : "")}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "flex-start", flexWrap: "wrap" }}>
          <select
            value={t.status}
            onChange={(e) => onStatusChange(e.target.value)}
            className="form-input"
            style={{ fontSize: 12, padding: "4px 8px", width: "auto" }}
          >
            {Object.entries(STATUSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button className="btn btn-ghost" onClick={onToggle} style={{ fontSize: 12 }}>
            {expanded ? "▲" : "▼"}
          </button>
          <button
            onClick={onDelete}
            style={{
              background: "transparent", border: "1px solid rgba(224,85,106,0.4)",
              color: "var(--red, #e0556a)", borderRadius: 4,
              padding: "4px 8px", fontSize: 11, cursor: "pointer"
            }}
          >🗑</button>
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border, rgba(255,255,255,0.06))" }}>
          <label className="form-label" style={{ fontSize: 11 }}>Notes admin (privées)</label>
          <textarea
            className="form-input"
            rows={3}
            value={editNotes ?? t.admin_notes ?? ""}
            onChange={(e) => onNotesChange(e.target.value)}
            placeholder="Notes internes sur ce ticket..."
            style={{ fontSize: 12 }}
          />
          <div style={{ marginTop: 6, textAlign: "right" }}>
            <button className="btn btn-primary" onClick={onSaveNotes} style={{ fontSize: 12 }}>
              Enregistrer les notes
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// ArchiveModal
// ═══════════════════════════════════════════════════════════
function ArchiveModal({ companyId, companyName, onClose, onConfirm }) {
  const [reason, setReason] = useState("");
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000
    }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: "var(--card-bg, #1a1d22)",
        border: "1px solid var(--border, rgba(255,255,255,0.08))",
        borderRadius: 10, padding: 20, maxWidth: 500, width: "90%"
      }}>
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>📁 Archiver le compte</div>
        <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 16 }}>
          <strong>{companyName}</strong>
          <br />
          L'abonné ne pourra plus se connecter, mais ses données restent intactes
          en base (factures, devis, etc.) et peuvent être restaurées plus tard.
        </div>
        <label className="form-label">Raison de l'archivage</label>
        <textarea
          className="form-input"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Ex : Non paiement depuis 3 mois, demande client, fin d'essai…"
          autoFocus
        />
        <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button className="btn btn-ghost" onClick={onClose}>Annuler</button>
          <button
            className="btn btn-primary"
            disabled={!reason.trim()}
            onClick={() => onConfirm(reason.trim())}
          >Archiver</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════
function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}
