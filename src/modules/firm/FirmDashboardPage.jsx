import React, { useEffect, useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtEUR, fmtDate } from "../../lib/helpers.js";

/**
 * FirmDashboard — Tableau de bord d'un cabinet d'expertise comptable
 * Permet a un comptable de voir d'un coup d'oeil l'etat de tous ses dossiers clients :
 * factures impayees, TVA a declarer, URSSAF a payer, etc.
 *
 * Pre-requis : l'utilisateur courant doit etre membre d'un firm (firm_users)
 */
export function FirmDashboardPage({ token, user }) {
  const [firm, setFirm] = useState(null);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  useEffect(() => {
    let alive = true;
    (async () => {
      // 1) Recuperer le firm de l'utilisateur (premier firm dont il est membre)
      const fu = await sb.select(token, "firm_users", {
        filter: `user_id=eq.${user.id}`,
        select: "firm_id,role",
        limit: 1
      });
      if (!alive) return;
      if (!fu || fu.length === 0) {
        setLoading(false);
        return;
      }
      const firmId = fu[0].firm_id;
      const f = await sb.selectOne(token, "firms", `id=eq.${firmId}`);
      setFirm(f);

      // 2) Recuperer toutes les companies clientes
      const fc = await sb.select(token, "firm_clients", {
        filter: `firm_id=eq.${firmId}&revoked_at=is.null`,
        select: "company_id,access_level,accepted_at,companies(id,legal_name,siret,vat_regime,fiscal_regime,modules)"
      });

      const cos = (fc || []).map((row) => row.companies).filter(Boolean);

      // 3) Pour chaque company, on charge les KPI essentiels
      const enriched = await Promise.all(cos.map(async (c) => {
        const [unpaid, draft, vatPending, urssafPending] = await Promise.all([
          sb.select(token, "invoices", {
            filter: `company_id=eq.${c.id}&status=in.(issued,sent,partial,overdue)`,
            select: "total_ttc_cents,paid_cents,due_date,status",
            limit: 200
          }),
          sb.select(token, "invoices", {
            filter: `company_id=eq.${c.id}&status=eq.draft`,
            select: "id",
            limit: 50
          }),
          sb.select(token, "vat_returns", {
            filter: `company_id=eq.${c.id}&status=eq.pending`,
            order: "period_end.desc",
            select: "period_end,due_date",
            limit: 1
          }),
          sb.select(token, "urssaf_returns", {
            filter: `company_id=eq.${c.id}&status=eq.pending`,
            order: "period_end.desc",
            select: "period_end,due_date",
            limit: 1
          })
        ]);

        const remaining = (unpaid || []).reduce((s, i) => s + ((i.total_ttc_cents || 0) - (i.paid_cents || 0)), 0);
        const overdue = (unpaid || []).filter((i) => i.status === "overdue" || (i.due_date && new Date(i.due_date) < new Date())).length;

        return {
          ...c,
          access_level: fc.find((x) => x.companies?.id === c.id)?.access_level || "viewer",
          remaining_cents: remaining,
          overdue_count: overdue,
          drafts: (draft || []).length,
          vat_pending: (vatPending || [])[0] || null,
          urssaf_pending: (urssafPending || [])[0] || null
        };
      }));

      if (!alive) return;
      setClients(enriched);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, user.id]);

  const filtered = useMemo(() => {
    const s = search.toLowerCase().trim();
    return clients.filter((c) => {
      const matchS = !s || (c.legal_name || "").toLowerCase().includes(s) || (c.siret || "").includes(s);
      let matchF = true;
      if (statusFilter === "overdue") matchF = c.overdue_count > 0;
      else if (statusFilter === "vat") matchF = !!c.vat_pending;
      else if (statusFilter === "urssaf") matchF = !!c.urssaf_pending;
      else if (statusFilter === "ok") matchF = !c.overdue_count && !c.vat_pending && !c.urssaf_pending;
      return matchS && matchF;
    });
  }, [clients, search, statusFilter]);

  const totals = useMemo(() => {
    return {
      clients: clients.length,
      unpaid_total: clients.reduce((s, c) => s + c.remaining_cents, 0),
      overdue_clients: clients.filter((c) => c.overdue_count > 0).length,
      vat_pending: clients.filter((c) => !!c.vat_pending).length,
      urssaf_pending: clients.filter((c) => !!c.urssaf_pending).length
    };
  }, [clients]);

  if (loading) {
    return <div className="page"><div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Chargement...</div></div>;
  }

  if (!firm) {
    return (
      <div className="page">
        <div className="card card-pad" style={{ textAlign: "center", padding: 50 }}>
          <div style={{ fontSize: 40, marginBottom: 14 }}>🏛️</div>
          <div style={{ marginBottom: 8, fontWeight: 600 }}>Vous n'êtes membre d'aucun cabinet</div>
          <div style={{ fontSize: 12, color: "var(--muted2)", marginBottom: 18 }}>
            Le portail Cabinet est inclus dans le plan IO BILL Cabinet (19,90 €/mois).
          </div>
          <Link to="/firm/onboarding" className="btn btn-primary">Activer le plan Cabinet</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">CABINET — {firm.legal_name}</div>
          <div className="page-sub">
            {firm.client_count || clients.length} clients sous gestion
            {firm.max_clients ? ` / ${firm.max_clients} max` : ""}
            {firm.stripe_sub_status === "active" && <span style={{ marginLeft: 8, color: "var(--green)" }}>· Abonnement actif</span>}
            {firm.stripe_sub_status === "past_due" && <span style={{ marginLeft: 8, color: "var(--red)" }}>· Paiement en échec</span>}
            {!firm.stripe_sub_status && <span style={{ marginLeft: 8, color: "var(--orange)" }}>· Période d'essai</span>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {(!firm.stripe_sub_status || firm.stripe_sub_status === "canceled") && (
            <button
              className="btn btn-primary"
              onClick={async () => {
                try {
                  const r = await fetch("/api/stripe", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ plan: "firm", firm_id: firm.id })
                  });
                  const j = await r.json();
                  if (j.free_rank) {
                    const ok = confirm(`🎉 Félicitations !\n\nVous êtes le ${j.free_rank}e cabinet à profiter de notre offre de lancement : votre abonnement Cabinet sera GRATUIT À VIE.\n\nValidez la souscription Stripe pour activer votre cabinet (0,00 € débité).`);
                    if (!ok) return;
                  }
                  if (j.url) window.location.href = j.url;
                  else alert(j.error || "Erreur Stripe");
                } catch { alert("Erreur réseau"); }
              }}
            >
              💳 S'abonner Cabinet (49 €/mois)
            </button>
          )}
          <Link to="/firm/team" className="btn btn-ghost">
            <Icon name="user" size={13} /> Équipe
          </Link>
          <Link to="/firm/clients/new" className="btn btn-primary">
            + Inviter un client
          </Link>
        </div>
      </div>

      {/* KPI globaux */}
      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        <div className="kpi">
          <div className="kpi-label">Clients</div>
          <div className="kpi-val">{totals.clients}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Encours global</div>
          <div className={"kpi-val " + (totals.unpaid_total > 0 ? "orange" : "green")}>
            {fmtEUR(totals.unpaid_total)}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Clients en retard</div>
          <div className={"kpi-val " + (totals.overdue_clients > 0 ? "red" : "green")}>
            {totals.overdue_clients}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">TVA à déclarer</div>
          <div className={"kpi-val " + (totals.vat_pending > 0 ? "gold" : "green")}>
            {totals.vat_pending}
          </div>
        </div>
      </div>

      {/* Recherche + filtres */}
      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap" }}>
        <input
          className="search-input"
          placeholder="Rechercher un client (nom, SIRET)..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="tabs" style={{ margin: 0 }}>
          {[
            ["all", "Tous"],
            ["overdue", "Retards"],
            ["vat", "TVA"],
            ["urssaf", "URSSAF"],
            ["ok", "À jour"]
          ].map(([k, l]) => (
            <button
              key={k}
              className={"tab" + (statusFilter === k ? " active" : "")}
              onClick={() => setStatusFilter(k)}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card card-pad" style={{ textAlign: "center", padding: 50 }}>
          <div style={{ fontSize: 40, marginBottom: 14 }}>📋</div>
          <div style={{ fontSize: 14, color: "var(--muted2)" }}>
            {clients.length === 0 ? "Aucun client pour l'instant." : "Aucun client ne correspond à vos filtres."}
          </div>
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Régime</th>
                <th style={{ textAlign: "right" }}>Encours</th>
                <th>Alertes</th>
                <th>Accès</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <tr key={c.id} style={{ cursor: "pointer" }}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{c.legal_name || "—"}</div>
                    <div className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>{c.siret || ""}</div>
                  </td>
                  <td style={{ fontSize: 11, color: "var(--muted2)" }}>
                    {c.fiscal_regime || c.vat_regime || "—"}
                  </td>
                  <td className="mono" style={{ textAlign: "right", color: c.remaining_cents > 0 ? "var(--orange)" : "var(--muted)" }}>
                    {fmtEUR(c.remaining_cents)}
                  </td>
                  <td>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      {c.overdue_count > 0 && (
                        <span className="badge badge-red" style={{ fontSize: 10 }}>{c.overdue_count} retard{c.overdue_count > 1 ? "s" : ""}</span>
                      )}
                      {c.vat_pending && (
                        <span className="badge badge-gold" style={{ fontSize: 10 }}>TVA</span>
                      )}
                      {c.urssaf_pending && (
                        <span className="badge badge-gold" style={{ fontSize: 10 }}>URSSAF</span>
                      )}
                      {c.drafts > 0 && (
                        <span className="badge badge-muted" style={{ fontSize: 10 }}>{c.drafts} brouillon{c.drafts > 1 ? "s" : ""}</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <span className="badge badge-muted" style={{ fontSize: 10 }}>
                      {c.access_level === "editor" ? "Édition" : "Lecture"}
                    </span>
                  </td>
                  <td>
                    <Link
                      to={`/firm/clients/${c.id}`}
                      className="btn btn-ghost btn-xs"
                      style={{ textDecoration: "none" }}
                    >
                      Ouvrir →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 28, fontSize: 11, color: "var(--muted)", textAlign: "center" }}>
        Vous accédez aux dossiers de vos clients en mode supervision. Toutes les actions sont tracées dans l'audit log.
      </div>
    </div>
  );
}
