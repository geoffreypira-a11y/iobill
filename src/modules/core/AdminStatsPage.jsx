import React, { useEffect, useState } from "react";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";

/**
 * AdminStatsPage — Reservee aux comptes is_admin
 * Affiche les vues v_module_adoption + v_quote_conversion definies en SQL.
 */
export function AdminStatsPage({ token, company }) {
  const [allowed, setAllowed] = useState(null); // null = checking, true/false
  const [adoption, setAdoption] = useState([]);
  const [conversion, setConversion] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      // 1) Verifier is_admin
      if (!company?.is_admin) {
        setAllowed(false);
        setLoading(false);
        return;
      }
      setAllowed(true);

      // 2) Charger les vues
      const [adopt, conv] = await Promise.all([
        sb.select(token, "v_module_adoption", { order: "active_companies.desc", limit: 50 }),
        sb.select(token, "v_quote_conversion", { order: "win_rate_pct.desc", limit: 100 })
      ]);
      if (!alive) return;
      setAdoption(adopt || []);
      setConversion(conv || []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, company]);

  if (allowed === false) {
    return (
      <div className="page">
        <div className="card card-pad" style={{ textAlign: "center", padding: 60 }}>
          <div style={{ fontSize: 40, marginBottom: 14 }}>🔒</div>
          <div>Réservé aux administrateurs IO BILL.</div>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="page"><div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Chargement...</div></div>;
  }

  const totalEvents = adoption.reduce((s, a) => s + (a.total_events || 0), 0);
  const avgWinRate = conversion.length > 0
    ? conversion.reduce((s, c) => s + (Number(c.win_rate_pct) || 0), 0) / conversion.length
    : 0;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">STATISTIQUES PLATEFORME</div>
          <div className="page-sub">Adoption modules · taux conversion · vue admin</div>
        </div>
      </div>

      {/* KPI globaux */}
      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        <div className="kpi">
          <div className="kpi-label">Modules actifs</div>
          <div className="kpi-val gold">{adoption.length}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Évènements 30j</div>
          <div className="kpi-val">{totalEvents.toLocaleString("fr-FR")}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Win rate moyen</div>
          <div className="kpi-val green">{avgWinRate.toFixed(1)}%</div>
        </div>
      </div>

      {/* Adoption par module */}
      <div className="card card-pad" style={{ marginBottom: 18 }}>
        <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 12 }}>
          Adoption modules — 30 jours
        </div>
        {adoption.length === 0 ? (
          <div style={{ color: "var(--muted)", padding: 12 }}>Aucun usage enregistré pour l'instant.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Module</th>
                <th style={{ textAlign: "right" }}>Companies actives</th>
                <th style={{ textAlign: "right" }}>Total évènements</th>
                <th>Adoption</th>
              </tr>
            </thead>
            <tbody>
              {adoption.map((a) => {
                const pct = totalEvents > 0 ? (a.total_events / totalEvents * 100) : 0;
                return (
                  <tr key={a.module_key}>
                    <td className="mono">{a.module_key}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{a.active_companies}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{Number(a.total_events).toLocaleString("fr-FR")}</td>
                    <td>
                      <div style={{ width: 120, height: 8, background: "var(--card2)", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{ width: `${pct}%`, height: "100%", background: "var(--gold)" }} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Top win rate devis */}
      <div className="card card-pad">
        <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 12 }}>
          Conversion devis → facture (90j)
        </div>
        {conversion.length === 0 ? (
          <div style={{ color: "var(--muted)", padding: 12 }}>Aucun devis suffisant pour calculer un taux.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Société</th>
                <th style={{ textAlign: "right" }}>Devis émis</th>
                <th style={{ textAlign: "right" }}>Signés</th>
                <th style={{ textAlign: "right" }}>Convertis</th>
                <th style={{ textAlign: "right" }}>Win rate</th>
              </tr>
            </thead>
            <tbody>
              {conversion.map((c) => (
                <tr key={c.company_id}>
                  <td>{c.legal_name || "—"}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{c.quotes_sent}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{c.quotes_won}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{c.quotes_converted}</td>
                  <td className="mono" style={{ textAlign: "right", color: Number(c.win_rate_pct) >= 50 ? "var(--green)" : "var(--orange)" }}>
                    {Number(c.win_rate_pct || 0).toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ marginTop: 28, fontSize: 11, color: "var(--muted)", textAlign: "center" }}>
        Sources : views Postgres v_module_adoption + v_quote_conversion (cf. supabase/05_v11_extensions.sql)
      </div>
    </div>
  );
}
