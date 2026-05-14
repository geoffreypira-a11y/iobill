import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { fmtEUR, fmtDate, daysUntil } from "../../lib/helpers.js";
import { Icon } from "../../components/Icon.jsx";
import { useT } from "../../lib/i18n.js";
import { DashboardCharts, TopClientsChart } from "./DashboardCharts.jsx";

export function DashboardPage({ token, company }) {
  const t = useT();
  const [stats, setStats] = useState(null);
  const [microProgress, setMicroProgress] = useState(null);
  const [recentInvoices, setRecentInvoices] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [s, m, inv] = await Promise.all([
        sb.rpc(token, "dashboard_stats"),
        company?.legal_form === "micro" ? sb.rpc(token, "micro_threshold_progress") : Promise.resolve(null),
        sb.select(token, "invoices", {
          filter: `company_id=eq.${company.id}`,
          order: "created_at.desc",
          limit: 5
        })
      ]);
      if (!alive) return;
      setStats(s || {});
      setMicroProgress(m);
      setRecentInvoices(inv || []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, company.id, company.legal_form]);

  const firstName = (company?.legal_name || "").split(" ")[0] || "à vous";
  const month = new Date().toLocaleDateString("fr-FR", { month: "long", year: "numeric" });

  // Fiscal countdown helpers
  const nextVatDeadline = computeNextVatDeadline(company?.vat_regime);
  const nextUrssafDeadline = computeNextUrssafDeadline(company?.urssaf_period);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">{t("Tableau de bord").toUpperCase()}</div>
          <div className="page-sub">{t("Bonjour {name}, voici où vous en êtes en {month}", { name: firstName, month })}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link to="/quotes?new=1" className="btn btn-primary">
            <Icon name="plus" size={14} />
            {t("Nouveau devis") || "Nouveau devis"}
          </Link>
        </div>
      </div>

      {/* KPI */}
      <div className="kpi-grid">
        <div className="kpi">
          <div className="kpi-label">{t("CA HT — ce mois") || "CA HT — ce mois"}</div>
          <div className="kpi-val gold">{loading ? "—" : fmtEUR(stats?.ca_ht_month_cents)}</div>
          <div className="kpi-foot">
            {loading ? "" : `${t("Année")} : ${fmtEUR(stats?.ca_ht_year_cents)}`}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">{t("À encaisser") || "À encaisser"}</div>
          <div className="kpi-val orange">{loading ? "—" : fmtEUR(stats?.unpaid_cents)}</div>
          <div className="kpi-foot">
            {loading ? "" : `${stats?.unpaid_count || 0} ${t("facture(s) en attente")}`}
          </div>
        </div>
        {company.modules?.vat && (
          <div className="kpi">
            <div className="kpi-label">{t("TVA collectée") + " (" + t("Mois").toLowerCase() + ")"}</div>
            <div className="kpi-val">{loading ? "—" : fmtEUR(stats?.vat_collected_pending_cents)}</div>
            <div className="kpi-foot">{t("À déclarer prochainement") || "À déclarer prochainement"}</div>
          </div>
        )}
        <div className="kpi">
          <div className="kpi-label">{t("DSO moyen")}</div>
          <div className="kpi-val green">{loading ? "—" : (stats?.dso_days || 0) + " j"}</div>
          <div className="kpi-foot">{t("Délai de paiement moyen")}</div>
        </div>
      </div>

      {/* Row 1.5 : Graphiques */}
      <DashboardCharts token={token} company={company} />
      <TopClientsChart token={token} company={company} />

      {/* Row 2: factures récentes + cockpit fiscal */}
      <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16, marginBottom: 16 }}>
        <div className="card card-pad">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase" }}>
              Dernières factures
            </div>
            <Link to="/invoices" style={{ fontSize: 11, color: "var(--gold)", textDecoration: "none", fontWeight: 500 }}>
              Voir tout →
            </Link>
          </div>
          {recentInvoices.length === 0 ? (
            <EmptyState
              text="Aucune facture pour l'instant."
              cta={<Link to="/quotes?new=1" className="btn btn-primary btn-sm">Créer un premier devis</Link>}
            />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>N°</th>
                  <th>Client</th>
                  <th style={{ textAlign: "right" }}>Montant</th>
                  <th>Statut</th>
                </tr>
              </thead>
              <tbody>
                {recentInvoices.map((inv) => (
                  <tr key={inv.id}>
                    <td className="mono">{inv.number}</td>
                    <td>{inv.client_snapshot?.legal_name || inv.client_snapshot?.name || "—"}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(inv.total_ttc_cents)}</td>
                    <td><InvoiceStatusBadge status={inv.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card card-pad">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase" }}>
              Cockpit fiscal
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {company.modules?.vat && nextVatDeadline && (
              <CountdownRow
                label="Déclaration TVA — CA3"
                days={nextVatDeadline.days}
                date={nextVatDeadline.date}
              />
            )}
            {company.modules?.urssaf && nextUrssafDeadline && (
              <CountdownRow
                label={`URSSAF ${company.urssaf_period === "quarterly" ? "trimestrielle" : "mensuelle"}`}
                days={nextUrssafDeadline.days}
                date={nextUrssafDeadline.date}
              />
            )}
            {microProgress?.threshold_cents && (
              <ThresholdRow
                pct={microProgress.pct}
                ca={microProgress.ca_ytd_cents}
                threshold={microProgress.threshold_cents}
              />
            )}
          </div>
          {microProgress?.pct > 75 && (
            <div className="tipline" style={{ marginTop: 14 }}>
              <Icon name="alert" size={14} />
              Vous approchez du seuil de franchise TVA. Surveillez la suite de l'année.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CountdownRow({ label, days, date }) {
  const color = days < 0 ? "var(--red)" : days < 7 ? "var(--orange)" : "var(--gold)";
  const pct = days >= 0 ? Math.max(5, Math.min(100, 100 - (days / 30) * 100)) : 100;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
        <span style={{ fontSize: 11, color: "var(--muted2)" }}>{label}</span>
        <span style={{ fontFamily: "Syne, sans-serif", fontSize: 17, fontWeight: 700, color }}>
          {days < 0 ? "En retard" : days === 0 ? "Aujourd'hui" : `${days} j`}
        </span>
      </div>
      <div className="progress">
        <div
          className={"progress-bar" + (days < 7 ? " warn" : "") + (days < 0 ? " danger" : "")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>
        Échéance : {fmtDate(date)}
      </div>
    </div>
  );
}

function ThresholdRow({ pct, ca, threshold }) {
  const color = pct > 90 ? "var(--red)" : pct > 75 ? "var(--orange)" : "var(--gold)";
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
        <span style={{ fontSize: 11, color: "var(--muted2)" }}>Seuil franchise TVA</span>
        <span style={{ fontFamily: "Syne, sans-serif", fontSize: 17, fontWeight: 700, color }}>
          {pct}%
        </span>
      </div>
      <div className="progress">
        <div
          className={"progress-bar" + (pct > 75 ? " warn" : "") + (pct > 90 ? " danger" : "")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>
        {fmtEUR(ca)} sur {fmtEUR(threshold)}
      </div>
    </div>
  );
}

function InvoiceStatusBadge({ status }) {
  const map = {
    draft: { cls: "badge-muted", label: "Brouillon" },
    issued: { cls: "badge-gold", label: "Émise" },
    sent: { cls: "badge-gold", label: "Envoyée" },
    partial: { cls: "badge-orange", label: "Partielle" },
    paid: { cls: "badge-green", label: "Payée" },
    overdue: { cls: "badge-red", label: "En retard" },
    canceled: { cls: "badge-muted", label: "Annulée" }
  };
  const s = map[status] || { cls: "badge-muted", label: status };
  return <span className={"badge " + s.cls}>{s.label}</span>;
}

function EmptyState({ text, cta }) {
  return (
    <div style={{ textAlign: "center", padding: "32px 12px", color: "var(--muted)" }}>
      <div style={{ marginBottom: 12, fontSize: 13 }}>{text}</div>
      {cta}
    </div>
  );
}

/* ─── Helpers : prochaines échéances fiscales ──────────────── */
function computeNextVatDeadline(regime) {
  if (!regime || regime === "franchise") return null;
  const today = new Date();
  if (regime === "simplified") {
    // CA12 : 2e jour ouvré apres le 1er mai (annuel)
    const y = today.getMonth() < 4 ? today.getFullYear() : today.getFullYear() + 1;
    const date = new Date(y, 4, 5);
    return { date: date.toISOString().slice(0, 10), days: daysUntil(date) };
  }
  if (regime === "normal_quarterly") {
    // 19 du mois suivant la fin de trimestre
    const m = today.getMonth();
    const quarterEnd = m < 3 ? 2 : m < 6 ? 5 : m < 9 ? 8 : 11;
    let nextDeadline = new Date(today.getFullYear(), quarterEnd + 1, 19);
    if (nextDeadline < today) nextDeadline = new Date(today.getFullYear(), quarterEnd + 4, 19);
    return { date: nextDeadline.toISOString().slice(0, 10), days: daysUntil(nextDeadline) };
  }
  // mensuel : entre le 15 et 24 du mois selon dpt - on prend le 19 par defaut
  let next = new Date(today.getFullYear(), today.getMonth(), 19);
  if (next < today) next = new Date(today.getFullYear(), today.getMonth() + 1, 19);
  return { date: next.toISOString().slice(0, 10), days: daysUntil(next) };
}

function computeNextUrssafDeadline(period) {
  const today = new Date();
  if (period === "quarterly") {
    // 30 du mois suivant la fin de trimestre
    const m = today.getMonth();
    const quarterEnd = m < 3 ? 2 : m < 6 ? 5 : m < 9 ? 8 : 11;
    let next = new Date(today.getFullYear(), quarterEnd + 2, 0); // dernier jour du mois suivant
    if (next < today) next = new Date(today.getFullYear(), quarterEnd + 5, 0);
    return { date: next.toISOString().slice(0, 10), days: daysUntil(next) };
  }
  // mensuel : dernier jour du mois suivant
  let next = new Date(today.getFullYear(), today.getMonth() + 2, 0);
  if (next < today) next = new Date(today.getFullYear(), today.getMonth() + 3, 0);
  return { date: next.toISOString().slice(0, 10), days: daysUntil(next) };
}
