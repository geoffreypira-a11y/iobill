import React, { useState, useEffect, useMemo } from "react";
import { useParams, Link } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtEUR, fmtDate, daysUntil } from "../../lib/helpers.js";

/**
 * FirmClientFichePage — Vue synthetique d'un dossier client cote cabinet.
 * RLS Supabase verifie que le user est bien membre du firm associe.
 */
export function FirmClientFichePage({ token, user }) {
  const { id: companyId } = useParams();
  const [client, setClient] = useState(null);   // company supervisee
  const [link, setLink] = useState(null);       // ligne firm_clients
  const [stats, setStats] = useState(null);
  const [recentInvoices, setRecentInvoices] = useState([]);
  const [vatPending, setVatPending] = useState(null);
  const [urssafPending, setUrssafPending] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      // 1) Verifier l'acces : on cherche un firm_clients pour ce companyId
      //    dont le user est partner/accountant/assistant du firm
      const fcs = await sb.select(token, "firm_clients", {
        filter: `company_id=eq.${companyId}&revoked_at=is.null&accepted_at=not.is.null`,
        limit: 5
      });
      if (!alive) return;
      if (!fcs || fcs.length === 0) {
        setErr("Vous n'avez pas accès à ce dossier client.");
        setLoading(false);
        return;
      }

      // RLS Supabase a deja fait le filtre cote DB, mais on verifie cote client
      // qu'on a bien les firm_users matchant
      const firmIds = fcs.map((f) => f.firm_id);
      const myFus = await sb.select(token, "firm_users", {
        filter: `user_id=eq.${user.id}&firm_id=in.(${firmIds.join(",")})`,
        limit: 5
      });
      if (!myFus || myFus.length === 0) {
        setErr("Vous n'êtes pas membre du cabinet associé.");
        setLoading(false);
        return;
      }
      setLink(fcs[0]);

      // 2) Charger la company (limite par RLS company_users + firm_clients)
      const co = await sb.selectOne(token, "companies", `id=eq.${companyId}`);
      if (!co) { setErr("Société introuvable"); setLoading(false); return; }
      setClient(co);

      // 3) Stats : invoices, vat_returns, urssaf_returns
      const [invs, vat, urssaf] = await Promise.all([
        sb.select(token, "invoices", {
          filter: `company_id=eq.${companyId}&status=in.(issued,sent,partial,paid,overdue)`,
          order: "issue_date.desc",
          limit: 20
        }),
        sb.select(token, "vat_returns", {
          filter: `company_id=eq.${companyId}&status=in.(pending,ready)`,
          order: "period_end.desc",
          limit: 1
        }),
        sb.select(token, "urssaf_returns", {
          filter: `company_id=eq.${companyId}&status=in.(pending,ready,draft)`,
          order: "period_end.desc",
          limit: 1
        })
      ]);

      if (!alive) return;
      setRecentInvoices(invs || []);
      setVatPending((vat || [])[0] || null);
      setUrssafPending((urssaf || [])[0] || null);

      // Calcul stats simples
      const remaining = (invs || [])
        .filter((i) => ["issued", "sent", "partial", "overdue"].includes(i.status))
        .reduce((s, i) => s + ((i.total_ttc_cents || 0) - (i.paid_cents || 0)), 0);
      const overdueCount = (invs || []).filter((i) => {
        return i.status === "overdue" || (i.due_date && new Date(i.due_date) < new Date() && i.paid_cents < i.total_ttc_cents);
      }).length;

      setStats({ remaining, overdueCount, totalCount: (invs || []).length });
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, companyId, user.id]);

  if (loading) {
    return <div className="page"><div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Chargement...</div></div>;
  }

  if (err) {
    return (
      <div className="page" style={{ maxWidth: 520 }}>
        <div className="card card-pad" style={{ textAlign: "center", padding: 50 }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div>
          <div style={{ marginBottom: 18 }}>{err}</div>
          <Link to="/firm" className="btn btn-primary">← Retour au cabinet</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div style={{ marginBottom: 12 }}>
        <Link to="/firm" style={{ fontSize: 12, color: "var(--gold)", textDecoration: "none" }}>
          ← Retour au cabinet
        </Link>
      </div>

      <div className="page-header">
        <div>
          <div className="page-title">{(client?.legal_name || "—").toUpperCase()}</div>
          <div className="page-sub" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span className="mono" style={{ fontSize: 11 }}>{client?.siret || ""}</span>
            <span className="badge badge-gold">
              {link?.access_level === "editor" ? "✏️ Édition" : "👁️ Lecture seule"}
            </span>
            {client?.fiscal_regime && <span style={{ fontSize: 11 }}>· {client.fiscal_regime}</span>}
            {client?.vat_regime && <span style={{ fontSize: 11 }}>· {client.vat_regime}</span>}
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="kpi-grid" style={{ marginBottom: 18 }}>
        <div className="kpi">
          <div className="kpi-label">Encours</div>
          <div className={"kpi-val " + (stats?.remaining > 0 ? "orange" : "green")}>
            {fmtEUR(stats?.remaining || 0)}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Factures actives</div>
          <div className="kpi-val">{stats?.totalCount || 0}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">En retard</div>
          <div className={"kpi-val " + ((stats?.overdueCount || 0) > 0 ? "red" : "green")}>
            {stats?.overdueCount || 0}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">TVA à déclarer</div>
          <div className={"kpi-val " + (vatPending ? "gold" : "green")}>
            {vatPending ? "⚠️ Oui" : "✓ Non"}
          </div>
          {vatPending && (
            <div className="kpi-foot">Période fin {fmtDate(vatPending.period_end)}</div>
          )}
        </div>
      </div>

      {/* Alertes fiscales */}
      {(vatPending || urssafPending) && (
        <div className="card card-pad" style={{ marginBottom: 16, borderLeft: "3px solid var(--gold)" }}>
          <div style={{ fontSize: 12, color: "var(--gold)", letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 600, marginBottom: 10 }}>
            ⚠️ Alertes fiscales
          </div>
          {vatPending && (
            <div style={{ fontSize: 13, marginBottom: 6 }}>
              <strong>TVA</strong> — Période {fmtDate(vatPending.period_start)} → {fmtDate(vatPending.period_end)}
              {vatPending.due_date && (
                <span style={{ color: daysUntil(vatPending.due_date) < 7 ? "var(--red)" : "var(--orange)", marginLeft: 8 }}>
                  (échéance dans {daysUntil(vatPending.due_date)} j)
                </span>
              )}
            </div>
          )}
          {urssafPending && (
            <div style={{ fontSize: 13 }}>
              <strong>URSSAF</strong> — Période {fmtDate(urssafPending.period_start)} → {fmtDate(urssafPending.period_end)}
            </div>
          )}
        </div>
      )}

      {/* Factures récentes */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 12 }}>
          Dernières factures
        </div>
        {recentInvoices.length === 0 ? (
          <div style={{ color: "var(--muted)", padding: 12 }}>Aucune facture pour ce client.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>N°</th>
                <th>Émise le</th>
                <th>Échéance</th>
                <th style={{ textAlign: "right" }}>Montant TTC</th>
                <th style={{ textAlign: "right" }}>Reste</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {recentInvoices.slice(0, 10).map((inv) => {
                const remaining = (inv.total_ttc_cents || 0) - (inv.paid_cents || 0);
                return (
                  <tr key={inv.id}>
                    <td className="mono">{inv.number}</td>
                    <td>{fmtDate(inv.issue_date)}</td>
                    <td>{fmtDate(inv.due_date)}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(inv.total_ttc_cents)}</td>
                    <td className="mono" style={{ textAlign: "right", color: remaining > 0 ? "var(--orange)" : "var(--muted)" }}>
                      {remaining > 0 ? fmtEUR(remaining) : "—"}
                    </td>
                    <td><InvoiceStatusBadge status={inv.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ marginTop: 24, fontSize: 11, color: "var(--muted)", textAlign: "center", lineHeight: 1.7 }}>
        Toutes vos consultations et actions sur ce dossier sont enregistrées dans l'audit log de l'entreprise cliente.<br />
        Le client peut révoquer votre accès à tout moment.
      </div>
    </div>
  );
}

function InvoiceStatusBadge({ status }) {
  const m = {
    draft: ["badge-muted", "Brouillon"], issued: ["badge-gold", "Émise"], sent: ["badge-gold", "Envoyée"],
    partial: ["badge-orange", "Partielle"], paid: ["badge-green", "Payée"],
    overdue: ["badge-red", "Retard"], canceled: ["badge-muted", "Annulée"]
  }[status] || ["badge-muted", status];
  return <span className={"badge " + m[0]}>{m[1]}</span>;
}
