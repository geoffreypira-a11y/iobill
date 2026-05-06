import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { initials, fmtEUR } from "../../lib/helpers.js";
import { CLIENT_STATUTS, PAYMENT_SCORES } from "./constants.js";
import { ClientModal } from "./ClientModal.jsx";
import { SkeletonTable } from "../../components/Skeleton.jsx";

const VIEW_KEY = "iobill_crm_view";

export function ClientsListPage({ token, company, setCompany }) {
  const navigate = useNavigate();
  const [clients, setClients] = useState([]);
  const [stats, setStats] = useState({});  // {clientId: {unpaid_cents, last_activity}}
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [view, setView] = useState(() => sanitizeView(company?.ui_prefs?.crm_view) || sanitizeView(safeLocal(VIEW_KEY)) || "cards");
  const [editing, setEditing] = useState(null);  // null | "add" | client
  const [confirmDel, setConfirmDel] = useState(null);

  // Charge clients + indicateurs simples
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const [list, invs] = await Promise.all([
        sb.select(token, "clients", { filter: `company_id=eq.${company.id}`, order: "updated_at.desc" }),
        sb.select(token, "invoices", {
          filter: `company_id=eq.${company.id}&status=in.(issued,sent,partial,overdue)`,
          select: "id,client_id,total_ttc_cents,paid_cents",
          limit: 500
        })
      ]);
      if (!alive) return;
      const byClient = {};
      (invs || []).forEach((inv) => {
        if (!inv.client_id) return;
        const remaining = (inv.total_ttc_cents || 0) - (inv.paid_cents || 0);
        if (!byClient[inv.client_id]) byClient[inv.client_id] = { unpaid_cents: 0, count: 0 };
        byClient[inv.client_id].unpaid_cents += remaining;
        byClient[inv.client_id].count += 1;
      });
      setClients(list || []);
      setStats(byClient);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, company.id]);

  // Persist vue capsules/liste (Supabase + miroir localStorage)
  function setViewPersisted(next) {
    if (!sanitizeView(next)) return;
    setView(next);
    try { localStorage.setItem(VIEW_KEY, next); } catch {}
    const newPrefs = { ...(company.ui_prefs || {}), crm_view: next };
    sb.update(token, "companies", `id=eq.${company.id}`, { ui_prefs: newPrefs });
    setCompany({ ...company, ui_prefs: newPrefs });
  }

  // Filtre + recherche
  const filtered = useMemo(() => {
    const s = search.toLowerCase().trim();
    return clients.filter((c) => {
      const matchS = !s || (
        (c.legal_name || "").toLowerCase().includes(s) ||
        (c.first_name || "").toLowerCase().includes(s) ||
        (c.last_name || "").toLowerCase().includes(s) ||
        (c.email || "").toLowerCase().includes(s) ||
        (c.phone || "").toLowerCase().includes(s)
      );
      const matchF = statusFilter === "all" || c.status === statusFilter;
      return matchS && matchF;
    });
  }, [clients, search, statusFilter]);

  // Stats globales pour le sub-header
  const counts = useMemo(() => {
    const c = { all: clients.length };
    Object.keys(CLIENT_STATUTS).forEach((k) => { c[k] = 0; });
    clients.forEach((cl) => { c[cl.status] = (c[cl.status] || 0) + 1; });
    return c;
  }, [clients]);

  function handleSaved(saved) {
    setEditing(null);
    setClients((cs) => {
      const exists = cs.find((x) => x.id === saved.id);
      return exists ? cs.map((x) => (x.id === saved.id ? saved : x)) : [saved, ...cs];
    });
  }

  async function handleDelete(c) {
    const ok = await sb.delete(token, "clients", `id=eq.${c.id}`);
    if (ok) {
      setClients((cs) => cs.filter((x) => x.id !== c.id));
      setConfirmDel(null);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">CRM CLIENTS</div>
          <div className="page-sub">
            {clients.length} contact{clients.length !== 1 ? "s" : ""} ·{" "}
            {(counts.customer || 0) + (counts.vip || 0)} client{(counts.customer || 0) + (counts.vip || 0) !== 1 ? "s" : ""} actif{(counts.customer || 0) + (counts.vip || 0) !== 1 ? "s" : ""}
            {counts.prospect ? ` · ${counts.prospect} prospect${counts.prospect > 1 ? "s" : ""}` : ""}
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing("add")}>
          <Icon name="plus" size={14} /> Nouveau client
        </button>
      </div>

      {/* Barre de filtres */}
      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap", alignItems: "center" }}>
        <input
          className="search-input"
          placeholder="Rechercher nom, email, téléphone..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="tabs" style={{ margin: 0 }}>
          <button className={"tab" + (statusFilter === "all" ? " active" : "")} onClick={() => setStatusFilter("all")}>
            Tous ({counts.all})
          </button>
          {Object.entries(CLIENT_STATUTS)
            .sort((a, b) => a[1].order - b[1].order)
            .map(([key, s]) => (
              counts[key] > 0 ? (
                <button
                  key={key}
                  className={"tab" + (statusFilter === key ? " active" : "")}
                  onClick={() => setStatusFilter(key)}
                >
                  {s.icon} {s.label} ({counts[key]})
                </button>
              ) : null
            ))}
        </div>
        <div style={{ marginLeft: "auto" }}>
          <div className="tabs" style={{ margin: 0 }}>
            <button className={"tab" + (view === "cards" ? " active" : "")} onClick={() => setViewPersisted("cards")} title="Vue capsules">⊞</button>
            <button className={"tab" + (view === "list" ? " active" : "")} onClick={() => setViewPersisted("list")} title="Vue liste">≡</button>
          </div>
        </div>
      </div>

      {/* Contenu */}
      {loading ? (
        <SkeletonTable rows={6} cols={5} />
      ) : filtered.length === 0 ? (
        <EmptyState
          isFiltered={search || statusFilter !== "all"}
          onCreate={() => setEditing("add")}
          onClear={() => { setSearch(""); setStatusFilter("all"); }}
        />
      ) : view === "cards" ? (
        <ClientsCards
          clients={filtered}
          stats={stats}
          onOpen={(c) => navigate(`/clients/${c.id}`)}
          onEdit={(c) => setEditing(c)}
          onDelete={(c) => setConfirmDel(c)}
        />
      ) : (
        <ClientsTable
          clients={filtered}
          stats={stats}
          onOpen={(c) => navigate(`/clients/${c.id}`)}
          onEdit={(c) => setEditing(c)}
          onDelete={(c) => setConfirmDel(c)}
        />
      )}

      {editing && (
        <ClientModal
          token={token}
          company={company}
          client={editing === "add" ? null : editing}
          onSave={handleSaved}
          onClose={() => setEditing(null)}
        />
      )}

      {confirmDel && (
        <ConfirmModal
          title="Supprimer le client"
          message={`Supprimer définitivement la fiche de ${displayName(confirmDel)} ? Ses devis et factures ne seront pas supprimés (mais le lien client sera rompu).`}
          onConfirm={() => handleDelete(confirmDel)}
          onCancel={() => setConfirmDel(null)}
        />
      )}
    </div>
  );
}

