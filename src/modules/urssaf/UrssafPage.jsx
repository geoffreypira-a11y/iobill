import React, { useEffect, useMemo, useState } from "react";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtEUR, fmtDate, toCents } from "../../lib/helpers.js";
import { capture, bumpModuleUsage } from "../../lib/telemetry.js";

// Taux URSSAF micro-entrepreneur 2026 (à confirmer par activité)
const URSSAF_RATES = {
  bnc: 0.232,             // BNC libéral non-CIPAV : 23,2%
  bic_services: 0.212,    // BIC services : 21,2%
  bic_vente: 0.122        // BIC vente : 12,2%
};

const URSSAF_STATUTS = {
  draft:    { label: "Brouillon", cls: "badge-muted",  icon: "📝" },
  declared: { label: "Déclarée",  cls: "badge-green",  icon: "✅" },
  paid:     { label: "Payée",     cls: "badge-green",  icon: "💰" }
};

export function UrssafPage({ token, company }) {
  const [returns, setReturns] = useState([]);
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  const period = company.urssaf_period || "monthly";
  const activity = company.micro_activity || "bic_services";
  const rate = URSSAF_RATES[activity] || 0.212;

  useEffect(() => {
    let alive = true;
    (async () => {
      const [r, p] = await Promise.all([
        sb.select(token, "urssaf_returns", { filter: `company_id=eq.${company.id}`, order: "period_start.desc" }),
        sb.select(token, "payments", {
          filter: `company_id=eq.${company.id}`,
          order: "paid_at.desc",
          limit: 500
        })
      ]);
      if (!alive) return;
      setReturns(r || []);
      setPayments(p || []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, company.id]);

  const currentPeriod = useMemo(() => computeCurrentUrssafPeriod(period), [period]);

  // CA encaissé sur la période (URSSAF AE = base CA encaissé, pas facturé)
  const stats = useMemo(() => {
    if (!currentPeriod) return null;
    const start = new Date(currentPeriod.start);
    const end = new Date(currentPeriod.end);
    const collectedCents = payments
      .filter((p) => {
        const d = new Date(p.paid_at);
        return d >= start && d <= end;
      })
      .reduce((s, p) => s + (p.amount_cents || 0), 0);
    const cotisations = Math.round(collectedCents * rate);
    return { collectedCents, cotisations, rate };
  }, [payments, currentPeriod, rate]);

  async function generateReturn() {
    if (!stats || !currentPeriod) return;
    setGenerating(true);
    const created = await sb.insert(token, "urssaf_returns", {
      company_id: company.id,
      period_type: period,
      period_start: currentPeriod.start,
      period_end: currentPeriod.end,
      ca_encaisse_cents: stats.collectedCents,
      cotisations_cents: stats.cotisations,
      rate_applied: rate * 100,
      status: "draft",
      snapshot: {
        payments_count: payments.filter((p) => {
          const d = new Date(p.paid_at);
          return d >= new Date(currentPeriod.start) && d <= new Date(currentPeriod.end);
        }).length,
        activity,
        generated_at: new Date().toISOString()
      }
    });
    setGenerating(false);
    if (created && created[0]) {
      setReturns([created[0], ...returns]);
      capture("urssaf_return_generated", {
        period_type: period,
        ca_encaisse: stats.collectedCents / 100,
        cotisations: stats.cotisations / 100,
        activity
      });
      bumpModuleUsage(token, company.id, "urssaf");
      alert(`Déclaration URSSAF prête.\nCA encaissé : ${fmtEUR(stats.collectedCents)}\nCotisations : ${fmtEUR(stats.cotisations)}\nReportez ces montants sur autoentrepreneur.urssaf.fr`);
    }
  }

  async function markDeclared(r) {
    if (!confirm("Marquer cette déclaration comme transmise sur autoentrepreneur.urssaf.fr ?")) return;
    const updated = await sb.update(token, "urssaf_returns", `id=eq.${r.id}`, {
      status: "declared",
      declared_at: new Date().toISOString()
    });
    if (updated && updated[0]) setReturns(returns.map((x) => x.id === r.id ? updated[0] : x));
  }

  async function markPaid(r) {
    const updated = await sb.update(token, "urssaf_returns", `id=eq.${r.id}`, {
      status: "paid",
      paid_at: new Date().toISOString().slice(0,10)
    });
    if (updated && updated[0]) setReturns(returns.map((x) => x.id === r.id ? updated[0] : x));
  }

  if (loading) return <div className="page"><div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Chargement...</div></div>;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">URSSAF</div>
          <div className="page-sub">
            Déclaration {period === "quarterly" ? "trimestrielle" : "mensuelle"} · Taux {(rate * 100).toFixed(1)}% ({activityLabel(activity)})
            {currentPeriod && <> · Période : {fmtDate(currentPeriod.start)} → {fmtDate(currentPeriod.end)}</>}
          </div>
        </div>
        <button className="btn btn-primary" onClick={generateReturn} disabled={generating}>
          <Icon name="plus" size={14} /> Générer la déclaration
        </button>
      </div>

      {stats && (
        <div className="kpi-grid">
          <div className="kpi">
            <div className="kpi-label">CA encaissé période</div>
            <div className="kpi-val gold">{fmtEUR(stats.collectedCents)}</div>
            <div className="kpi-foot">Base de calcul URSSAF</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Taux appliqué</div>
            <div className="kpi-val">{(rate * 100).toFixed(1)}%</div>
            <div className="kpi-foot">{activityLabel(activity)}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Cotisations dues</div>
            <div className="kpi-val orange">{fmtEUR(stats.cotisations)}</div>
            <div className="kpi-foot">À déclarer + payer</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Reste à toi</div>
            <div className="kpi-val green">{fmtEUR(stats.collectedCents - stats.cotisations)}</div>
            <div className="kpi-foot">Hors impôt sur le revenu</div>
          </div>
        </div>
      )}

      <div className="tipline" style={{ marginBottom: 16 }}>
        <Icon name="alert" size={14} />
        L'URSSAF AE se base sur le <strong>CA encaissé</strong> (pas facturé). Ne sont comptabilisés que les paiements reçus dans la période.
      </div>

      <div className="card" style={{ overflow: "hidden" }}>
        <div className="card-pad" style={{ borderBottom: "1px solid var(--border2)", padding: "14px 20px" }}>
          <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase" }}>
            Historique des déclarations
          </div>
        </div>
        {returns.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
            Aucune déclaration enregistrée.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Période</th>
                <th>Type</th>
                <th style={{ textAlign: "right" }}>CA encaissé</th>
                <th>Taux</th>
                <th style={{ textAlign: "right" }}>Cotisations</th>
                <th>Statut</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {returns.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDate(r.period_start)} → {fmtDate(r.period_end)}</td>
                  <td>{r.period_type === "quarterly" ? "Trimestrielle" : "Mensuelle"}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(r.ca_encaisse_cents)}</td>
                  <td className="mono">{r.rate_applied}%</td>
                  <td className="mono" style={{ textAlign: "right", color: "var(--orange)" }}>{fmtEUR(r.cotisations_cents)}</td>
                  <td><span className={"badge " + URSSAF_STATUTS[r.status]?.cls}>{URSSAF_STATUTS[r.status]?.icon} {URSSAF_STATUTS[r.status]?.label}</span></td>
                  <td style={{ textAlign: "right" }}>
                    {r.status === "draft" && <button className="btn btn-ghost btn-xs" onClick={() => markDeclared(r)}>Marquer déclarée</button>}
                    {r.status === "declared" && <button className="btn btn-ghost btn-xs" onClick={() => markPaid(r)}>Marquer payée</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function activityLabel(a) {
  return ({ bnc: "Profession libérale (BNC)", bic_services: "Prestations services (BIC)", bic_vente: "Vente marchandises (BIC)" })[a] || a;
}

function computeCurrentUrssafPeriod(period) {
  const now = new Date();
  if (period === "quarterly") {
    const m = now.getMonth();
    const qStartMonth = m < 3 ? 0 : m < 6 ? 3 : m < 9 ? 6 : 9;
    const start = new Date(now.getFullYear(), qStartMonth, 1);
    const end = new Date(now.getFullYear(), qStartMonth + 3, 0);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  // monthly
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
