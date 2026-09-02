import React, { useEffect, useState } from "react";
import { useParams, useNavigate, Navigate } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { useMyFirm } from "../../components/FirmMode.jsx";
import { fmtEUR, fmtDate, toCents, fromCents } from "../../lib/helpers.js";
import { computeCurrentVatPeriod } from "../../lib/vat-sync.js";
import { SignalButton } from "../../components/SignalButton.jsx";
import { useTableSort, SortableTh, useSortedRows } from "../../components/TableSort.jsx";
import { useListFilters, ListToolbar, NoResults } from "../../components/ListToolbar.jsx";

// ═══════════════════════════════════════════════════════════════════
// v8.147 — Page annexe "Historique des paiements" ajoutée sur une COPIE
// du PDF au téléchargement cabinet. L'original transmis n'est jamais modifié.
// ═══════════════════════════════════════════════════════════════════
const PM_LABELS = {
  bank_transfer: "Virement", virement: "Virement", cash: "Especes", especes: "Especes",
  check: "Cheque", cheque: "Cheque", stripe: "CB (Stripe)", card: "Carte", cb: "Carte", other: "Autre",
};
const _pmLabel = (m) => PM_LABELS[String(m || "").toLowerCase()] || (m || "-");
const _san = (s) => String(s == null ? "" : s).replace(/[^\x20-\xFF]/g, "");
const _eur = (c) => (Number(c || 0) / 100).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/\u202f|\u00a0/g, " ") + " EUR";
const _date = (d) => { if (!d) return "-"; try { return new Date(d).toLocaleDateString("fr-FR"); } catch { return "-"; } };

