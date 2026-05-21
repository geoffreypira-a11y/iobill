import React, { useEffect, useState } from "react";
import { useParams, useNavigate, Navigate } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { useMyFirm } from "../../components/FirmMode.jsx";
import { fmtEUR, fmtDate } from "../../lib/helpers.js";
import { SignalButton } from "../../components/SignalButton.jsx";

/**
 * FirmClientFichePage — v8.27 Sprint 3
 * Vue lecture client avec 4 onglets : Vue d'ensemble, Factures, Achats, TVA & URSSAF
 * + Signalements universels
 */
export function FirmClientFichePage({ token, user, company }) {
  const { linkId } = useParams();
  const navigate = useNavigate();
  const { loading: firmLoading, firm } = useMyFirm(token, user?.id);
  const [link, setLink] = useState(null);
  const [clientCompany, setClientCompany] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("overview");
  const [signals, setSignals] = useState([]);

  async function load() {
    if (!firm?.id || !linkId) return;
    setLoading(true);

    const l = await sb.selectOne(token, "firm_client_links", `id=eq.${linkId}`, "*");
    if (!l) { setLoading(false); return; }
    setLink(l);

    if (l.company_id) {
      const c = await sb.selectOne(token, "companies", `id=eq.${l.company_id}`, "*");
      setClientCompany(c);
    }

    // Charger les signalements ouverts
    const sigs = await sb.select(token, "firm_signals", {
      filter: `firm_id=eq.${firm.id}&company_id=eq.${l.company_id}`,
      select: "*",
      order: "created_at.desc",
      limit: 100
    });
    setSignals(sigs || []);

    setLoading(false);
  }

  useEffect(() => { load(); }, [firm?.id, linkId]);

  if (firmLoading || loading) {
    return <div style={loadingStyle}>Chargement...</div>;
  }
  if (!firm) return <Navigate to="/firm" replace />;
  if (!link || !clientCompany) {
    return (
      <div style={{ maxWidth: 700, margin: "60px auto", padding: 20, textAlign: "center" }}>
        <div className="card card-pad">
          <div style={{ fontSize: 48, marginBottom: 12 }}>⚠️</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Client introuvable</div>
          <button className="btn btn-primary" onClick={() => navigate("/firm/clients")} style={{ marginTop: 16 }}>
            ← Retour à la liste
          </button>
        </div>
      </div>
    );
  }

  if (link.status !== "accepted") {
    return (
      <div style={{ maxWidth: 700, margin: "60px auto", padding: 20, textAlign: "center" }}>
        <div className="card card-pad">
          <div style={{ fontSize: 48, marginBottom: 12 }}>⏳</div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Liaison non active</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>
            Status actuel : <strong>{link.status}</strong>
          </div>
          <button className="btn btn-ghost" onClick={() => navigate("/firm/clients")} style={{ marginTop: 16 }}>
            ← Retour
          </button>
        </div>
      </div>
    );
  }

  const openSignals = signals.filter((s) => s.status === "open");

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "20px 24px" }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate("/firm/clients")} style={{ marginBottom: 12 }}>
          ← Mes clients
        </button>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ fontFamily: "Syne, sans-serif", fontSize: 32, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
              {clientCompany.legal_name?.toUpperCase()}
            </h1>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
              SIRET {clientCompany.siret} · {clientCompany.legal_form || "—"} · Lié depuis le {fmtDate(link.accepted_at)}
            </div>
          </div>
          <SignalButton
            token={token}
            firm_id={firm.id}
            company_id={clientCompany.id}
            target_type="general"
            targetLabel={`${clientCompany.legal_name} (général)`}
            onCreated={load}
          />
        </div>
      </div>

      {/* Bandeau signalements ouverts */}
      {openSignals.length > 0 && (
        <div className="card" style={{ padding: 12, marginBottom: 16, background: "rgba(229,151,60,0.08)", border: "1px solid rgba(229,151,60,0.3)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontSize: 12, color: "var(--orange)" }}>
              ⚠️ {openSignals.length} signalement{openSignals.length > 1 ? "s" : ""} ouvert{openSignals.length > 1 ? "s" : ""} sur ce client
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => setTab("signals")}>
              Voir →
            </button>
          </div>
        </div>
      )}

      {/* Onglets */}
      <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: "1px solid rgba(255,255,255,0.08)", overflowX: "auto" }}>
        {[
          { key: "overview", label: "Vue d'ensemble" },
          { key: "invoices", label: "Factures" },
          { key: "purchases", label: "Achats" },
          { key: "vat", label: "TVA & URSSAF" },
          { key: "signals", label: `Signalements${openSignals.length > 0 ? ` (${openSignals.length})` : ""}` }
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: "10px 16px",
              background: "transparent",
              border: "none",
              color: tab === t.key ? "var(--gold)" : "var(--muted)",
              fontSize: 13,
              fontWeight: tab === t.key ? 600 : 400,
              cursor: "pointer",
              borderBottom: tab === t.key ? "2px solid var(--gold)" : "2px solid transparent",
              marginBottom: -1,
              whiteSpace: "nowrap"
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Contenu */}
      {tab === "overview" && <OverviewTab token={token} firm={firm} company={clientCompany} signals={openSignals} />}
      {tab === "invoices" && <InvoicesTab token={token} firm={firm} company={clientCompany} signals={signals} onSignalCreated={load} />}
      {tab === "purchases" && <PurchasesTab token={token} firm={firm} company={clientCompany} signals={signals} onSignalCreated={load} />}
      {tab === "vat" && <VatTab token={token} firm={firm} company={clientCompany} />}
      {tab === "signals" && <SignalsTab token={token} signals={signals} onAction={load} />}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// Onglet : Vue d'ensemble
// ════════════════════════════════════════════════════════════════

function OverviewTab({ token, firm, company, signals }) {
  const [kpis, setKpis] = useState(null);

  async function load() {
    // Période en cours = mois en cours
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

    // CA facturé (toutes factures issued sur la période)
    const invoices = await sb.select(token, "invoices", {
      filter: `company_id=eq.${company.id}&issue_date=gte.${firstDay}&issue_date=lte.${lastDay}&status=in.(issued,sent,partial,paid,overdue)`,
      select: "subtotal_ht_cents,vat_total_cents,total_ttc_cents,paid_cents,status"
    });

    let caFactureCents = 0;
    let caCollecteCents = 0;
    let tvaCollecteeCents = 0;
    for (const inv of (invoices || [])) {
      caFactureCents += inv.subtotal_ht_cents || 0;
      tvaCollecteeCents += inv.vat_total_cents || 0;
      caCollecteCents += inv.paid_cents || 0;
    }

    // Achats
    const purchases = await sb.select(token, "purchases", {
      filter: `company_id=eq.${company.id}&issue_date=gte.${firstDay}&issue_date=lte.${lastDay}`,
      select: "subtotal_ht_cents,vat_total_cents"
    });

    let achatsHtCents = 0;
    let tvaDeductibleCents = 0;
    for (const p of (purchases || [])) {
      achatsHtCents += p.subtotal_ht_cents || 0;
      tvaDeductibleCents += p.vat_total_cents || 0;
    }

    setKpis({
      periode: `${fmtDate(firstDay)} → ${fmtDate(lastDay)}`,
      caFactureCents,
      caCollecteCents,
      tvaCollecteeCents,
      tvaDeductibleCents,
      tvaNetteCents: tvaCollecteeCents - tvaDeductibleCents,
      achatsHtCents,
      nbFactures: invoices?.length || 0,
      nbAchats: purchases?.length || 0
    });
  }

  useEffect(() => { load(); }, [company?.id]);

  if (!kpis) return <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>Chargement KPIs...</div>;

  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 12 }}>
        📅 Période : {kpis.periode}
      </div>

      {/* Grille KPIs déclaratifs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginBottom: 24 }}>
        <KpiCard label="CA HT facturé" value={fmtEUR(kpis.caFactureCents / 100)} sub={`${kpis.nbFactures} facture${kpis.nbFactures > 1 ? "s" : ""}`} />
        <KpiCard label="CA TTC encaissé" value={fmtEUR(kpis.caCollecteCents / 100)} sub="Effectivement payé" />
        <KpiCard label="TVA collectée" value={fmtEUR(kpis.tvaCollecteeCents / 100)} sub="À reverser" />
        <KpiCard label="TVA déductible" value={fmtEUR(kpis.tvaDeductibleCents / 100)} sub="Sur achats" />
        <KpiCard label="TVA nette" value={fmtEUR(kpis.tvaNetteCents / 100)} sub={kpis.tvaNetteCents >= 0 ? "À déclarer" : "Crédit TVA"} highlight />
        <KpiCard label="Achats HT" value={fmtEUR(kpis.achatsHtCents / 100)} sub={`${kpis.nbAchats} achat${kpis.nbAchats > 1 ? "s" : ""}`} />
      </div>

      {signals.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <h3 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 1, color: "var(--muted)", margin: "0 0 12px 0" }}>
            ⚠️ Signalements ouverts ({signals.length})
          </h3>
          {signals.slice(0, 3).map((s) => (
            <div key={s.id} style={{ padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,0.04)", fontSize: 12 }}>
              {SEV_EMOJI[s.severity]} <strong>{s.title}</strong> · {fmtDate(s.created_at)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function KpiCard({ label, value, sub, highlight }) {
  return (
    <div className="card" style={{ padding: 14, ...(highlight ? { background: "rgba(212,168,67,0.08)", border: "1px solid rgba(212,168,67,0.3)" } : {}) }}>
      <div style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: highlight ? "var(--gold)" : "var(--text)", fontFamily: "Syne, sans-serif", letterSpacing: "-0.02em" }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "var(--muted2)", marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// Onglet : Factures
// ════════════════════════════════════════════════════════════════

function InvoicesTab({ token, firm, company, signals, onSignalCreated }) {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const rows = await sb.select(token, "invoices", {
      filter: `company_id=eq.${company.id}`,
      select: "id,number,issue_date,due_date,status,subtotal_ht_cents,vat_total_cents,total_ttc_cents,paid_cents",
      order: "issue_date.desc",
      limit: 100
    });
    setInvoices(rows || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, [company?.id]);

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>Chargement...</div>;
  if (invoices.length === 0) return <EmptyTab text="Aucune facture sur ce client" />;

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th>N°</th>
              <th>Date</th>
              <th>Échéance</th>
              <th style={{ textAlign: "right" }}>HT</th>
              <th style={{ textAlign: "right" }}>TVA</th>
              <th style={{ textAlign: "right" }}>TTC</th>
              <th>Statut</th>
              <th style={{ textAlign: "right" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => {
              const invSignals = signals.filter((s) => s.target_type === "invoice" && s.target_id === inv.id && s.status === "open");
              return (
                <tr key={inv.id}>
                  <td>
                    <span style={{ fontFamily: "monospace" }}>{inv.number}</span>
                    {invSignals.length > 0 && (
                      <span style={{ marginLeft: 6 }} title={invSignals.map((s) => s.title).join("\n")}>
                        {SEV_EMOJI[invSignals[0].severity]}
                      </span>
                    )}
                  </td>
                  <td>{fmtDate(inv.issue_date)}</td>
                  <td>{fmtDate(inv.due_date)}</td>
                  <td style={{ textAlign: "right", fontFamily: "monospace" }}>{fmtEUR((inv.subtotal_ht_cents || 0) / 100)}</td>
                  <td style={{ textAlign: "right", fontFamily: "monospace" }}>{fmtEUR((inv.vat_total_cents || 0) / 100)}</td>
                  <td style={{ textAlign: "right", fontFamily: "monospace", fontWeight: 600 }}>{fmtEUR((inv.total_ttc_cents || 0) / 100)}</td>
                  <td><StatusBadge status={inv.status} /></td>
                  <td style={{ textAlign: "right" }}>
                    <SignalButton
                      token={token}
                      firm_id={firm.id}
                      company_id={company.id}
                      target_type="invoice"
                      target_id={inv.id}
                      targetLabel={`Facture ${inv.number}`}
                      compact
                      onCreated={onSignalCreated}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// Onglet : Achats
// ════════════════════════════════════════════════════════════════

function PurchasesTab({ token, firm, company, signals, onSignalCreated }) {
  const [purchases, setPurchases] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    const rows = await sb.select(token, "purchases", {
      filter: `company_id=eq.${company.id}`,
      select: "id,number,vendor_name,issue_date,due_date,subtotal_ht_cents,vat_total_cents,total_ttc_cents,category",
      order: "issue_date.desc",
      limit: 100
    });
    setPurchases(rows || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, [company?.id]);

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>Chargement...</div>;
  if (purchases.length === 0) return <EmptyTab text="Aucun achat sur ce client" />;

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th>N°</th>
              <th>Fournisseur</th>
              <th>Date</th>
              <th>Catégorie</th>
              <th style={{ textAlign: "right" }}>HT</th>
              <th style={{ textAlign: "right" }}>TVA</th>
              <th style={{ textAlign: "right" }}>TTC</th>
              <th style={{ textAlign: "right" }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {purchases.map((p) => {
              const pSignals = signals.filter((s) => s.target_type === "purchase" && s.target_id === p.id && s.status === "open");
              return (
                <tr key={p.id}>
                  <td>
                    <span style={{ fontFamily: "monospace" }}>{p.number || "—"}</span>
                    {pSignals.length > 0 && (
                      <span style={{ marginLeft: 6 }} title={pSignals.map((s) => s.title).join("\n")}>
                        {SEV_EMOJI[pSignals[0].severity]}
                      </span>
                    )}
                  </td>
                  <td>{p.vendor_name}</td>
                  <td>{fmtDate(p.issue_date)}</td>
                  <td style={{ fontSize: 11, color: "var(--muted2)" }}>{p.category || "—"}</td>
                  <td style={{ textAlign: "right", fontFamily: "monospace" }}>{fmtEUR((p.subtotal_ht_cents || 0) / 100)}</td>
                  <td style={{ textAlign: "right", fontFamily: "monospace" }}>{fmtEUR((p.vat_total_cents || 0) / 100)}</td>
                  <td style={{ textAlign: "right", fontFamily: "monospace", fontWeight: 600 }}>{fmtEUR((p.total_ttc_cents || 0) / 100)}</td>
                  <td style={{ textAlign: "right" }}>
                    <SignalButton
                      token={token}
                      firm_id={firm.id}
                      company_id={company.id}
                      target_type="purchase"
                      target_id={p.id}
                      targetLabel={`Achat ${p.vendor_name} ${fmtDate(p.issue_date)}`}
                      compact
                      onCreated={onSignalCreated}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// Onglet : TVA & URSSAF
// ════════════════════════════════════════════════════════════════

function VatTab({ token, firm, company }) {
  const [periodData, setPeriodData] = useState(null);

  async function load() {
    // Trimestre en cours
    const now = new Date();
    const quarter = Math.floor(now.getMonth() / 3);
    const firstMonth = quarter * 3;
    const firstDay = new Date(now.getFullYear(), firstMonth, 1).toISOString().slice(0, 10);
    const lastDay = new Date(now.getFullYear(), firstMonth + 3, 0).toISOString().slice(0, 10);

    const invoices = await sb.select(token, "invoices", {
      filter: `company_id=eq.${company.id}&issue_date=gte.${firstDay}&issue_date=lte.${lastDay}&status=in.(issued,sent,partial,paid,overdue)`,
      select: "vat_breakdown,vat_total_cents,subtotal_ht_cents"
    });

    const purchases = await sb.select(token, "purchases", {
      filter: `company_id=eq.${company.id}&issue_date=gte.${firstDay}&issue_date=lte.${lastDay}`,
      select: "vat_breakdown,vat_total_cents,subtotal_ht_cents"
    });

    // Ventilation TVA par taux
    const ventilation = {};
    for (const inv of (invoices || [])) {
      for (const v of (inv.vat_breakdown || [])) {
        const k = `${v.rate}%`;
        ventilation[k] = ventilation[k] || { rate: v.rate, collectee: 0, deductible: 0, baseCollectee: 0, baseDeductible: 0 };
        ventilation[k].collectee += v.vat_cents || 0;
        ventilation[k].baseCollectee += v.base_cents || 0;
      }
    }
    for (const p of (purchases || [])) {
      for (const v of (p.vat_breakdown || [])) {
        const k = `${v.rate}%`;
        ventilation[k] = ventilation[k] || { rate: v.rate, collectee: 0, deductible: 0, baseCollectee: 0, baseDeductible: 0 };
        ventilation[k].deductible += v.vat_cents || 0;
        ventilation[k].baseDeductible += v.base_cents || 0;
      }
    }

    let totalCollectee = 0, totalDeductible = 0;
    for (const v of Object.values(ventilation)) {
      totalCollectee += v.collectee;
      totalDeductible += v.deductible;
    }

    setPeriodData({
      label: `T${quarter + 1} ${now.getFullYear()}`,
      periode: `${fmtDate(firstDay)} → ${fmtDate(lastDay)}`,
      ventilation: Object.values(ventilation).sort((a, b) => b.rate - a.rate),
      totalCollectee,
      totalDeductible,
      totalNet: totalCollectee - totalDeductible
    });
  }

  useEffect(() => { load(); }, [company?.id]);

  if (!periodData) return <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>Chargement...</div>;

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: 1, color: "var(--muted)", margin: "0 0 4px 0" }}>
          TVA — {periodData.label}
        </h3>
        <div style={{ fontSize: 11, color: "var(--muted2)" }}>{periodData.periode}</div>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: 16 }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th>Taux</th>
              <th style={{ textAlign: "right" }}>Base HT collectée</th>
              <th style={{ textAlign: "right" }}>TVA collectée</th>
              <th style={{ textAlign: "right" }}>Base HT déductible</th>
              <th style={{ textAlign: "right" }}>TVA déductible</th>
            </tr>
          </thead>
          <tbody>
            {periodData.ventilation.map((v) => (
              <tr key={v.rate}>
                <td><strong>{v.rate}%</strong></td>
                <td style={{ textAlign: "right", fontFamily: "monospace" }}>{fmtEUR((v.baseCollectee || 0) / 100)}</td>
                <td style={{ textAlign: "right", fontFamily: "monospace" }}>{fmtEUR((v.collectee || 0) / 100)}</td>
                <td style={{ textAlign: "right", fontFamily: "monospace" }}>{fmtEUR((v.baseDeductible || 0) / 100)}</td>
                <td style={{ textAlign: "right", fontFamily: "monospace" }}>{fmtEUR((v.deductible || 0) / 100)}</td>
              </tr>
            ))}
            {periodData.ventilation.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: "center", padding: 24, color: "var(--muted)" }}>Aucune ventilation TVA sur la période</td></tr>
            )}
          </tbody>
          <tfoot>
            <tr style={{ fontWeight: 700, background: "rgba(255,255,255,0.02)" }}>
              <td>TOTAL</td>
              <td colSpan={2} style={{ textAlign: "right", fontFamily: "monospace" }}>{fmtEUR(periodData.totalCollectee / 100)}</td>
              <td colSpan={2} style={{ textAlign: "right", fontFamily: "monospace" }}>{fmtEUR(periodData.totalDeductible / 100)}</td>
            </tr>
            <tr style={{ background: "rgba(212,168,67,0.08)", fontWeight: 700 }}>
              <td colSpan={4} style={{ textAlign: "right" }}>TVA nette {periodData.totalNet >= 0 ? "à reverser" : "crédit"}</td>
              <td style={{ textAlign: "right", fontFamily: "monospace", color: "var(--gold)" }}>{fmtEUR(Math.abs(periodData.totalNet) / 100)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="card card-pad" style={{ fontSize: 11, color: "var(--muted2)" }}>
        <strong>URSSAF</strong> · Cotisations sociales auto-entrepreneurs : 12,3% (vente) ou 21,2% (services) du CA encaissé.
        Calcul détaillé URSSAF/DSN à venir en Sprint 4.
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// Onglet : Signalements
// ════════════════════════════════════════════════════════════════

function SignalsTab({ token, signals, onAction }) {
  const [filter, setFilter] = useState("open");

  const filtered = signals.filter((s) => filter === "all" || s.status === filter);
  const counts = {
    open: signals.filter((s) => s.status === "open").length,
    resolved: signals.filter((s) => s.status === "resolved").length,
    dismissed: signals.filter((s) => s.status === "dismissed").length
  };

  async function action(signalId, act) {
    const labels = { resolve: "Marquer comme résolu ?", dismiss: "Classer sans suite ?" };
    if (!confirm(labels[act])) return;
    const r = await fetch("/api/firm-signal", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: act, payload: { signal_id: signalId } })
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); alert(d.error || "Échec"); return; }
    onAction?.();
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        <button className={"btn btn-sm " + (filter === "open" ? "btn-gold" : "btn-ghost")} onClick={() => setFilter("open")}>
          ⏳ Ouverts ({counts.open})
        </button>
        <button className={"btn btn-sm " + (filter === "resolved" ? "btn-gold" : "btn-ghost")} onClick={() => setFilter("resolved")}>
          ✅ Résolus ({counts.resolved})
        </button>
        <button className={"btn btn-sm " + (filter === "dismissed" ? "btn-gold" : "btn-ghost")} onClick={() => setFilter("dismissed")}>
          🚫 Classés ({counts.dismissed})
        </button>
        <button className={"btn btn-sm " + (filter === "all" ? "btn-gold" : "btn-ghost")} onClick={() => setFilter("all")}>
          Tous
        </button>
      </div>

      {filtered.length === 0 ? (
        <EmptyTab text={filter === "open" ? "Aucun signalement ouvert" : "Aucun signalement dans ce filtre"} />
      ) : (
        filtered.map((s) => (
          <div key={s.id} className="card" style={{ padding: 14, marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                  <span>{SEV_EMOJI[s.severity]}</span>
                  <strong style={{ fontSize: 14 }}>{s.title}</strong>
                  <StatusBadgeSignal status={s.status} />
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>
                  Cible: {s.target_type}{s.target_id ? ` (${s.target_id.slice(0, 8)}...)` : ""} · Créé le {fmtDate(s.created_at)}
                </div>
                {s.content && (
                  <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted2)", whiteSpace: "pre-wrap" }}>
                    {s.content}
                  </div>
                )}
                {s.client_response && (
                  <div style={{ marginTop: 8, padding: "6px 10px", background: "rgba(62,207,122,0.08)", borderRadius: 4, fontSize: 12 }}>
                    💬 <strong>Réponse client</strong> ({fmtDate(s.client_responded_at)}) : {s.client_response}
                  </div>
                )}
              </div>
              {s.status === "open" && (
                <div style={{ display: "flex", gap: 4 }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => action(s.id, "dismiss")}>Classer</button>
                  <button className="btn btn-primary btn-sm" onClick={() => action(s.id, "resolve")}>✅ Résoudre</button>
                </div>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

function StatusBadge({ status }) {
  const map = {
    draft: { label: "Brouillon", cls: "badge-muted" },
    issued: { label: "Émise", cls: "badge-orange" },
    sent: { label: "Envoyée", cls: "badge-orange" },
    partial: { label: "Partielle", cls: "badge-orange" },
    paid: { label: "Payée", cls: "badge-green" },
    overdue: { label: "Retard", cls: "badge-red" },
    canceled: { label: "Annulée", cls: "badge-muted" }
  };
  const m = map[status] || { label: status, cls: "badge-muted" };
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

function StatusBadgeSignal({ status }) {
  const map = {
    open: { label: "⏳ Ouvert", cls: "badge-orange" },
    resolved: { label: "✅ Résolu", cls: "badge-green" },
    dismissed: { label: "🚫 Classé", cls: "badge-muted" }
  };
  const m = map[status] || { label: status, cls: "badge-muted" };
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

function EmptyTab({ text }) {
  return (
    <div className="card card-pad" style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>
      {text}
    </div>
  );
}

const SEV_EMOJI = { info: "🟦", warning: "🟧", critical: "🟥" };

const tableStyle = { width: "100%", borderCollapse: "collapse", fontSize: 12 };
const loadingStyle = { minHeight: 400, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 13 };