/* ─── Vue capsules ─────────────────────────────────────────── */
function ClientsCards({ clients, stats, onOpen, onEdit, onDelete }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
      {clients.map((c) => {
        const st = stats[c.id] || {};
        const statusInfo = CLIENT_STATUTS[c.status] || CLIENT_STATUTS.prospect;
        return (
          <div
            key={c.id}
            className="card card-pad"
            style={{ cursor: "pointer", transition: "border-color 0.15s" }}
            onClick={() => onOpen(c)}
            onMouseOver={(e) => e.currentTarget.style.borderColor = "var(--border)"}
            onMouseOut={(e) => e.currentTarget.style.borderColor = ""}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 12 }}>
              <div className="avatar" style={{ width: 38, height: 38, fontSize: 13 }}>
                {initials(displayName(c))}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "Syne, sans-serif", fontWeight: 700, fontSize: 14, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {displayName(c)}
                </div>
                <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {c.email || c.phone || "—"}
                </div>
              </div>
              <span className={"badge " + statusInfo.cls} style={{ fontSize: 9 }}>
                {statusInfo.icon} {statusInfo.label}
              </span>
            </div>

            {st.unpaid_cents > 0 && (
              <div style={{ fontSize: 11, color: "var(--orange)", marginBottom: 8 }}>
                Encours : <span className="mono">{fmtEUR(st.unpaid_cents)}</span> ({st.count} fact.)
              </div>
            )}

            {(c.tags || []).length > 0 && (
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
                {(c.tags || []).slice(0, 3).map((t) => (
                  <span key={t} style={{ fontSize: 10, padding: "2px 6px", borderRadius: 3, background: "var(--card2)", color: "var(--muted2)" }}>{t}</span>
                ))}
              </div>
            )}

            <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
              <button className="btn btn-ghost btn-xs" onClick={(e) => { e.stopPropagation(); onEdit(c); }}>
                <Icon name="edit" size={12} /> Modifier
              </button>
              <button className="btn btn-danger btn-xs" onClick={(e) => { e.stopPropagation(); onDelete(c); }}>
                <Icon name="trash" size={12} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Vue liste ────────────────────────────────────────────── */
function ClientsTable({ clients, stats, onOpen, onEdit, onDelete }) {
  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <table>
        <thead>
          <tr>
            <th>Client</th>
            <th>Email</th>
            <th>Statut</th>
            <th style={{ textAlign: "right" }}>Encours</th>
            <th>Score</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => {
            const st = stats[c.id] || {};
            const statusInfo = CLIENT_STATUTS[c.status] || CLIENT_STATUTS.prospect;
            const score = PAYMENT_SCORES[c.payment_score || "normal"];
            return (
              <tr key={c.id} style={{ cursor: "pointer" }} onClick={() => onOpen(c)}>
                <td>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div className="avatar" style={{ width: 28, height: 28, fontSize: 10 }}>
                      {initials(displayName(c))}
                    </div>
                    <div>
                      <div style={{ fontWeight: 600 }}>{displayName(c)}</div>
                      {c.contact_person && (
                        <div style={{ fontSize: 11, color: "var(--muted)" }}>{c.contact_person}</div>
                      )}
                    </div>
                  </div>
                </td>
                <td>{c.email || "—"}</td>
                <td>
                  <span className={"badge " + statusInfo.cls}>{statusInfo.icon} {statusInfo.label}</span>
                </td>
                <td className="mono" style={{ textAlign: "right", color: st.unpaid_cents ? "var(--orange)" : "var(--muted)" }}>
                  {st.unpaid_cents ? fmtEUR(st.unpaid_cents) : "—"}
                </td>
                <td>
                  <span className={"badge " + score.cls}>{score.icon} {score.label}</span>
                </td>
                <td onClick={(e) => e.stopPropagation()} style={{ textAlign: "right" }}>
                  <button className="btn btn-ghost btn-xs" onClick={() => onEdit(c)}>
                    <Icon name="edit" size={12} />
                  </button>
                  <button className="btn btn-danger btn-xs" onClick={() => onDelete(c)} style={{ marginLeft: 6 }}>
                    <Icon name="trash" size={12} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({ isFiltered, onCreate, onClear }) {
  if (isFiltered) {
    return (
      <div className="card card-pad" style={{ textAlign: "center", padding: "60px 20px" }}>
        <div style={{ fontSize: 14, color: "var(--muted2)", marginBottom: 12 }}>
          Aucun client ne correspond à votre recherche.
        </div>
        <button className="btn btn-ghost" onClick={onClear}>Effacer les filtres</button>
      </div>
    );
  }
  return (
    <div className="card card-pad" style={{ textAlign: "center", padding: "60px 20px" }}>
      <div style={{ fontSize: 44, marginBottom: 14 }}>👥</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>
        Votre CRM est vide
      </div>
      <div style={{ fontSize: 13, color: "var(--muted2)", marginBottom: 18 }}>
        Ajoutez votre premier client pour commencer à émettre devis et factures.
      </div>
      <button className="btn btn-primary" onClick={onCreate}>
        <Icon name="plus" size={14} /> Créer un client
      </button>
    </div>
  );
}

function ConfirmModal({ title, message, onConfirm, onCancel }) {
  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal" style={{ maxWidth: 440 }}>
        <div className="modal-hd">
          <div className="modal-title">{title}</div>
          <button className="close-btn" onClick={onCancel}><Icon name="x" size={14} /></button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: 13, color: "var(--muted2)", marginBottom: 18 }}>{message}</div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="btn btn-ghost" onClick={onCancel}>Annuler</button>
            <button className="btn btn-danger" onClick={onConfirm}>Supprimer</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Helpers ─────────────────────────────────────────────── */
function displayName(c) {
  if (c.client_type === "individual") {
    return [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "Client";
  }
  return c.legal_name || "Client";
}

function sanitizeView(v) {
  return v === "list" || v === "cards" ? v : null;
}

function safeLocal(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
