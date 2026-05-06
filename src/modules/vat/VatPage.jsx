import React, { useEffect, useMemo, useState } from "react";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtEUR, fmtDate, daysUntil } from "../../lib/helpers.js";
import { capture, bumpModuleUsage } from "../../lib/telemetry.js";

const VAT_STATUTS = {
  draft:    { label: "Brouillon", cls: "badge-muted",  icon: "📝" },
  ready:    { label: "Prête",     cls: "badge-gold",   icon: "📋" },
  declared: { label: "Déclarée",  cls: "badge-green",  icon: "✅" },
  paid:     { label: "Payée",     cls: "badge-green",  icon: "💰" }
};

export function VatPage({ token, company }) {
  const [returns, setReturns] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [r, i, p] = await Promise.all([
        sb.select(token, "vat_returns", { filter: `company_id=eq.${company.id}`, order: "period_start.desc" }),
        sb.select(token, "invoices", {
          filter: `company_id=eq.${company.id}&status=in.(issued,sent,partial,paid,overdue)`,
          order: "issue_date.desc"
        }),
        sb.select(token, "purchases", {
          filter: `company_id=eq.${company.id}&status=in.(validated,paid)`,
          order: "issue_date.desc"
        })
      ]);
      if (!alive) return;
      setReturns(r || []);
      setInvoices(i || []);
      setPurchases(p || []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, company.id]);

  // Calcule période en cours (selon régime)
  const currentPeriod = useMemo(() => computeCurrentVatPeriod(company.vat_regime), [company.vat_regime]);

  // Calcule la TVA du mois/trimestre courant
  const stats = useMemo(() => {
    if (!currentPeriod) return null;
    const start = new Date(currentPeriod.start);
    const end = new Date(currentPeriod.end);
    const filterDate = (d) => {
      if (!d) return false;
      const dt = new Date(d);
      return dt >= start && dt <= end;
    };
    const collectedVAT = invoices
      .filter((i) => filterDate(i.issue_date))
      .reduce((s, i) => s + (i.vat_total_cents || 0), 0);
    const collectedHT = invoices
      .filter((i) => filterDate(i.issue_date))
      .reduce((s, i) => s + (i.subtotal_ht_cents || 0), 0);
    const deductibleVAT = purchases
      .filter((p) => filterDate(p.issue_date))
      .reduce((s, p) => s + (p.vat_total_cents || 0), 0);
    const breakdown = {};
    invoices
      .filter((i) => filterDate(i.issue_date))
      .forEach((i) => {
        (i.vat_breakdown || []).forEach((br) => {
          const k = `${br.rate}`;
          if (!breakdown[k]) breakdown[k] = { rate: br.rate, base_cents: 0, vat_cents: 0 };
          breakdown[k].base_cents += br.base_cents || 0;
          breakdown[k].vat_cents += br.vat_cents || 0;
        });
      });
    return {
      collectedVAT,
      collectedHT,
      deductibleVAT,
      netVAT: collectedVAT - deductibleVAT,
      breakdown: Object.values(breakdown).sort((a, b) => a.rate - b.rate)
    };
  }, [invoices, purchases, currentPeriod]);

  async function generateReturn() {
    if (!currentPeriod || !stats) return;
    setGenerating(true);
    const formType = company.vat_regime === "simplified" ? "CA12" : "CA3";
    const created = await sb.insert(token, "vat_returns", {
      company_id: company.id,
      period_start: currentPeriod.start,
      period_end: currentPeriod.end,
      form_type: formType,
      collected_vat_cents: stats.collectedVAT,
      deductible_vat_cents: stats.deductibleVAT,
      net_vat_cents: stats.netVAT,
      taxable_base_cents: stats.collectedHT,
      breakdown: stats.breakdown,
      status: "ready",
      snapshot: {
        invoices_count: invoices.filter((i) => {
          const d = new Date(i.issue_date);
          return d >= new Date(currentPeriod.start) && d <= new Date(currentPeriod.end);
        }).length,
        purchases_count: purchases.filter((p) => {
          const d = new Date(p.issue_date);
          return d >= new Date(currentPeriod.start) && d <= new Date(currentPeriod.end);
        }).length,
        generated_at: new Date().toISOString()
      }
    });
    setGenerating(false);
    if (created && created[0]) {
      setReturns([created[0], ...returns]);
      capture("vat_return_generated", {
        form_type: formType,
        period_start: currentPeriod.start,
        period_end: currentPeriod.end,
        net_vat: stats.netVAT / 100
      });
      bumpModuleUsage(token, company.id, "vat");
      alert("Déclaration TVA prête. Reportez les montants sur impots.gouv.fr.");
    }
  }

  async function markDeclared(r) {
    if (!confirm("Marquer cette déclaration comme transmise à impots.gouv.fr ?")) return;
    const updated = await sb.update(token, "vat_returns", `id=eq.${r.id}`, {
      status: "declared",
      declared_at: new Date().toISOString()
    });
    if (updated && updated[0]) {
      setReturns(returns.map((x) => (x.id === r.id ? updated[0] : x)));
    }
  }

  async function markPaid(r) {
    const updated = await sb.update(token, "vat_returns", `id=eq.${r.id}`, {
      status: "paid",
      paid_at: new Date().toISOString().slice(0, 10)
    });
    if (updated && updated[0]) {
      setReturns(returns.map((x) => (x.id === r.id ? updated[0] : x)));
    }
  }

  if (loading) return <div className="page"><div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Chargement...</div></div>;

  if (company.vat_regime === "franchise") {
    return (
      <div className="page">
        <div className="page-header">
          <div>
            <div className="page-title">TVA</div>
            <div className="page-sub">Vous êtes en franchise en base de TVA</div>
          </div>
        </div>
        <div className="card card-pad" style={{ textAlign: "center", padding: 60 }}>
          <div style={{ fontSize: 44, marginBottom: 14 }}>🏷️</div>
          <div style={{ fontSize: 14, marginBottom: 10 }}>Vous n'êtes pas assujetti à la TVA.</div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            Vos factures portent la mention "TVA non applicable, art. 293 B du CGI". Si vous dépassez le seuil, modifiez votre régime dans les Paramètres.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">DÉCLARATIONS TVA</div>
          <div className="page-sub">
            Régime : {regimeLabel(company.vat_regime)}
            {currentPeriod && <> · Période en cours : {fmtDate(currentPeriod.start)} → {fmtDate(currentPeriod.end)}</>}
          </div>
        </div>
        <button className="btn btn-primary" onClick={generateReturn} disabled={generating}>
          <Icon name="plus" size={14} /> {generating ? "Génération..." : "Générer la déclaration"}
        </button>
      </div>

      {/* KPI période courante */}
      {stats && (
        <div className="kpi-grid">
          <div className="kpi">
            <div className="kpi-label">CA HT taxable</div>
            <div className="kpi-val gold">{fmtEUR(stats.collectedHT)}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">TVA collectée</div>
            <div className="kpi-val">{fmtEUR(stats.collectedVAT)}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">TVA déductible</div>
            <div className="kpi-val">{fmtEUR(stats.deductibleVAT)}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">TVA à reverser</div>
            <div className={"kpi-val " + (stats.netVAT > 0 ? "orange" : "green")}>
              {fmtEUR(Math.max(0, stats.netVAT))}
            </div>
            <div className="kpi-foot">
              {stats.netVAT < 0 && <span style={{ color: "var(--green)" }}>Crédit de TVA : {fmtEUR(-stats.netVAT)}</span>}
            </div>
          </div>
        </div>
      )}

      {/* Ventilation par taux */}
      {stats && stats.breakdown.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 12 }}>
            Ventilation TVA collectée — {currentPeriod && `${fmtDate(currentPeriod.start)} → ${fmtDate(currentPeriod.end)}`}
          </div>
          <table>
            <thead>
              <tr><th>Taux</th><th style={{ textAlign: "right" }}>Base HT</th><th style={{ textAlign: "right" }}>TVA collectée</th></tr>
            </thead>
            <tbody>
              {stats.breakdown.map((br) => (
                <tr key={br.rate}>
                  <td className="mono">{br.rate}%</td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(br.base_cents)}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(br.vat_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Historique des déclarations */}
      <div className="card" style={{ overflow: "hidden" }}>
        <div className="card-pad" style={{ borderBottom: "1px solid var(--border2)", padding: "14px 20px" }}>
          <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase" }}>
            Historique
          </div>
        </div>
        {returns.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
            Aucune déclaration générée.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Période</th>
                <th>Type</th>
                <th style={{ textAlign: "right" }}>CA HT</th>
                <th style={{ textAlign: "right" }}>TVA collectée</th>
                <th style={{ textAlign: "right" }}>TVA à payer</th>
                <th>Statut</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {returns.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDate(r.period_start)} → {fmtDate(r.period_end)}</td>
                  <td className="mono">{r.form_type}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(r.taxable_base_cents)}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(r.collected_vat_cents)}</td>
                  <td className="mono" style={{ textAlign: "right", color: r.net_vat_cents > 0 ? "var(--orange)" : "var(--green)" }}>
                    {fmtEUR(Math.max(0, r.net_vat_cents))}
                  </td>
                  <td><span className={"badge " + VAT_STATUTS[r.status]?.cls}>{VAT_STATUTS[r.status]?.icon} {VAT_STATUTS[r.status]?.label}</span></td>
                  <td style={{ textAlign: "right" }}>
                    {r.status === "ready" && <button className="btn btn-ghost btn-xs" onClick={() => markDeclared(r)}>Marquer déclarée</button>}
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

function regimeLabel(r) {
  return ({
    franchise: "Franchise",
    normal_monthly: "Réel normal mensuel (CA3)",
    normal_quarterly: "Réel normal trimestriel (CA3)",
    simplified: "Réel simplifié (CA12 annuelle)"
  })[r] || r;
}

function computeCurrentVatPeriod(regime) {
  const now = new Date();
  if (regime === "normal_monthly") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { start: start.toISOString().slice(0,10), end: end.toISOString().slice(0,10) };
  }
  if (regime === "normal_quarterly") {
    const m = now.getMonth();
    const qStartMonth = m < 3 ? 0 : m < 6 ? 3 : m < 9 ? 6 : 9;
    const start = new Date(now.getFullYear(), qStartMonth, 1);
    const end = new Date(now.getFullYear(), qStartMonth + 3, 0);
    return { start: start.toISOString().slice(0,10), end: end.toISOString().slice(0,10) };
  }
  if (regime === "simplified") {
    const start = new Date(now.getFullYear(), 0, 1);
    const end = new Date(now.getFullYear(), 11, 31);
    return { start: start.toISOString().slice(0,10), end: end.toISOString().slice(0,10) };
  }
  return null;
}