async function appendPaymentsPage(pdfBytes, data) {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const doc = await PDFDocument.load(pdfBytes);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595.28, 841.89]);
  const { width, height } = page.getSize();
  const gold = rgb(0.83, 0.66, 0.26), dark = rgb(0.1, 0.1, 0.12), grey = rgb(0.5, 0.5, 0.55);
  const T = (t, x, y, size, f, color) => page.drawText(_san(t), { x, y, size, font: f, color });

  let y = height - 60;
  T("Historique des paiements", 40, y, 18, bold, dark); y -= 22;
  T("Facture " + (data.number || ""), 40, y, 11, font, grey); y -= 30;

  const total = data.grand_total_cents || 0;
  const sum = (data.payments || []).reduce((s, p) => s + (Number(p.amount_cents) || 0), 0);
  const encaisse = Math.max(sum, data.paid_cents || 0);
  const reste = Math.max(0, total - encaisse);
  for (const [k, v] of [["Total TTC", _eur(total)], ["Total encaisse", _eur(encaisse)], ["Reste du", _eur(reste)]]) {
    T(k, 40, y, 11, font, grey); T(v, 320, y, 11, bold, dark); y -= 18;
  }
  y -= 14;
  T("Date", 40, y, 9, bold, gold); T("Moyen", 150, y, 9, bold, gold); T("Montant", 430, y, 9, bold, gold);
  y -= 6; page.drawLine({ start: { x: 40, y }, end: { x: width - 40, y }, thickness: 0.5, color: grey }); y -= 16;

  for (const p of (data.payments || [])) {
    if (y < 60) { break; }
    T(_date(p.paid_at), 40, y, 10, font, dark);
    T((_pmLabel(p.method) + (p.notes ? "  -  " + p.notes : "")).slice(0, 60), 150, y, 10, font, dark);
    T(_eur(p.amount_cents), 430, y, 10, bold, dark);
    y -= 16;
  }
  if ((data.paid_cents || 0) > sum + 1) {
    T("-", 40, y, 10, font, dark);
    T("Encaissement (detail par paiement non disponible)", 150, y, 10, font, grey);
    T(_eur((data.paid_cents || 0) - sum), 430, y, 10, bold, dark);
  }
  return await doc.save();
}

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
      // v8.88 — Le cabinet ne lit PAS `companies` en direct de façon fiable
      // (RLS) : le read direct retombait à null → "Client introuvable". On passe
      // par l'action serveur firm_link_companies (comme le dashboard / la liste).
      let co = null;
      try {
        const r = await fetch("/api/firm-invitation", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: "firm_link_companies", payload: { firm_id: firm.id } })
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.companies) co = j.companies[l.id] || null;
      } catch (_) { /* fallback ci-dessous */ }
      // Fallback : on garde au moins l'id (les onglets lisent via RLS firm_can_read),
      // pour que la fiche s'ouvre toujours si le lien existe.
      setClientCompany(
        co
          ? { ...co, id: co.id || l.company_id }
          : { id: l.company_id, legal_name: l.invited_email || "Client", siret: null }
      );
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
          { key: "bank", label: "Relevés bancaires" },
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
      {tab === "bank" && <BankStatementsTab token={token} firm={firm} company={clientCompany} />}
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
      select: "subtotal_ht_cents,vat_total_cents,total_ttc_cents,grand_total_cents,debour_total_cents,paid_cents,status"
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
        <KpiCard label="CA HT facturé" value={fmtEUR(kpis.caFactureCents)} sub={`${kpis.nbFactures} facture${kpis.nbFactures > 1 ? "s" : ""}`} />
        <KpiCard label="CA TTC encaissé" value={fmtEUR(kpis.caCollecteCents)} sub="Effectivement payé" />
        <KpiCard label="TVA collectée" value={fmtEUR(kpis.tvaCollecteeCents)} sub="À reverser" />
        <KpiCard label="TVA déductible" value={fmtEUR(kpis.tvaDeductibleCents)} sub="Sur achats" />
        <KpiCard label="TVA nette" value={fmtEUR(kpis.tvaNetteCents)} sub={kpis.tvaNetteCents >= 0 ? "À déclarer" : "Crédit TVA"} highlight />
        <KpiCard label="Achats HT" value={fmtEUR(kpis.achatsHtCents)} sub={`${kpis.nbAchats} achat${kpis.nbAchats > 1 ? "s" : ""}`} />
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
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewTitle, setPreviewTitle] = useState("");
  const [previewInvoiceId, setPreviewInvoiceId] = useState(null); // v8.148
  // v8.84 — Sélection multiple + export ZIP des PDF factures (cabinet).
  const [selected, setSelected] = useState(() => new Set());
  const [zipping, setZipping] = useState(false);
  // v8.62 — Recherche, période et tri par colonne.
  const filters = useListFilters();
  const { sort, toggleSort } = useTableSort("firm.invoices.sort", { key: "issue_date", dir: "desc" });

  async function load() {
    const rows = await sb.select(token, "invoices", {
      filter: `company_id=eq.${company.id}`,
      select: "id,number,issue_date,due_date,status,subtotal_ht_cents,vat_total_cents,total_ttc_cents,grand_total_cents,debour_total_cents,paid_cents,pdf_url,facturx_pdf_url",
      order: "issue_date.desc",
      // v8.62 — 100 pièces ne couvraient pas un exercice complet : la recherche
      // et le filtre de période auraient porté sur un sous-ensemble muet.
      limit: 500
    });
    setInvoices(rows || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, [company?.id]);

  function openPreview(inv) {
    const url = inv.facturx_pdf_url || inv.pdf_url;
    if (!url) { alert("PDF non disponible pour cette facture"); return; }
    setPreviewUrl(url);
    setPreviewTitle(`Facture ${inv.number}`);
    setPreviewInvoiceId(inv.id); // v8.148 — pour annexer l'historique des paiements
  }

  // v8.62 — Filtrage (recherche + période) puis tri, avant tout le reste :
  // sélection, ZIP et compteurs portent sur ce que l'utilisateur voit.
  const visible = invoices.filter((inv) =>
    filters.match(inv, (i) => i.issue_date, (i) => [i.number, i.status])
  );
  const sortedInvoices = useSortedRows(
    visible,
    sort,
    (i, k) => {
      switch (k) {
        case "number":     return i.number || "";
        case "issue_date": return i.issue_date || "";
        case "due_date":   return i.due_date || "";
        case "ht":         return i.subtotal_ht_cents || 0;
        case "vat":        return i.vat_total_cents || 0;
        case "ttc":        return i.grand_total_cents ?? ((i.total_ttc_cents || 0) + (i.debour_total_cents || 0));
        case "status":     return i.status || "";
        default:           return i.issue_date || "";
      }
    },
    (i) => i.number || ""
  );

  // Factures ayant un PDF téléchargeable (seules sélectionnables), parmi les
  // lignes visibles : cocher « tout » ne doit pas embarquer ce qui est filtré.
  const withPdf = sortedInvoices.filter((i) => i.facturx_pdf_url || i.pdf_url);
  const hiddenSelected = selected.size - withPdf.filter((i) => selected.has(i.id)).length;

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => {
      if (prev.size === withPdf.length) return new Set();
      return new Set(withPdf.map((i) => i.id));
    });
  }

  // v8.84 — Télécharge les PDF sélectionnés dans un ZIP (côté client, JSZip).
  async function downloadZip() {
    const chosen = withPdf.filter((i) => selected.has(i.id));
    if (chosen.length === 0) return;
    setZipping(true);
    try {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      let ok = 0;
      for (const inv of chosen) {
        const stored = inv.facturx_pdf_url || inv.pdf_url;
        try {
          // URL signée via l'action cabinet existante.
          const r = await fetch("/api/firm-invitation", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ action: "pdf_refresh_url", payload: { stored_url: stored } })
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.pdf_url) continue;
          const pdf = await fetch(j.pdf_url);
          if (!pdf.ok) continue;
          let bytes = new Uint8Array(await pdf.arrayBuffer());
          // v8.147 — Annexe la page "Historique des paiements" sur une COPIE
          // enrichie. L'original stocké/transmis au PDP n'est JAMAIS modifié.
          try {
            const pr = await fetch("/api/firm-invitation", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ action: "invoice_payments", payload: { invoice_id: inv.id } })
            });
            const pj = await pr.json().catch(() => ({}));
            if (pr.ok && ((pj.payments && pj.payments.length > 0) || pj.paid_cents > 0)) {
              bytes = await appendPaymentsPage(bytes, pj);
            }
          } catch (_) { /* on garde le PDF sans annexe si souci */ }
          const safe = String(inv.number || inv.id).replace(/[^\w.-]+/g, "_");
          zip.file(`${safe}.pdf`, bytes);
          ok++;
        } catch (_) { /* on saute cette facture, on continue */ }
      }
      if (ok === 0) { alert("Aucun PDF n'a pu être récupéré."); setZipping(false); return; }
      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      const a = document.createElement("a");
      const cname = (company.legal_name || company.trade_name || "client").replace(/[^\w.-]+/g, "_");
      a.href = url;
      a.download = `factures_${cname}_${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      if (ok < chosen.length) alert(`${ok}/${chosen.length} factures ajoutées au ZIP (les autres n'ont pas pu être récupérées).`);
    } catch (e) {
      alert("Erreur lors de la création du ZIP : " + (e.message || e));
    }
    setZipping(false);
  }

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>Chargement...</div>;
  if (invoices.length === 0) return <EmptyTab text="Aucune facture sur ce client" />;

  return (
    <>
      {/* v8.62 — Recherche + période. Toujours affichée, même sans résultat :
          sinon l'utilisateur ne pourrait plus défaire son propre filtre. */}
      <ListToolbar
        filters={filters}
        placeholder="N° de facture, statut…"
        shown={sortedInvoices.length}
        total={invoices.length}
      />

      {sortedInvoices.length === 0 ? <NoResults onReset={filters.reset} /> : (
      <>
      {/* v8.84 — Barre d'export ZIP des factures sélectionnées */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          {selected.size > 0
            ? `${withPdf.filter((i) => selected.has(i.id)).length} facture(s) sélectionnée(s)`
              + (hiddenSelected > 0 ? ` · ${hiddenSelected} masquée(s) par le filtre, non exportée(s)` : "")
            : "Cochez les factures à exporter"}
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={downloadZip}
          disabled={selected.size === 0 || zipping}
          style={{ whiteSpace: "nowrap" }}
        >
          {zipping ? "⏳ Création du ZIP…" : `⬇️ Télécharger ZIP${selected.size > 0 ? ` (${selected.size})` : ""}`}
        </button>
      </div>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={{ width: 32, textAlign: "center" }}>
                  <input
                    type="checkbox"
                    checked={withPdf.length > 0 && selected.size === withPdf.length}
                    ref={(el) => { if (el) el.indeterminate = selected.size > 0 && selected.size < withPdf.length; }}
                    onChange={toggleAll}
                    title="Tout sélectionner"
                    disabled={withPdf.length === 0}
                  />
                </th>
                <SortableTh label="N°"       sortKey="number"     sort={sort} onSort={toggleSort} />
                <SortableTh label="Date"     sortKey="issue_date" sort={sort} onSort={toggleSort} />
                <SortableTh label="Échéance" sortKey="due_date"   sort={sort} onSort={toggleSort} />
                <SortableTh label="HT"       sortKey="ht"         sort={sort} onSort={toggleSort} align="right" />
                <SortableTh label="TVA"      sortKey="vat"        sort={sort} onSort={toggleSort} align="right" />
                <SortableTh label="TTC"      sortKey="ttc"        sort={sort} onSort={toggleSort} align="right" />
                <SortableTh label="Statut"   sortKey="status"     sort={sort} onSort={toggleSort} />
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedInvoices.map((inv) => {
                const invSignals = signals.filter((s) => s.target_type === "invoice" && s.target_id === inv.id && s.status === "open");
                const hasPdf = inv.facturx_pdf_url || inv.pdf_url;
                return (
                  <tr key={inv.id}>
                    <td style={{ textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={selected.has(inv.id)}
                        onChange={() => toggleOne(inv.id)}
                        disabled={!hasPdf}
                        title={hasPdf ? "Sélectionner pour le ZIP" : "Pas de PDF disponible"}
                      />
                    </td>
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
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>{fmtEUR(inv.subtotal_ht_cents || 0)}</td>
                    <td style={{ textAlign: "right", fontFamily: "monospace" }}>{fmtEUR(inv.vat_total_cents || 0)}</td>
                    <td style={{ textAlign: "right", fontFamily: "monospace", fontWeight: 600 }}>
                      {/* v8.49 — grand_total = ce que le client paye. Sous-ligne "dont TVA · débours". */}
                      {(() => {
                        const debTotal = inv.debour_total_cents || 0;
                        const vatTotal = inv.vat_total_cents || 0;
                        const grandTotal = inv.grand_total_cents ?? ((inv.total_ttc_cents || 0) + debTotal);
                        const parts = [];
                        if (vatTotal > 0) parts.push(`${fmtEUR(vatTotal)} TVA`);
                        if (debTotal > 0) parts.push(`${fmtEUR(debTotal)} débours`);
                        return (
                          <>
                            <div>{fmtEUR(grandTotal)}</div>
                            {parts.length > 0 && (
                              <div style={{ fontSize: 9, fontWeight: 400, color: "var(--muted)", marginTop: 2 }}>
                                dont {parts.join(" · ")}
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </td>
                    <td><StatusBadge status={inv.status} /></td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      {hasPdf && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => openPreview(inv)}
                          style={{ padding: "4px 8px", marginRight: 4 }}
                          title="Voir le PDF"
                        >
                          👁
                        </button>
                      )}
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
      </>
      )}

    {previewUrl && (
      <PdfPreviewModal token={token} url={previewUrl} invoiceId={previewInvoiceId} title={previewTitle} onClose={() => { setPreviewUrl(null); setPreviewInvoiceId(null); }} />
    )}
    </>
  );
}

function PdfPreviewModal({ token, url, title, onClose, invoiceId }) {
  const [freshUrl, setFreshUrl] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    let blobToRevoke = null;
    setFreshUrl(null);
    setError("");

    (async () => {
      try {
        const r = await fetch("/api/firm-invitation", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ action: "pdf_refresh_url", payload: { stored_url: url } })
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `Erreur ${r.status}`);
        }
        const j = await r.json();
        if (!alive) return;
        if (!j.pdf_url) throw new Error("Pas d'URL retournée");

        // v8.148 — Si la facture a des paiements, on annexe la page "Historique
        // des paiements" (copie enrichie en mémoire), comme au téléchargement.
        if (invoiceId) {
          try {
            const pr = await fetch("/api/firm-invitation", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ action: "invoice_payments", payload: { invoice_id: invoiceId } })
            });
            const pj = await pr.json().catch(() => ({}));
            if (pr.ok && ((pj.payments && pj.payments.length > 0) || pj.paid_cents > 0)) {
              const pdfResp = await fetch(j.pdf_url);
              const bytes = new Uint8Array(await pdfResp.arrayBuffer());
              const enriched = await appendPaymentsPage(bytes, pj);
              const blob = new Blob([enriched], { type: "application/pdf" });
              const blobUrl = URL.createObjectURL(blob);
              blobToRevoke = blobUrl;
              if (!alive) { URL.revokeObjectURL(blobUrl); return; }
              setFreshUrl(blobUrl);
              return;
            }
          } catch (e) { /* on retombe sur le PDF simple */ }
        }
        setFreshUrl(j.pdf_url);
      } catch (e) {
        if (!alive) return;
        // Fallback : on tente l'URL stockée (peut marcher si pas encore expirée)
        console.warn("[PdfPreview] refresh failed, fallback to stored URL:", e.message);
        setFreshUrl(url);
      }
    })();

    return () => { alive = false; if (blobToRevoke) URL.revokeObjectURL(blobToRevoke); };
  }, [token, url, invoiceId]);

  return (
    <div style={pdfModalBackdrop} onClick={onClose}>
      <div className="card" style={pdfModalBox} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          <strong style={{ fontSize: 13 }}>{title}</strong>
          <div style={{ display: "flex", gap: 6 }}>
            {freshUrl && (
              <a href={freshUrl} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm" style={{ textDecoration: "none" }}>
                ⤴ Ouvrir
              </a>
            )}
            <button className="btn btn-ghost btn-sm" onClick={onClose}>✕ Fermer</button>
          </div>
        </div>
        <div style={{ flex: 1, background: "#fff", overflow: "hidden" }}>
          {!freshUrl && !error && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "#666", fontSize: 13 }}>
              ⏳ Chargement du document…
            </div>
          )}
          {error && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--red)", fontSize: 13, padding: 20, textAlign: "center" }}>
              ⚠️ {error}
            </div>
          )}
          {freshUrl && (
            <iframe
              src={freshUrl}
              title={title}
              style={{ width: "100%", height: "100%", border: "none" }}
            />
          )}
        </div>
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
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewTitle, setPreviewTitle] = useState("");
  const [dedFor, setDedFor] = useState(null); // v8.66 — mini-éditeur TVA récupérable (cabinet)
  // v8.85 — Sélection multiple + export ZIP des justificatifs d'achat.
  const [selected, setSelected] = useState(() => new Set());
  const [zipping, setZipping] = useState(false);
  // v8.62 — Recherche, période et tri par colonne.
  const filters = useListFilters();
  const { sort, toggleSort } = useTableSort("firm.purchases.sort", { key: "issue_date", dir: "desc" });

  async function load() {
    const rows = await sb.select(token, "purchases", {
      filter: `company_id=eq.${company.id}`,
      order: "issue_date.desc",
      limit: 500
    });
    console.log("[Achats cabinet] company_id:", company.id, "rows:", rows?.length, "sample:", rows?.[0]);
    setPurchases(rows || []);
    setLoading(false);
  }

  useEffect(() => { load(); }, [company?.id]);

  async function openPreview(p) {
    if (!p.file_url) { alert("PDF non disponible pour cet achat"); return; }
    // v8.48.34 — Utiliser pdf_refresh_url pour obtenir une URL signée
    // (le cabinet n'a pas d'accès direct au bucket purchases-attach).
    const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
    const storedUrl = `${SUPABASE_URL}/storage/v1/object/sign/purchases-attach/${p.file_url}`;
    try {
      const r = await fetch("/api/firm-invitation", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "pdf_refresh_url", payload: { stored_url: storedUrl } })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.pdf_url) {
        alert(j.error || "Impossible d'ouvrir le PDF");
        return;
      }
      setPreviewUrl(j.pdf_url);
      setPreviewTitle(`Achat ${p.vendor_name} · ${fmtDate(p.issue_date)}`);
    } catch (e) {
      alert("Erreur : " + e.message);
    }
  }

  // v8.62 — Filtrage (recherche + période) puis tri, avant sélection et ZIP.
  const visible = purchases.filter((p) =>
    filters.match(p, (x) => x.issue_date, (x) => [x.number, x.vendor_name, x.category])
  );
  const sortedPurchases = useSortedRows(
    visible,
    sort,
    (p, k) => {
      switch (k) {
        case "number":     return p.number || "";
        case "vendor":     return p.vendor_name || "";
        case "issue_date": return p.issue_date || "";
        case "category":   return p.category || "";
        case "ht":         return p.subtotal_ht_cents || 0;
        case "vat":        return p.vat_total_cents || 0;
        case "ttc":        return p.total_ttc_cents || 0;
        default:           return p.issue_date || "";
      }
    },
    (p) => p.vendor_name || ""
  );

  // Achats ayant un justificatif téléchargeable (seuls sélectionnables), parmi
  // les lignes visibles : cocher « tout » ne prend pas ce qui est filtré.
  const withPdf = sortedPurchases.filter((p) => p.file_url);
  const hiddenSelected = selected.size - withPdf.filter((p) => selected.has(p.id)).length;

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => {
      if (prev.size === withPdf.length) return new Set();
      return new Set(withPdf.map((p) => p.id));
    });
  }

  // v8.85 — Télécharge les justificatifs sélectionnés dans un ZIP (côté client).
  // Les achats utilisent file_url (chemin dans le bucket purchases-attach).
  async function downloadZip() {
    const chosen = withPdf.filter((p) => selected.has(p.id));
    if (chosen.length === 0) return;
    setZipping(true);
    try {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
      let ok = 0;
      for (const p of chosen) {
        const storedUrl = `${SUPABASE_URL}/storage/v1/object/sign/purchases-attach/${p.file_url}`;
        try {
          const r = await fetch("/api/firm-invitation", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ action: "pdf_refresh_url", payload: { stored_url: storedUrl } })
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok || !j.pdf_url) continue;
          const file = await fetch(j.pdf_url);
          if (!file.ok) continue;
          const blob = await file.blob();
          const ext = (p.file_url.split(".").pop() || "pdf").split("?")[0].slice(0, 5);
          const base = String(p.number || p.vendor_name || p.id).replace(/[^\w.-]+/g, "_");
          const dateStr = p.issue_date ? String(p.issue_date).slice(0, 10) : "";
          zip.file(`${base}${dateStr ? "_" + dateStr : ""}.${ext}`, blob);
          ok++;
        } catch (_) { /* on saute, on continue */ }
      }
      if (ok === 0) { alert("Aucun justificatif n'a pu être récupéré."); setZipping(false); return; }
      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      const a = document.createElement("a");
      const cname = (company.legal_name || company.trade_name || "client").replace(/[^\w.-]+/g, "_");
      a.href = url;
      a.download = `achats_${cname}_${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      if (ok < chosen.length) alert(`${ok}/${chosen.length} justificatifs ajoutés au ZIP (les autres n'ont pas pu être récupérés).`);
    } catch (e) {
      alert("Erreur lors de la création du ZIP : " + (e.message || e));
    }
    setZipping(false);
  }

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>Chargement...</div>;
  if (purchases.length === 0) return <EmptyTab text="Aucun achat sur ce client" />;

  return (
    <>
    {/* v8.62 — Recherche + période */}
    <ListToolbar
      filters={filters}
      placeholder="Fournisseur, n°, catégorie…"
      shown={sortedPurchases.length}
      total={purchases.length}
    />

    {sortedPurchases.length === 0 ? <NoResults onReset={filters.reset} /> : (
    <>
    {/* v8.85 — Barre d'export ZIP des justificatifs sélectionnés */}
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 12, flexWrap: "wrap" }}>
      <div style={{ fontSize: 12, color: "var(--muted)" }}>
        {selected.size > 0
          ? `${withPdf.filter((p) => selected.has(p.id)).length} justificatif(s) sélectionné(s)`
            + (hiddenSelected > 0 ? ` · ${hiddenSelected} masqué(s) par le filtre, non exporté(s)` : "")
          : "Cochez les achats à exporter"}
      </div>
      <button
        className="btn btn-primary btn-sm"
        onClick={downloadZip}
        disabled={selected.size === 0 || zipping}
        style={{ whiteSpace: "nowrap" }}
      >
        {zipping ? "⏳ Création du ZIP…" : `⬇️ Télécharger ZIP${selected.size > 0 ? ` (${selected.size})` : ""}`}
      </button>
    </div>
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={{ width: 32, textAlign: "center" }}>
                <input
                  type="checkbox"
                  checked={withPdf.length > 0 && selected.size === withPdf.length}
                  ref={(el) => { if (el) el.indeterminate = selected.size > 0 && selected.size < withPdf.length; }}
                  onChange={toggleAll}
                  title="Tout sélectionner"
                  disabled={withPdf.length === 0}
                />
              </th>
              <SortableTh label="N°"          sortKey="number"     sort={sort} onSort={toggleSort} />
              <SortableTh label="Fournisseur" sortKey="vendor"     sort={sort} onSort={toggleSort} />
              <SortableTh label="Date"        sortKey="issue_date" sort={sort} onSort={toggleSort} />
              <SortableTh label="Catégorie"   sortKey="category"   sort={sort} onSort={toggleSort} />
              <SortableTh label="HT"          sortKey="ht"         sort={sort} onSort={toggleSort} align="right" />
              <SortableTh label="TVA"         sortKey="vat"        sort={sort} onSort={toggleSort} align="right" />
              <SortableTh label="TTC"         sortKey="ttc"        sort={sort} onSort={toggleSort} align="right" />
              <th style={{ textAlign: "right" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedPurchases.map((p) => {
              const pSignals = signals.filter((s) => s.target_type === "purchase" && s.target_id === p.id && s.status === "open");
              return (
                <tr key={p.id}>
                  <td style={{ textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggleOne(p.id)}
                      disabled={!p.file_url}
                      title={p.file_url ? "Sélectionner pour le ZIP" : "Pas de justificatif"}
                    />
                  </td>
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
                  <td style={{ textAlign: "right", fontFamily: "monospace" }}>{fmtEUR(p.subtotal_ht_cents || 0)}</td>
                  <td style={{ textAlign: "right", fontFamily: "monospace" }}>
                    {fmtEUR(p.vat_total_cents || 0)}
                    {/* v8.66 — Accès rapide TVA récupérable côté cabinet (option 1) */}
                    {(p.vat_total_cents || 0) > 0 && (() => {
                      const vatC = p.vat_total_cents || 0;
                      const dedC = p.vat_deductible_cents != null ? p.vat_deductible_cents : vatC;
                      const isFull = dedC >= vatC, isNone = dedC <= 0;
                      const lbl = isNone ? "Non récup." : `Récup. ${fmtEUR(dedC)}`;
                      const tint = isNone
                        ? { c: "var(--red)", bg: "rgba(229,73,73,0.12)", bd: "rgba(229,73,73,0.30)" }
                        : isFull
                          ? { c: "var(--green)", bg: "rgba(62,207,122,0.12)", bd: "rgba(62,207,122,0.30)" }
                          : { c: "var(--gold)", bg: "rgba(212,168,67,0.12)", bd: "rgba(212,168,67,0.30)" };
                      return (
                        <div style={{ marginTop: 4 }}>
                          <span
                            onClick={() => setDedFor(p)}
                            title="Modifier la TVA récupérable"
                            style={{
                              display: "inline-flex", alignItems: "center", gap: 4,
                              padding: "2px 8px", borderRadius: 999, fontSize: 10, fontWeight: 600,
                              cursor: "pointer", color: tint.c, background: tint.bg, border: `1px solid ${tint.bd}`
                            }}
                          >{lbl} <span style={{ opacity: 0.55, fontSize: 9 }}>✎</span></span>
                        </div>
                      );
                    })()}
                  </td>
                  <td style={{ textAlign: "right", fontFamily: "monospace", fontWeight: 600 }}>{fmtEUR(p.total_ttc_cents || 0)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    {p.file_url && (
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => openPreview(p)}
                        style={{ padding: "4px 8px", marginRight: 4 }}
                        title="Voir le document scanné"
                      >
                        👁
                      </button>
                    )}
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
    </>
    )}

    {previewUrl && (
      <PdfPreviewModal token={token} url={previewUrl} title={previewTitle} onClose={() => setPreviewUrl(null)} />
    )}
    {/* v8.66 — Mini-éditeur TVA récupérable côté cabinet (option 1) */}
    {dedFor && (
      <FirmDeductibleModal
        token={token}
        firm={firm}
        purchase={dedFor}
        onClose={() => setDedFor(null)}
        onSaved={(newDedCents) => {
          setPurchases((prev) => prev.map((x) => x.id === dedFor.id ? { ...x, vat_deductible_cents: newDedCents } : x));
          setDedFor(null);
        }}
      />
    )}
    </>
  );
}

// v8.66 (P2b-2b) — Mini-éditeur "TVA récupérable" côté CABINET. Passe par
// l'action firm-invitation `set_purchase_deductible` (service_role + double
// contrôle firm_member/lien accepté), car le cabinet n'a pas d'écriture RLS
// directe sur purchases.
function FirmDeductibleModal({ token, firm, purchase, onClose, onSaved }) {
  const vatC = purchase.vat_total_cents || 0;
  const initDedC = purchase.vat_deductible_cents != null ? purchase.vat_deductible_cents : vatC;
  const [mode, setMode] = useState(initDedC <= 0 ? "none" : (initDedC >= vatC ? "full" : "partial"));
  const [partial, setPartial] = useState(fromCents(initDedC).toFixed(2));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const dedC = mode === "full" ? vatC : mode === "none" ? 0 : Math.min(vatC, Math.max(0, toCents(partial)));
  const pct = vatC > 0 ? Math.round((dedC / vatC) * 100) : 0;
  const modes = [["full", "Totale"], ["partial", "Partielle"], ["none", "Non récupérable"]];

  async function save() {
    setSaving(true); setErr("");
    try {
      const r = await fetch("/api/firm-invitation", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          action: "set_purchase_deductible",
          payload: { firm_id: firm.id, purchase_id: purchase.id, vat_deductible_cents: dedC }
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(j.error || "Erreur"); setSaving(false); return; }
      setSaving(false);
      onSaved && onSaved(typeof j.vat_deductible_cents === "number" ? j.vat_deductible_cents : dedC);
    } catch (e) {
      setErr("Erreur réseau"); setSaving(false);
    }
  }

  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
        <div className="modal-hd">
          <span className="modal-title">TVA récupérable</span>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
            {purchase.vendor_name} · TVA {fmtEUR(vatC)}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {modes.map(([m, lbl]) => (
              <button key={m} type="button"
                className={"btn btn-sm " + (mode === m ? "btn-primary" : "btn-ghost")}
                onClick={() => {
                  setMode(m);
                  if (m === "partial" && (toCents(partial) <= 0 || toCents(partial) >= vatC)) {
                    setPartial(fromCents(Math.round(vatC / 2)).toFixed(2));
                  }
                }}
                style={{ flex: 1 }}>{lbl}</button>
            ))}
          </div>
          {mode === "partial" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 10 }}>
              <label className="form-row"><span className="form-label">Montant (€)</span>
                <input className="form-input" type="number" step="0.01" value={partial} onChange={(e) => setPartial(e.target.value)} /></label>
              <label className="form-row"><span className="form-label">%</span>
                <input className="form-input" type="number" step="1" value={String(pct)}
                  onChange={(e) => { const pp = Math.max(0, Math.min(100, parseFloat(e.target.value) || 0)); setPartial(fromCents(Math.round((vatC * pp) / 100)).toFixed(2)); }} /></label>
            </div>
          )}
          <div style={{ marginTop: 14, textAlign: "right", fontWeight: 700, color: "var(--green)" }}>
            Récupérable : {fmtEUR(dedC)}
          </div>
          {err && <div style={{ color: "var(--red)", fontSize: 12, marginTop: 8 }}>{err}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Annuler</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? "…" : "Enregistrer"}</button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// v8.86 — Onglet : Relevés bancaires (cabinet, lecture seule)
// Lit bank_statements via RLS firm_can_read ; URLs signées via pdf_refresh_url.
// ════════════════════════════════════════════════════════════════
function BankStatementsTab({ token, firm, company }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(() => new Set());
  const [zipping, setZipping] = useState(false);
  // v8.62 — Recherche, période et tri. Liste de cartes et non tableau :
  // le tri passe par un menu déroulant plutôt que par des en-têtes cliquables.
  const filters = useListFilters();
  const { sort, setSortDirect } = useTableSort("firm.bank.sort", { key: "created_at", dir: "desc" });

  async function load() {
    const rows = await sb.select(token, "bank_statements", {
      filter: `company_id=eq.${company.id}`,
      order: "created_at.desc",
      limit: 500
    });
    setItems(rows || []);
    setLoading(false);
  }
  useEffect(() => { load(); }, [company?.id]);

  async function signedUrl(it) {
    const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
    const storedUrl = `${SUPABASE_URL}/storage/v1/object/sign/bank-statements/${it.file_url}`;
    const r = await fetch("/api/firm-invitation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "pdf_refresh_url", payload: { stored_url: storedUrl } })
    });
    const j = await r.json().catch(() => ({}));
    return r.ok && j.pdf_url ? j.pdf_url : null;
  }

  async function openFile(it) {
    const url = await signedUrl(it);
    if (!url) { alert("Impossible d'ouvrir le fichier."); return; }
    window.open(url, "_blank");
  }

  // v8.62 — La période porte sur la date de dépôt, seule date portée par un
  // relevé côté IOBILL (le mois couvert n'est pas une colonne).
  const visible = items.filter((it) =>
    filters.match(it, (x) => x.created_at, (x) => [x.file_name])
  );
  const shown = useSortedRows(
    visible,
    sort,
    (it, k) => {
      switch (k) {
        case "file_name":  return it.file_name || "";
        case "size_bytes": return it.size_bytes || 0;
        default:           return it.created_at || "";
      }
    },
    (it) => it.file_name || ""
  );
  const hiddenSelected = selected.size - shown.filter((i) => selected.has(i.id)).length;

  function toggleOne(id) {
    setSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    // Porte sur les seules lignes visibles, pour ne pas embarquer du filtré.
    setSelected((prev) => {
      const allShown = shown.length > 0 && shown.every((i) => prev.has(i.id));
      const n = new Set(prev);
      shown.forEach((i) => allShown ? n.delete(i.id) : n.add(i.id));
      return n;
    });
  }

  async function downloadZip() {
    const chosen = shown.filter((i) => selected.has(i.id));
    if (chosen.length === 0) return;
    setZipping(true);
    try {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      let ok = 0;
      for (const it of chosen) {
        try {
          const url = await signedUrl(it);
          if (!url) continue;
          const f = await fetch(url);
          if (!f.ok) continue;
          const blob = await f.blob();
          const ext = (it.file_url.split(".").pop() || "pdf").split("?")[0].slice(0, 5);
          const base = String(it.file_name || it.id).replace(/[^\w.-]+/g, "_");
          zip.file(`${base}.${ext}`, blob);
          ok++;
        } catch (_) {}
      }
      if (ok === 0) { alert("Aucun relevé n'a pu être récupéré."); setZipping(false); return; }
      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      const a = document.createElement("a");
      const cname = (company.legal_name || company.trade_name || "client").replace(/[^\w.-]+/g, "_");
      a.href = url; a.download = `releves_${cname}_${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      if (ok < chosen.length) alert(`${ok}/${chosen.length} relevés ajoutés au ZIP.`);
    } catch (e) {
      alert("Erreur ZIP : " + (e.message || e));
    }
    setZipping(false);
  }

  if (loading) return <div style={{ padding: 40, textAlign: "center", color: "var(--muted)" }}>Chargement...</div>;
  if (items.length === 0) return <EmptyTab text="Aucun relevé bancaire déposé par ce client" />;

  return (
    <>
      {/* v8.62 — Recherche + période + tri */}
      <ListToolbar
        filters={filters}
        placeholder="Nom du fichier…"
        shown={shown.length}
        total={items.length}
      >
        <select
          value={`${sort.key}:${sort.dir}`}
          onChange={(e) => {
            const [k, d] = e.target.value.split(":");
            setSortDirect(k, d);
          }}
          title="Trier"
          style={{ background: "var(--card)", border: "1px solid var(--border2)", borderRadius: 6, padding: "9px 10px", color: "var(--text)", fontSize: 13, cursor: "pointer" }}
        >
          <option value="created_at:desc">Dépôt — plus récent</option>
          <option value="created_at:asc">Dépôt — plus ancien</option>
          <option value="file_name:asc">Nom — A → Z</option>
          <option value="file_name:desc">Nom — Z → A</option>
          <option value="size_bytes:desc">Taille — décroissante</option>
          <option value="size_bytes:asc">Taille — croissante</option>
        </select>
      </ListToolbar>

      {shown.length === 0 ? <NoResults onReset={filters.reset} /> : (
      <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, gap: 12, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          {selected.size > 0
            ? `${shown.filter((i) => selected.has(i.id)).length} relevé(s) sélectionné(s)`
              + (hiddenSelected > 0 ? ` · ${hiddenSelected} masqué(s) par le filtre, non exporté(s)` : "")
            : "Relevés déposés par le client"}
        </div>
        <button className="btn btn-primary btn-sm" onClick={downloadZip} disabled={selected.size === 0 || zipping} style={{ whiteSpace: "nowrap" }}>
          {zipping ? "⏳ Création du ZIP…" : `⬇️ Télécharger ZIP${selected.size > 0 ? ` (${selected.size})` : ""}`}
        </button>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderBottom: "1px solid var(--border2, rgba(255,255,255,0.08))", fontSize: 11, color: "var(--muted)" }}>
          <input type="checkbox" checked={shown.length > 0 && shown.every((i) => selected.has(i.id))} ref={(el) => { if (el) { const n = shown.filter((i) => selected.has(i.id)).length; el.indeterminate = n > 0 && n < shown.length; } }} onChange={toggleAll} title="Tout sélectionner" />
          <span>Tout sélectionner</span>
        </div>
        {shown.map((it) => (
          <div key={it.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--border2, rgba(255,255,255,0.06))" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggleOne(it.id)} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{it.file_name}</div>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>
                  {fmtDate(it.created_at)}{it.size_bytes ? ` · ${(it.size_bytes / 1024).toFixed(0)} Ko` : ""}
                </div>
              </div>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => openFile(it)} title="Ouvrir">👁</button>
          </div>
        ))}
      </div>
      </>
      )}
    </>
  );
}

// ════════════════════════════════════════════════════════════════
// Onglet : TVA & URSSAF
// ════════════════════════════════════════════════════════════════

function VatTab({ token, firm, company }) {
  const [periodData, setPeriodData] = useState(null);

  async function load() {
    // Période en cours selon le régime TVA de l'abonné (mensuel / trimestriel / annuel)
    const period = computeCurrentVatPeriod(company.vat_regime);
    if (!period) {
      // Régime franchise ou inconnu : pas de calcul
      setPeriodData({
        label: "Franchise TVA",
        periode: "—",
        ventilation: [],
        totalCollectee: 0,
        totalDeductible: 0,
        totalNet: 0
      });
      return;
    }
    const firstDay = period.start;
    const lastDay = period.end;

    // Calcul du label en fonction du régime
    const now = new Date();
    let label;
    if (company.vat_regime === "normal_monthly") {
      label = now.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
    } else if (company.vat_regime === "normal_quarterly") {
      const quarter = Math.floor(now.getMonth() / 3) + 1;
      label = `T${quarter} ${now.getFullYear()}`;
    } else if (company.vat_regime === "simplified") {
      label = `Année ${now.getFullYear()}`;
    } else {
      label = "Période en cours";
    }

    const invoices = await sb.select(token, "invoices", {
      filter: `company_id=eq.${company.id}&issue_date=gte.${firstDay}&issue_date=lte.${lastDay}&status=in.(issued,sent,partial,paid,overdue)`,
      select: "id,number,issue_date,status,vat_breakdown,vat_total_cents,subtotal_ht_cents,total_ttc_cents,pdf_url,facturx_pdf_url",
      order: "issue_date.desc"
    });

    const purchases = await sb.select(token, "purchases", {
      filter: `company_id=eq.${company.id}&issue_date=gte.${firstDay}&issue_date=lte.${lastDay}`,
      select: "id,number,vendor_name,issue_date,status,vat_breakdown,vat_total_cents,subtotal_ht_cents,total_ttc_cents,file_url,file_mime",
      order: "issue_date.desc"
    });

    // Ventilation TVA par taux + fallback sur les totaux pour les factures
    // sans vat_breakdown (ancien format, factures importées, etc.)
    const ventilation = {};
    let totalCollectee = 0;
    let totalDeductible = 0;
    let totalBaseCollectee = 0;
    let totalBaseDeductible = 0;

    for (const inv of (invoices || [])) {
      const breakdown = inv.vat_breakdown || [];
      if (breakdown.length > 0) {
        // Cas normal : on a le détail par taux
        for (const v of breakdown) {
          const k = `${v.rate}%`;
          ventilation[k] = ventilation[k] || { rate: v.rate, collectee: 0, deductible: 0, baseCollectee: 0, baseDeductible: 0 };
          ventilation[k].collectee += v.vat_cents || 0;
          ventilation[k].baseCollectee += v.base_cents || 0;
          totalCollectee += v.vat_cents || 0;
          totalBaseCollectee += v.base_cents || 0;
        }
      } else {
        // Fallback : pas de détail, on agrège seulement aux totaux
        totalCollectee += inv.vat_total_cents || 0;
        totalBaseCollectee += inv.subtotal_ht_cents || 0;
      }
    }

    for (const p of (purchases || [])) {
      const breakdown = p.vat_breakdown || [];
      if (breakdown.length > 0) {
        for (const v of breakdown) {
          const k = `${v.rate}%`;
          ventilation[k] = ventilation[k] || { rate: v.rate, collectee: 0, deductible: 0, baseCollectee: 0, baseDeductible: 0 };
          ventilation[k].deductible += v.vat_cents || 0;
          ventilation[k].baseDeductible += v.base_cents || 0;
          totalDeductible += v.vat_cents || 0;
          totalBaseDeductible += v.base_cents || 0;
        }
      } else {
        totalDeductible += p.vat_total_cents || 0;
        totalBaseDeductible += p.subtotal_ht_cents || 0;
      }
    }

    setPeriodData({
      label,
      periode: `${fmtDate(firstDay)} → ${fmtDate(lastDay)}`,
      ventilation: Object.values(ventilation).sort((a, b) => b.rate - a.rate),
      totalCollectee,
      totalDeductible,
      totalBaseCollectee,
      totalBaseDeductible,
      totalNet: totalCollectee - totalDeductible,
      invoices: invoices || [],
      purchases: purchases || []
    });
    console.log("[VAT cabinet v834]", {
      invoices_count: (invoices || []).length,
      purchases_count: (purchases || []).length,
      totalCollectee,
      totalDeductible,
      sample_invoice: invoices?.[0] ? {
        number: invoices[0].number,
        vat_total_cents: invoices[0].vat_total_cents,
        subtotal_ht_cents: invoices[0].subtotal_ht_cents,
        vat_breakdown: invoices[0].vat_breakdown
      } : null
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
        <VatSummaryTable periodData={periodData} token={token} />
      </div>

      <div className="card card-pad" style={{ fontSize: 11, color: "var(--muted2)" }}>
        <strong>URSSAF</strong> · Cotisations sociales auto-entrepreneurs : 12,3% (vente) ou 21,2% (services) du CA encaissé.
        Calcul détaillé URSSAF/DSN à venir en Sprint 4.
      </div>
    </div>
  );
}

/**
 * VatSummaryTable — Tableau récap TVA cabinet
 * Structure :
 *   - 1 ligne "Factures émises" (toujours affichée, dépliable)
 *   - 1 ligne "Achats" (toujours affichée, dépliable)
 *   - 1 ligne TOTAL
 *   - 1 ligne TVA nette à reverser / crédit
 */
function VatSummaryTable({ periodData, token }) {
  const [expanded, setExpanded] = React.useState(null); // "invoices" | "purchases" | null
  const [preview, setPreview] = React.useState(null); // { url, title } | null

  function openPdf(doc, e) {
    e.stopPropagation();
    // Cas 1 : facture (URL complète stockée dans facturx_pdf_url ou pdf_url)
    const invoiceUrl = doc.facturx_pdf_url || doc.pdf_url;
    // Cas 2 : achat (path stocké dans file_url, bucket purchases-attach)
    const purchasePath = doc.file_url;

    if (invoiceUrl) {
      // Facture : on passe l'URL stockée au modal qui se charge de la rafraîchir
      setPreview({
        url: invoiceUrl,
        title: `Facture ${doc.number || ""}`
      });
    } else if (purchasePath) {
      // Achat : construire URL Storage (le modal la rafraîchit ensuite)
      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const storedUrl = `${SUPABASE_URL}/storage/v1/object/sign/purchases-attach/${purchasePath}`;
      setPreview({
        url: storedUrl,
        title: `Achat ${doc.vendor_name || ""}${doc.number ? ` · ${doc.number}` : ""}`
      });
    }
  }

  const invoices = periodData.invoices || [];
  const purchases = periodData.purchases || [];
  const invHT = invoices.reduce((s, d) => s + (d.subtotal_ht_cents || 0), 0);
  const invVAT = invoices.reduce((s, d) => s + (d.vat_total_cents || 0), 0);
  const purHT = purchases.reduce((s, d) => s + (d.subtotal_ht_cents || 0), 0);
  const purVAT = purchases.reduce((s, d) => s + (d.vat_total_cents || 0), 0);

  function CategoryRow({ kind, label, docs, ht, vat, accentColor }) {
    const isExpanded = expanded === kind;
    const hasItems = docs.length > 0;
    return (
      <>
        <tr
          onClick={() => setExpanded(isExpanded ? null : kind)}
          style={{
            cursor: "pointer",
            background: isExpanded ? "rgba(255,255,255,0.03)" : "transparent",
            fontWeight: 500
          }}
        >
          <td style={{ width: 24, textAlign: "center", color: "var(--muted)" }}>
            {isExpanded ? "▾" : "▸"}
          </td>
          <td>
            <div style={{ fontSize: 13 }}>{label}</div>
            <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>
              {docs.length} document{docs.length > 1 ? "s" : ""}
            </div>
          </td>
          <td style={{ textAlign: "right", fontFamily: "monospace", fontSize: 13 }}>
            {hasItems ? fmtEUR(ht) : <span style={{ color: "var(--muted2)" }}>—</span>}
          </td>
          <td style={{ textAlign: "right", fontFamily: "monospace", fontSize: 13, color: hasItems ? accentColor : "var(--muted2)" }}>
            {hasItems ? fmtEUR(vat) : "—"}
          </td>
        </tr>
        {isExpanded && (
          <tr>
            <td colSpan={4} style={{ padding: 0, background: "rgba(0,0,0,0.18)" }}>
              {hasItems ? (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                  <thead>
                    <tr style={{ color: "var(--muted)", fontSize: 9, textTransform: "uppercase", letterSpacing: 0.5 }}>
                      <th style={{ padding: "6px 12px 6px 40px", textAlign: "left" }}>Document</th>
                      <th style={{ padding: "6px 12px", textAlign: "right" }}>HT</th>
                      <th style={{ padding: "6px 12px", textAlign: "right", width: 50 }}>Taux</th>
                      <th style={{ padding: "6px 12px", textAlign: "right" }}>TVA</th>
                      <th style={{ padding: "6px 12px", width: 110 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {docs.map((d) => {
                      const ht = d.subtotal_ht_cents || 0;
                      const vat = d.vat_total_cents || 0;
                      const bd = d.vat_breakdown || [];
                      let rateLabel = "—";
                      if (bd.length === 1) rateLabel = `${bd[0].rate}%`;
                      else if (bd.length > 1) rateLabel = "Multi";
                      else if (ht > 0 && vat > 0) rateLabel = `~${Math.round((vat / ht) * 100)}%`;
                      const pdfUrl = d.facturx_pdf_url || d.pdf_url || d.file_url || null;
                      const docLabel = kind === "invoices"
                        ? (d.number || "Sans n°")
                        : `${d.vendor_name || "Fournisseur"}${d.number ? ` · ${d.number}` : ""}`;
                      return (
                        <tr key={d.id} style={{ borderTop: "1px solid var(--border2)" }}>
                          <td style={{ padding: "8px 12px 8px 40px" }}>
                            <div style={{ fontSize: 12, fontWeight: 500 }}>{docLabel}</div>
                            <div style={{ fontSize: 10, color: "var(--muted)" }}>{fmtDate(d.issue_date)}{d.status ? ` · ${d.status}` : ""}</div>
                          </td>
                          <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 12 }}>{fmtEUR(ht)}</td>
                          <td style={{ padding: "8px 12px", textAlign: "right", fontSize: 11, color: "var(--muted)" }}>{rateLabel}</td>
                          <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: 12, color: accentColor }}>{fmtEUR(vat)}</td>
                          <td style={{ padding: "8px 12px", textAlign: "right" }}>
                            {pdfUrl && (
                              <button
                                onClick={(e) => openPdf(d, e)}
                                className="btn btn-ghost btn-xs"
                                style={{ fontSize: 10, padding: "3px 8px" }}
                              >
                                👁 Voir
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div style={{ padding: "16px 40px", color: "var(--muted)", fontSize: 11, fontStyle: "italic" }}>
                  Aucun document sur la période
                </div>
              )}
            </td>
          </tr>
        )}
      </>
    );
  }

  return (
    <>
    <table style={tableStyle}>
      <thead>
        <tr>
          <th style={{ width: 24 }}></th>
          <th>Catégorie</th>
          <th style={{ textAlign: "right" }}>Base HT</th>
          <th style={{ textAlign: "right" }}>TVA</th>
        </tr>
      </thead>
      <tbody>
        <CategoryRow
          kind="invoices"
          label="Factures émises"
          docs={invoices}
          ht={invHT}
          vat={invVAT}
          accentColor="var(--gold)"
        />
        <CategoryRow
          kind="purchases"
          label="Achats"
          docs={purchases}
          ht={purHT}
          vat={purVAT}
          accentColor="var(--green)"
        />
      </tbody>
      <tfoot>
        <tr style={{ fontWeight: 700, background: "rgba(255,255,255,0.02)" }}>
          <td></td>
          <td>TOTAL</td>
          <td style={{ textAlign: "right", fontFamily: "monospace" }}>
            <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 400 }}>Collecté {fmtEUR(invHT)}</div>
            <div style={{ fontSize: 10, color: "var(--muted)", fontWeight: 400 }}>Déductible {fmtEUR(purHT)}</div>
          </td>
          <td style={{ textAlign: "right", fontFamily: "monospace" }}>
            <div style={{ fontSize: 10, color: "var(--gold)", fontWeight: 400 }}>Coll. {fmtEUR(invVAT)}</div>
            <div style={{ fontSize: 10, color: "var(--green)", fontWeight: 400 }}>Déd. {fmtEUR(purVAT)}</div>
          </td>
        </tr>
        <tr style={{ background: "rgba(212,168,67,0.08)", fontWeight: 700 }}>
          <td colSpan={3} style={{ textAlign: "right" }}>
            TVA nette {(invVAT - purVAT) >= 0 ? "à reverser" : "crédit"}
          </td>
          <td style={{ textAlign: "right", fontFamily: "monospace", color: "var(--gold)" }}>
            {fmtEUR(Math.abs(invVAT - purVAT))}
          </td>
        </tr>
      </tfoot>
    </table>
    {preview && (
      <PdfPreviewModal
        token={token}
        url={preview.url}
        title={preview.title}
        onClose={() => setPreview(null)}
      />
    )}
    </>
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
    const r = await fetch("/api/firm-invitation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "signal_" + act, payload: { signal_id: signalId } })
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

const pdfModalBackdrop = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 400, padding: 20 };
const pdfModalBox = { width: "100%", maxWidth: 1100, height: "92vh", display: "flex", flexDirection: "column", overflow: "hidden", padding: 0 };
