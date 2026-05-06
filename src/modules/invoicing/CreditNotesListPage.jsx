import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtEUR, fmtDate } from "../../lib/helpers.js";
import { snapshotDisplayName } from "../../lib/snapshots.js";
import { CREDIT_NOTE_STATUSES, creditNoteStatusBadge } from "./creditNoteHelpers.js";
import { SkeletonTable } from "../../components/Skeleton.jsx";

export function CreditNotesListPage({ token, company }) {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

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
            Pour créer un avoir, ouvrez une facture émise et cliquez sur « Créer un avoir ».
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
                        <Link
                          to={`/invoices/${c.invoice_id}`}
                          onClick={(e) => e.stopPropagation()}
                          style={{ color: "var(--gold)", textDecoration: "none" }}
                        >
                          → voir
                        </Link>
                      ) : "—"}
                    </td>
                    <td className="mono" style={{ textAlign: "right", color: "var(--orange)" }}>
                      − {fmtEUR(c.total_ttc_cents)}
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
