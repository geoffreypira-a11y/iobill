import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtEUR, fmtDate, daysUntil } from "../../lib/helpers.js";
import { snapshotDisplayName } from "../../lib/snapshots.js";
import { QUOTE_STATUSES, quoteStatusBadge, isQuoteExpired } from "./quoteHelpers.js";
import { SkeletonTable } from "../../components/Skeleton.jsx";

export function QuotesListPage({ token, company }) {
  const navigate = useNavigate();
  const [quotes, setQuotes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const list = await sb.select(token, "quotes", {
        filter: `company_id=eq.${company.id}`,
        order: "issue_date.desc",
        limit: 200
      });
      if (!alive) return;
      setQuotes(list || []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, company.id]);

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

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">DEVIS</div>
          <div className="page-sub">
            {quotes.length} devis · {fmtEUR(totalPending)} en attente de signature
          </div>
        </div>
        <Link to="/quotes/new" className="btn btn-primary">
          <Icon name="plus" size={14} /> Nouveau devis
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
        <SkeletonTable rows={6} cols={6} />
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
                <th>Émis le</th>
                <th>Validité</th>
                <th style={{ textAlign: "right" }}>Montant TTC</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((q) => {
                const expired = isQuoteExpired(q);
                const effectiveStatus = expired ? "expired" : q.status;
                const badge = quoteStatusBadge(effectiveStatus);
                const validity = q.expires_at ? daysUntil(q.expires_at) : null;
                return (
                  <tr key={q.id} onClick={() => navigate(`/quotes/${q.id}`)} style={{ cursor: "pointer" }}>
                    <td className="mono">{q.number || <span style={{ color: "var(--muted)" }}>—</span>}</td>
                    <td>{snapshotDisplayName(q.client_snapshot)}</td>
                    <td>{fmtDate(q.issue_date)}</td>
                    <td style={{ fontSize: 12, color: q.status === "sent" && validity !== null && validity < 7 ? "var(--orange)" : "var(--muted2)" }}>
                      {q.expires_at ? (
                        validity > 0 ? `${validity} j` : validity === 0 ? "Aujourd'hui" : "Expiré"
                      ) : "—"}
                    </td>
                    <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(q.total_ttc_cents)}</td>
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
