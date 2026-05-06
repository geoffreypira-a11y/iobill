import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtEUR, fmtDate, daysUntil } from "../../lib/helpers.js";
import { snapshotDisplayName } from "../../lib/snapshots.js";
import { INVOICE_STATUSES, invoiceStatusBadge, isInvoiceOverdue } from "./invoiceHelpers.js";
import { SkeletonTable } from "../../components/Skeleton.jsx";

export function InvoicesListPage({ token, company }) {
  const navigate = useNavigate();
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const list = await sb.select(token, "invoices", {
        filter: `company_id=eq.${company.id}`,
        order: "created_at.desc",
        limit: 300
      });
      if (!alive) return;
      setInvoices(list || []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, company.id]);

  // Statut "effectif" : si due_date dépassée, on affiche "overdue" même si DB encore "sent"
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

  // KPI haut de page
  const totalUnpaid = invoices
    .filter((i) => ["issued", "sent", "partial", "overdue"].includes(i.status))
    .reduce((s, i) => s + ((i.total_ttc_cents || 0) - (i.paid_cents || 0)), 0);
  const totalOverdue = invoices
    .filter(isInvoiceOverdue)
    .reduce((s, i) => s + ((i.total_ttc_cents || 0) - (i.paid_cents || 0)), 0);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">FACTURES</div>
          <div className="page-sub">
            {invoices.length} factures · <span style={{ color: "var(--orange)" }}>{fmtEUR(totalUnpaid)} à encaisser</span>
            {totalOverdue > 0 && <> · <span style={{ color: "var(--red)" }}>{fmtEUR(totalOverdue)} en retard</span></>}
          </div>
        </div>
        <Link to="/invoices/new" className="btn btn-primary">
          <Icon name="plus" size={14} /> Nouvelle facture
        </Link>
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
        <SkeletonTable rows={6} cols={6} />
      ) : filtered.length === 0 ? (
        <div className="card card-pad" style={{ textAlign: "center", padding: "60px 20px" }}>
          <div style={{ fontSize: 40, marginBottom: 14 }}>🧾</div>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>
            {search || statusFilter !== "all" ? "Aucune facture ne correspond" : "Aucune facture pour l'instant"}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted2)", marginBottom: 16 }}>
            {search || statusFilter !== "all"
              ? null
              : "Les factures se créent à partir d'un devis signé, ou peuvent être créées en direct."}
          </div>
          {search || statusFilter !== "all" ? (
            <button className="btn btn-ghost" onClick={() => { setSearch(""); setStatusFilter("all"); }}>
              Effacer les filtres
            </button>
          ) : (
            <Link to="/quotes/new" className="btn btn-primary">
              <Icon name="plus" size={14} /> Créer un devis
            </Link>
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
                <th style={{ textAlign: "right" }}>Restant</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => {
                const eff = effectiveStatus(inv);
                const badge = invoiceStatusBadge(eff);
                const remaining = (inv.total_ttc_cents || 0) - (inv.paid_cents || 0);
                const dueDays = inv.due_date ? daysUntil(inv.due_date) : null;
                return (
                  <tr key={inv.id} onClick={() => navigate(`/invoices/${inv.id}`)} style={{ cursor: "pointer" }}>
                    <td className="mono">{inv.number || <span style={{ color: "var(--muted)" }}>brouillon</span>}</td>
                    <td>{snapshotDisplayName(inv.client_snapshot)}</td>
                    <td>{fmtDate(inv.issue_date)}</td>
                    <td style={{ fontSize: 12, color: dueDays !== null && dueDays < 0 ? "var(--red)" : dueDays !== null && dueDays < 7 ? "var(--orange)" : "var(--muted2)" }}>
                      {fmtDate(inv.due_date)}
                      {dueDays !== null && ["issued", "sent", "partial"].includes(inv.status) && (
                        <span style={{ marginLeft: 4 }}>({dueDays >= 0 ? `J+${dueDays}` : `J${dueDays}`})</span>
                      )}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(inv.total_ttc_cents)}</td>
                    <td className="mono" style={{ textAlign: "right", color: remaining > 0 ? "var(--orange)" : "var(--green)" }}>
                      {remaining > 0 ? fmtEUR(remaining) : "✓"}
                    </td>
                    <td><span className={"badge " + badge.cls}>{badge.label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
