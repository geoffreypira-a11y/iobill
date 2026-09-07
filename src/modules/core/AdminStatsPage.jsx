import React, { useEffect, useState } from "react";
import { fmtEUR, fmtDate } from "../../lib/helpers.js";
import { sourceAppLabel } from "../../lib/sourceApps.js";

/**
 * AdminStatsPage — Vue business owner d'IO BILL (réservé is_admin).
 *
 * Affiche les métriques SaaS clés :
 *   • MRR / ARR
 *   • Nb abonnés actifs / essais / impayés
 *   • Churn 30j
 *   • Évolution mensuelle (12 derniers mois)
 *   • Funnel : inscrits → essai → payant
 *   • Alertes : essais qui expirent + impayés à relancer
 *   • Activité récente
 *
 * Tarifs : 14,90 € HT/mois (pro_monthly) ou 149 € HT/an (pro_yearly).
 */

const PRICE_MONTHLY = 14.90;
const PRICE_YEARLY = 149.00;
const PRICE_YEARLY_MONTHLY_EQUIV = PRICE_YEARLY / 12; // 12,42 €

export function AdminStatsPage({ token, company }) {
  const [loading, setLoading] = useState(true);
  const [companies, setCompanies] = useState([]);

  useEffect(() => {
    if (!company?.is_admin) { setLoading(false); return; }
    fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "list" })
    })
      .then((r) => r.json())
      .then((j) => { setCompanies(j.companies || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [token, company]);

  if (!company?.is_admin) {
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
    return (
      <div className="page">
        <div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Chargement...</div>
      </div>
    );
  }

  // ─── Calculs ─────────────────────────────────────────────
  const now = new Date();
  const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate() - 30);
  const weekFromNow = new Date(); weekFromNow.setDate(weekFromNow.getDate() + 7);

  // v8.133 — `sub_status='active'` ne veut PAS dire « paie ». `set_exempt`
  // pose active + is_exempt : une société exemptée rapporte 0 €. Elle était
  // pourtant comptée au tarif mensuel dans le MRR.
  //
  // Et une société pilotée par une app métier (IOCAR, IOBEAUTY…) n'a pas
  // d'abonnement Stripe propre : son accès IO BILL est inclus dans celui de
  // l'app source. Elle ne rapporte donc rien non plus au titre d'IO BILL —
  // elle se compte en « métiers actifs », pas en abonnés.
  const isIobill = (c) => !c.source_app || c.source_app === "iobill";

  const active = companies.filter((c) => c.sub_status === "active" && !c._archived);
  const exempt = active.filter((c) => isIobill(c) && c.is_exempt === true);
  const business = active.filter((c) => !isIobill(c));
  const paying = active.filter((c) => isIobill(c) && c.is_exempt !== true);

  // Répartition des comptes métiers par app source, pour le sous-titre.
  const businessByApp = business.reduce((acc, c) => {
    const label = sourceAppLabel(c.source_app) || "Autre";
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});
  const businessFoot = business.length === 0
    ? "aucun"
    : Object.entries(businessByApp).map(([k, n]) => `${k} : ${n}`).join(" · ");
  const trialing = companies.filter((c) => c.sub_status === "trialing" && !c._archived);
  const pastDue = companies.filter((c) => c.sub_status === "past_due" && !c._archived);
  const archived = companies.filter((c) => c._archived);
  const canceled30j = companies.filter((c) =>
    c.sub_status === "canceled"
    && c.payment_failed_at
    && new Date(c.payment_failed_at) >= monthAgo
  );

  // MRR : somme des équivalents mensuels, plan par plan.
  // `sub_plan` absent (abonnements antérieurs à la colonne) → mensuel, comme avant.
  const monthlyEquiv = (c) =>
    c.sub_plan === "pro_yearly" ? PRICE_YEARLY_MONTHLY_EQUIV : PRICE_MONTHLY;
  const mrr = paying.reduce((sum, c) => sum + monthlyEquiv(c), 0);
  const arr = mrr * 12;
  const unknownPlan = paying.filter((c) => !c.sub_plan).length;

  // Nouvelles inscriptions ce mois
  const newThisMonth = companies.filter((c) =>
    c.created_at && new Date(c.created_at) >= monthAgo
  );

  // Funnel : tous inscrits, ont démarré l'essai, ont payé, encore actifs
  const totalSignups = companies.length;
  const startedTrial = companies.filter((c) => c.subscribed_at || c.sub_status === "trialing" || c.sub_status === "active").length;
  // Un exempté n'a jamais payé : il ne compte ni en converti, ni en retenu.
  // Sans ça, 6 actifs pour 1 converti donnaient « rétention 600 % ».
  const converted = companies.filter((c) =>
    c.subscribed_at && c.is_exempt !== true && isIobill(c)).length;
  const stillActive = paying.length;
  const trialToPaidRate = startedTrial > 0 ? (converted / startedTrial * 100) : 0;
  const retentionRate = converted > 0 ? (stillActive / converted * 100) : 0;

  // Essais qui expirent bientôt
  const trialsExpiringSoon = trialing.filter((c) =>
    c.trial_ends_at && new Date(c.trial_ends_at) <= weekFromNow
  );

  // Évolution sur 12 derniers mois (mois calendaires)
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const nextMonth = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const label = d.toLocaleDateString("fr-FR", { month: "short", year: "2-digit" });
    const signupsCount = companies.filter((c) => {
      if (!c.created_at) return false;
      const cd = new Date(c.created_at);
      return cd >= d && cd < nextMonth;
    }).length;
    const subsCount = companies.filter((c) => {
      if (!c.subscribed_at) return false;
      const sd = new Date(c.subscribed_at);
      return sd >= d && sd < nextMonth;
    }).length;
    // Abonnés actifs à la fin du mois (estim.) : ceux qui se sont abonnés avant ou pendant ET pas annulés avant
    const activeAtEnd = companies.filter((c) => {
      if (!c.subscribed_at || c.is_exempt === true || !isIobill(c)) return false;
      if (new Date(c.subscribed_at) >= nextMonth) return false;
      // Considéré actif si pas canceled (approximation)
      return c.sub_status === "active" || (c.sub_status === "canceled" && c.payment_failed_at && new Date(c.payment_failed_at) >= nextMonth);
    }).reduce((sum, c) => sum + monthlyEquiv(c), 0);
    months.push({ label, signups: signupsCount, subs: subsCount, mrr: activeAtEnd });
  }
  const maxMrr = Math.max(...months.map((m) => m.mrr), 1);

  // 5 derniers signups
  const recentSignups = [...companies]
    .filter((c) => c.created_at)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 5);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">📊 Stats Business IO BILL</div>
          <div className="page-sub">MRR, ARR, abonnés, churn — vue éditeur SaaS</div>
        </div>
      </div>

      {/* ─── KPIs principaux ─── */}
      <div className="kpi-grid" style={{ marginBottom: 18, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        <Kpi label="MRR" value={fmtCurrency(mrr)} color="gold" big
             foot={`${paying.length} abonné${paying.length > 1 ? "s" : ""} payant${paying.length > 1 ? "s" : ""}`
               + (exempt.length > 0 ? ` · ${exempt.length} exempté${exempt.length > 1 ? "s" : ""}` : "")} />
        <Kpi label="ARR" value={fmtCurrency(arr)} foot="× 12 mois" />
        <Kpi label="Métiers actifs" value={business.length} color="muted" foot={businessFoot} />
        <Kpi label="En essai" value={trialing.length} color="green" foot={trialsExpiringSoon.length > 0 ? `⚠ ${trialsExpiringSoon.length} expire${trialsExpiringSoon.length > 1 ? "nt" : ""} cette semaine` : "OK"} />
        <Kpi label="Impayés" value={pastDue.length} color={pastDue.length > 0 ? "red" : "muted"} foot={pastDue.length > 0 ? "à relancer" : "✓"} />
        <Kpi label="Churn 30j" value={canceled30j.length} color={canceled30j.length > 0 ? "red" : "muted"} foot={canceled30j.length === 0 ? "0 départ ce mois" : "désinscriptions"} />
        <Kpi label="Signups 30j" value={newThisMonth.length} color="green" foot="acquisitions" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 18, marginBottom: 18 }}>
        {/* ─── Graphique évolution ─── */}
        <div className="card card-pad">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16 }}>📈 Évolution MRR sur 12 mois</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 180, paddingBottom: 24, position: "relative" }}>
            {months.map((m, idx) => {
              const h = (m.mrr / maxMrr) * 100;
              return (
                <div key={idx} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }} title={`${m.label} : ${fmtCurrency(m.mrr)}`}>
                  <div style={{ fontSize: 9, color: "var(--muted)" }}>{m.mrr > 0 ? Math.round(m.mrr) : ""}</div>
                  <div style={{
                    width: "100%",
                    height: `${h}%`,
                    minHeight: m.mrr > 0 ? 2 : 0,
                    background: "linear-gradient(to top, var(--gold, #d4a843), rgba(212,168,67,0.5))",
                    borderRadius: "4px 4px 0 0",
                    transition: "all 0.3s"
                  }} />
                  <div style={{ fontSize: 9, color: "var(--muted)", textTransform: "capitalize" }}>{m.label}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* ─── Funnel ─── */}
        <div className="card card-pad">
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 16 }}>🎯 Funnel de conversion</div>
          <FunnelStep label="Inscrits total" value={totalSignups} pct={100} />
          <FunnelStep label="Ont démarré essai" value={startedTrial} pct={totalSignups > 0 ? startedTrial / totalSignups * 100 : 0} />
          <FunnelStep label="Convertis en payants" value={converted} pct={totalSignups > 0 ? converted / totalSignups * 100 : 0} highlight />
          <FunnelStep label="Encore actifs" value={stillActive} pct={totalSignups > 0 ? stillActive / totalSignups * 100 : 0} />
          <div style={{ marginTop: 12, padding: 10, background: "rgba(212,168,67,0.06)", borderRadius: 6, fontSize: 11 }}>
            <div>🎯 Essai → payant : <strong>{trialToPaidRate.toFixed(1)}%</strong></div>
            <div>💚 Rétention payant : <strong>{retentionRate.toFixed(1)}%</strong></div>
          </div>
        </div>
      </div>

      {/* ─── Alertes ─── */}
      {(trialsExpiringSoon.length > 0 || pastDue.length > 0 || canceled30j.length > 0) && (
        <div className="card card-pad" style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>🔔 Alertes</div>

          {trialsExpiringSoon.length > 0 && (
            <AlertSection
              icon="🟡"
              title={`${trialsExpiringSoon.length} essai${trialsExpiringSoon.length > 1 ? "s" : ""} expire${trialsExpiringSoon.length > 1 ? "nt" : ""} dans 7 jours`}
              items={trialsExpiringSoon.map((c) => ({
                primary: c.legal_name || c.email,
                secondary: c.trial_ends_at ? "Fin essai : " + fmtDate(c.trial_ends_at) : "—"
              }))}
            />
          )}

          {pastDue.length > 0 && (
            <AlertSection
              icon="🔴"
              title={`${pastDue.length} impayé${pastDue.length > 1 ? "s" : ""} à relancer`}
              items={pastDue.map((c) => ({
                primary: c.legal_name || c.email,
                secondary: c.payment_failed_at ? "Impayé depuis " + fmtDate(c.payment_failed_at) : "—"
              }))}
            />
          )}

          {canceled30j.length > 0 && (
            <AlertSection
              icon="⚪"
              title={`${canceled30j.length} désinscription${canceled30j.length > 1 ? "s" : ""} ce mois`}
              items={canceled30j.map((c) => ({
                primary: c.legal_name || c.email,
                secondary: "Annulé le " + fmtDate(c.payment_failed_at)
              }))}
            />
          )}
        </div>
      )}

      {/* ─── Activité récente ─── */}
      <div className="card card-pad">
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>🆕 Derniers signups</div>
        {recentSignups.length === 0 ? (
          <div style={{ color: "var(--muted)", fontSize: 12 }}>Aucune inscription récente.</div>
        ) : recentSignups.map((c) => (
          <div key={c.id} style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            padding: "8px 0", borderBottom: "1px dashed rgba(255,255,255,0.04)", fontSize: 12
          }}>
            <span><strong>{c.legal_name || c.email || "—"}</strong> <span style={{ color: "var(--muted)" }}>· {c.email}</span></span>
            <span style={{ color: "var(--muted)" }}>{fmtDate(c.created_at)} · <StatusPill status={c.sub_status} /></span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 16, fontSize: 11, color: "var(--muted)", textAlign: "center", lineHeight: 1.7 }}>
        MRR = somme des équivalents mensuels des abonnés <strong>payants</strong> :
        {" "}Pro mensuel {fmtCurrency(PRICE_MONTHLY)} HT,
        {" "}Pro annuel {fmtCurrency(PRICE_YEARLY)} HT ≈ {fmtCurrency(PRICE_YEARLY_MONTHLY_EQUIV)}/mois.
        {" "}Les sociétés exemptées et les comptes pilotés par une app métier
        {" "}(IO CAR, IO BEAUTY…) sont exclus : ils ne paient pas d'abonnement IO BILL.
        {unknownPlan > 0 && (
          <><br />⚠ {unknownPlan} abonnement{unknownPlan > 1 ? "s" : ""} sans plan connu
          {" "}(souscrit avant l'enregistrement du plan) compté{unknownPlan > 1 ? "s" : ""} en mensuel.
          {" "}À corriger en base via <code>sub_plan</code>.</>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// Helpers UI
// ═══════════════════════════════════════════════════════════
function Kpi({ label, value, color = "default", foot, big }) {
  const colorMap = { gold: "var(--gold)", green: "var(--green, #3ecf7a)", red: "var(--red, #e0556a)", muted: "var(--muted)" };
  return (
    <div className="kpi" style={big ? { padding: 16 } : {}}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-val" style={{ color: colorMap[color] || "var(--text)", fontSize: big ? 28 : 22 }}>{value}</div>
      {foot && <div className="kpi-foot" style={{ fontSize: 10 }}>{foot}</div>}
    </div>
  );
}

function FunnelStep({ label, value, pct, highlight }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
        <span style={{ color: highlight ? "var(--gold)" : "var(--text)", fontWeight: highlight ? 600 : 400 }}>{label}</span>
        <span style={{ fontFamily: "monospace" }}>{value} · {pct.toFixed(0)}%</span>
      </div>
      <div style={{ height: 8, background: "rgba(255,255,255,0.05)", borderRadius: 4, overflow: "hidden" }}>
        <div style={{
          width: `${Math.min(pct, 100)}%`,
          height: "100%",
          background: highlight ? "var(--gold)" : "rgba(62,207,122,0.6)",
          transition: "width 0.3s"
        }} />
      </div>
    </div>
  );
}

function AlertSection({ icon, title, items }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{icon} {title}</div>
      <div style={{ fontSize: 11, paddingLeft: 22 }}>
        {items.slice(0, 5).map((it, i) => (
          <div key={i} style={{ padding: "4px 0", color: "var(--muted2)" }}>
            <strong style={{ color: "var(--text)" }}>{it.primary}</strong> <span style={{ color: "var(--muted)" }}>· {it.secondary}</span>
          </div>
        ))}
        {items.length > 5 && <div style={{ color: "var(--muted)", fontSize: 10 }}>…et {items.length - 5} autre{items.length - 5 > 1 ? "s" : ""}</div>}
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const map = {
    active: { label: "Abonné", color: "var(--green, #3ecf7a)" },
    trialing: { label: "Essai", color: "var(--gold)" },
    past_due: { label: "Impayé", color: "var(--orange)" },
    canceled: { label: "Annulé", color: "var(--red, #e0556a)" }
  };
  const s = map[status] || { label: status || "—", color: "var(--muted)" };
  return <span style={{ color: s.color, fontSize: 11 }}>{s.label}</span>;
}

function fmtCurrency(value) {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value);
}
