import React, { useEffect, useMemo, useState } from "react";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtEUR, fmtDate, daysUntil } from "../../lib/helpers.js";
import { capture, bumpModuleUsage } from "../../lib/telemetry.js";

const VAT_STATUTS = {
  draft:       { label: "Brouillon",  cls: "badge-muted",  icon: "📝" },
  in_progress: { label: "En cours",   cls: "badge-gold",   icon: "🔄" },
  ready:       { label: "À valider",  cls: "badge-orange", icon: "⏰" },
  declared:    { label: "Déclarée",   cls: "badge-green",  icon: "✅" },
  paid:        { label: "Payée",      cls: "badge-green",  icon: "💰" }
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
          filter: `company_id=eq.${company.id}&status=in.(validated,paid,partial,pending)`,
          order: "issue_date.desc"
        })
      ]);
      if (!alive) return;
      const allReturns = r || [];
      setInvoices(i || []);
      setPurchases(p || []);

      // Auto-bascule : déclarations in_progress dont le mois est passé → ready
      const period = computeCurrentVatPeriod(company.vat_regime);
      const synced = await autoBasculeExpired(token, allReturns, period);
      if (!alive) return;
      setReturns(synced);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, company.id, company.vat_regime]);

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
    // TVA déductible : règle CGI art. 271
    // → on ne déduit que la TVA des achats PAYÉS (ou la part payée pour les partiels)
    const deductibleVAT = purchases
      .filter((p) => filterDate(p.issue_date))
      .reduce((s, p) => {
        if (p.status === "paid") {
          return s + (p.vat_total_cents || 0);
        }
        if (p.status === "partial" && p.total_ttc_cents > 0) {
          const ratio = (p.paid_cents || 0) / p.total_ttc_cents;
          return s + Math.round((p.vat_total_cents || 0) * ratio);
        }
        return s; // pending, validated, archived → pas deductible tant que pas paye
      }, 0);
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

  // SYNC AUTO de la déclaration in_progress du mois en cours
  // Dès qu'il y a au moins une facture ou un achat dans la période, on crée/MAJ
  useEffect(() => {
    if (loading || !currentPeriod || !stats) return;
    // Skip si déjà déclarée/payée (verrouillée)
    const lockedExisting = returns.find(
      (r) =>
        r.period_start === currentPeriod.start &&
        r.period_end === currentPeriod.end &&
        (r.status === "declared" || r.status === "paid" || r.status === "ready")
    );
    if (lockedExisting) return;

    // Skip si rien dans la période
    const hasActivity = stats.collectedHT > 0 || stats.deductibleVAT > 0;
    if (!hasActivity) return;

    let cancelled = false;
    (async () => {
      const formType = company.vat_regime === "simplified" ? "CA12" : "CA3";
      const existing = returns.find(
        (r) =>
          r.period_start === currentPeriod.start &&
          r.period_end === currentPeriod.end &&
          r.status === "in_progress"
      );
      const payload = {
        company_id: company.id,
        period_start: currentPeriod.start,
        period_end: currentPeriod.end,
        form_type: formType,
        collected_vat_cents: stats.collectedVAT,
        deductible_vat_cents: stats.deductibleVAT,
        net_vat_cents: stats.netVAT,
        taxable_base_cents: stats.collectedHT,
        breakdown: stats.breakdown,
        status: "in_progress",
        snapshot: {
          invoices_count: invoices.filter((i) => {
            const d = new Date(i.issue_date);
            return d >= new Date(currentPeriod.start) && d <= new Date(currentPeriod.end);
          }).length,
          purchases_count: purchases.filter((p) => {
            const d = new Date(p.issue_date);
            return d >= new Date(currentPeriod.start) && d <= new Date(currentPeriod.end);
          }).length,
          updated_at: new Date().toISOString()
        }
      };
      let result;
      if (existing) {
        result = await sb.update(token, "vat_returns", `id=eq.${existing.id}`, payload);
      } else {
        result = await sb.insert(token, "vat_returns", payload);
      }
      if (cancelled || !result || !result[0]) return;
      if (existing) {
        setReturns((prev) => prev.map((x) => (x.id === existing.id ? result[0] : x)));
      } else {
        setReturns((prev) => [result[0], ...prev]);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, stats?.collectedVAT, stats?.deductibleVAT, currentPeriod?.start, currentPeriod?.end]);


  // Bouton "Mettre à jour maintenant" — utile si l'utilisateur veut forcer
  // le recalcul (en pratique l'auto-sync devrait avoir déjà fait le job)
  async function generateReturn() {
    if (!currentPeriod || !stats) return;
    setGenerating(true);
    const formType = company.vat_regime === "simplified" ? "CA12" : "CA3";

    const existing = returns.find(
      (r) =>
        r.period_start === currentPeriod.start &&
        r.period_end === currentPeriod.end
    );

    if (existing && (existing.status === "declared" || existing.status === "paid")) {
      setGenerating(false);
      alert("Cette déclaration a déjà été transmise/payée. Impossible de la modifier.");
      return;
    }

    // On force le statut in_progress si on est sur le mois en cours et qu'il n'est pas fini
    const isMonthOver = new Date(currentPeriod.end) < new Date(new Date().toISOString().slice(0, 10));
    const newStatus = isMonthOver ? "ready" : "in_progress";

    const payload = {
      company_id: company.id,
      period_start: currentPeriod.start,
      period_end: currentPeriod.end,
      form_type: formType,
      collected_vat_cents: stats.collectedVAT,
      deductible_vat_cents: stats.deductibleVAT,
      net_vat_cents: stats.netVAT,
      taxable_base_cents: stats.collectedHT,
      breakdown: stats.breakdown,
      status: newStatus,
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
    };

    let result;
    if (existing) {
      result = await sb.update(token, "vat_returns", `id=eq.${existing.id}`, payload);
    } else {
      result = await sb.insert(token, "vat_returns", payload);
    }

    setGenerating(false);
    if (result && result[0]) {
      if (existing) {
        setReturns(returns.map((x) => (x.id === existing.id ? result[0] : x)));
      } else {
        setReturns([result[0], ...returns]);
      }
      capture("vat_return_generated", {
        form_type: formType,
        period_start: currentPeriod.start,
        period_end: currentPeriod.end,
        net_vat: stats.netVAT / 100,
        regenerated: !!existing
      });
      bumpModuleUsage(token, company.id, "vat");
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

  // Déclaration de la période en cours (si elle existe)
  const existingCurrent = currentPeriod
    ? returns.find(
        (r) =>
          r.period_start === currentPeriod.start &&
          r.period_end === currentPeriod.end
      )
    : null;
  const existingIsLocked =
    existingCurrent && (existingCurrent.status === "declared" || existingCurrent.status === "paid");

  // Déclarations en attente de validation (mois fini, statut ready)
  const pendingReturns = returns.filter((r) => r.status === "ready");

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">DÉCLARATIONS TVA</div>
          <div className="page-sub">
            Régime : {regimeLabel(company.vat_regime)}
            {currentPeriod && <> · Période en cours : {fmtDate(currentPeriod.start)} → {fmtDate(currentPeriod.end)}</>}
            {existingCurrent && existingCurrent.status === "in_progress" && (
              <> · <span style={{ color: "var(--gold)" }}>🔄 Mise à jour automatique</span></>
            )}
            {existingIsLocked && (
              <> · <span style={{ color: "var(--muted)" }}>Déjà transmise</span></>
            )}
          </div>
        </div>
        <button className="btn btn-primary" onClick={generateReturn} disabled={generating || existingIsLocked}>
          <Icon name="plus" size={14} /> {generating
            ? "Mise à jour..."
            : (existingCurrent ? "Recalculer maintenant" : "Initialiser la déclaration")}
        </button>
      </div>

      {/* Bandeau orange : déclarations à valider (mois fini) */}
      {pendingReturns.length > 0 && (
        <div style={{
          background: "rgba(255, 165, 0, 0.12)",
          border: "1px solid var(--orange)",
          borderLeft: "4px solid var(--orange)",
          borderRadius: 6,
          padding: "12px 16px",
          marginBottom: 18,
          display: "flex",
          alignItems: "center",
          gap: 12
        }}>
          <span style={{ fontSize: 20 }}>🔔</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--orange)" }}>
              {pendingReturns.length === 1
                ? "1 déclaration TVA à valider"
                : `${pendingReturns.length} déclarations TVA à valider`}
            </div>
            <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 2 }}>
              {pendingReturns.map((r) => `${fmtDate(r.period_start)} → ${fmtDate(r.period_end)}`).join(" · ")}
              {" — "}reportez les montants sur impots.gouv.fr puis cliquez « Marquer déclarée ».
            </div>
          </div>
        </div>
      )}
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

/**
 * Au chargement de la page, bascule en "ready" les déclarations
 * "in_progress" dont la période est passée (mois fini).
 * Renvoie la liste des déclarations à jour.
 */
async function autoBasculeExpired(token, returns, currentPeriod) {
  if (!returns || returns.length === 0) return returns;
  const today = new Date().toISOString().slice(0, 10);
  const toUpdate = returns.filter(
    (r) =>
      r.status === "in_progress" &&
      r.period_end < today &&
      // Sécurité : on ne bascule pas la période en cours
      !(currentPeriod && r.period_start === currentPeriod.start && r.period_end === currentPeriod.end)
  );
  if (toUpdate.length === 0) return returns;

  const updates = await Promise.all(
    toUpdate.map((r) =>
      sb.update(token, "vat_returns", `id=eq.${r.id}`, { status: "ready" })
    )
  );
  const updatedById = new Map();
  updates.forEach((u, i) => {
    if (u && u[0]) updatedById.set(toUpdate[i].id, u[0]);
  });
  return returns.map((r) => updatedById.get(r.id) || r);
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
