import React, { useEffect, useMemo, useState } from "react";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtDate } from "../../lib/helpers.js";
import { SkeletonTable } from "../../components/Skeleton.jsx";

const ACTION_LABELS = {
  INSERT: { label: "Création", color: "var(--green)", icon: "+" },
  UPDATE: { label: "Modification", color: "var(--gold)", icon: "✎" },
  DELETE: { label: "Suppression", color: "var(--red)", icon: "✗" },
  ISSUE:  { label: "Émission", color: "var(--gold2)", icon: "⚡" },
  CANCEL: { label: "Annulation", color: "var(--orange)", icon: "⊘" }
};

const TABLE_LABELS = {
  invoices: "Facture",
  quotes: "Devis",
  credit_notes: "Avoir",
  clients: "Client",
  purchases: "Achat",
  payments: "Paiement",
  vat_returns: "Déclaration TVA",
  urssaf_returns: "Déclaration URSSAF",
  bank_transactions: "Transaction bancaire",
  documents_files: "Fichier",
  companies: "Société",
  company_users: "Membre équipe"
};

export function AuditLogPage({ token, company }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tableFilter, setTableFilter] = useState("all");
  const [actionFilter, setActionFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const list = await sb.select(token, "audit_log", {
        filter: `company_id=eq.${company.id}`,
        order: "created_at.desc",
        limit: 200
      });
      if (!alive) return;
      setLogs(list || []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, company.id]);

  const tables = useMemo(() => {
    const set = new Set(logs.map((l) => l.table_name));
    return Array.from(set).filter(Boolean).sort();
  }, [logs]);

  const filtered = useMemo(() => {
    const s = search.toLowerCase().trim();
    return logs.filter((l) => {
      if (tableFilter !== "all" && l.table_name !== tableFilter) return false;
      if (actionFilter !== "all" && l.action !== actionFilter) return false;
      if (s) {
        const haystack = JSON.stringify({ ...(l.new_data || {}), ...(l.old_data || {}) }).toLowerCase();
        if (!haystack.includes(s) && !(l.record_id || "").includes(s)) return false;
      }
      return true;
    });
  }, [logs, tableFilter, actionFilter, search]);

  function fmtTime(iso) {
    const d = new Date(iso);
    return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">JOURNAL D'AUDIT</div>
          <div className="page-sub">{logs.length} évènement{logs.length > 1 ? "s" : ""} · 200 derniers</div>
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16, fontSize: 12, color: "var(--muted2)", lineHeight: 1.7 }}>
        <strong style={{ color: "var(--text)" }}>📜 Conformité fiscale :</strong> chaque modification de
        document de facturation est tracée pour répondre aux exigences DGFiP (article L102 B du LPF).
        Les évènements ne peuvent ni être supprimés ni modifiés rétroactivement.
      </div>

      {/* Filtres */}
      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <input
          className="search-input"
          placeholder="Rechercher dans les évènements..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="form-input" style={{ width: "auto" }} value={tableFilter} onChange={(e) => setTableFilter(e.target.value)}>
          <option value="all">Toutes les tables</option>
          {tables.map((t) => <option key={t} value={t}>{TABLE_LABELS[t] || t}</option>)}
        </select>
        <select className="form-input" style={{ width: "auto" }} value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
          <option value="all">Toutes les actions</option>
          {Object.entries(ACTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </div>

      {loading ? (
        <SkeletonTable rows={8} cols={5} />
      ) : filtered.length === 0 ? (
        <div className="card card-pad" style={{ textAlign: "center", padding: 50 }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>📋</div>
          <div style={{ fontSize: 14, color: "var(--muted2)" }}>
            {logs.length === 0 ? "Aucun évènement enregistré pour l'instant." : "Aucun évènement ne correspond aux filtres."}
          </div>
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 140 }}>Date/heure</th>
                <th>Action</th>
                <th>Élément</th>
                <th>Référence</th>
                <th>IP</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((l) => {
                const act = ACTION_LABELS[l.action] || { label: l.action, color: "var(--muted)", icon: "·" };
                const tableLabel = TABLE_LABELS[l.table_name] || l.table_name;
                const ref = l.new_data?.number || l.new_data?.legal_name || l.old_data?.number || l.old_data?.legal_name || (l.record_id || "").slice(0, 8);
                const isExpanded = expanded === l.id;
                return (
                  <React.Fragment key={l.id}>
                    <tr style={{ cursor: "pointer" }} onClick={() => setExpanded(isExpanded ? null : l.id)}>
                      <td className="mono" style={{ fontSize: 11 }}>{fmtTime(l.created_at)}</td>
                      <td>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: act.color, fontSize: 12, fontWeight: 500 }}>
                          <span style={{ display: "inline-block", width: 18, textAlign: "center" }}>{act.icon}</span>
                          {act.label}
                        </span>
                      </td>
                      <td style={{ fontSize: 12 }}>{tableLabel}</td>
                      <td className="mono" style={{ fontSize: 11, color: "var(--muted2)" }}>{ref}</td>
                      <td className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>{l.ip_address || "—"}</td>
                      <td style={{ textAlign: "right", color: "var(--muted)" }}>{isExpanded ? "▲" : "▼"}</td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={6} style={{ background: "var(--card2)", padding: 16 }}>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
                            <div>
                              <div style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6 }}>Avant</div>
                              <pre style={{
                                background: "var(--bg)", padding: 10, borderRadius: 6,
                                fontSize: 10, lineHeight: 1.5, color: "var(--muted2)",
                                maxHeight: 200, overflow: "auto", margin: 0,
                                fontFamily: "DM Mono, monospace", whiteSpace: "pre-wrap", wordBreak: "break-word"
                              }}>
                                {l.old_data ? JSON.stringify(l.old_data, null, 2) : "—"}
                              </pre>
                            </div>
                            <div>
                              <div style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6 }}>Après</div>
                              <pre style={{
                                background: "var(--bg)", padding: 10, borderRadius: 6,
                                fontSize: 10, lineHeight: 1.5, color: "var(--muted2)",
                                maxHeight: 200, overflow: "auto", margin: 0,
                                fontFamily: "DM Mono, monospace", whiteSpace: "pre-wrap", wordBreak: "break-word"
                              }}>
                                {l.new_data ? JSON.stringify(l.new_data, null, 2) : "—"}
                              </pre>
                            </div>
                          </div>
                          {l.user_agent && (
                            <div style={{ marginTop: 10, fontSize: 10, color: "var(--muted)", fontFamily: "DM Mono, monospace" }}>
                              UA: {l.user_agent}
                            </div>
                          )}
                          <div style={{ marginTop: 6, fontSize: 10, color: "var(--muted)", fontFamily: "DM Mono, monospace" }}>
                            ID: {l.id}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
