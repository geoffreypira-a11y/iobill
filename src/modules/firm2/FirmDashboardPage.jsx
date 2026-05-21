import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";

/**
 * FirmDashboardPage — Dashboard Cabinet Comptable.
 *
 * Charte IO BILL identique à celle de l'abonné Pro :
 *   - Classes natives : .page, .page-header, .page-title, .page-sub,
 *     .card, .card-pad, .btn, .btn-primary, .btn-ghost, .btn-sm,
 *     .kpi, .kpi-grid, .kpi-label, .kpi-val,
 *     .badge, .badge-red, .badge-gold (badge-orange uniquement pour
 *     les signalements de severity=warning)
 *   - Variables CSS : var(--gold), var(--red), var(--muted), var(--muted2),
 *     var(--text), var(--card), var(--border), var(--border2), var(--bg)
 *   - Police : Syne (titres, KPI valeurs) et DM Sans (body) — hérité
 */
export function FirmDashboardPage({ token, user, firm }) {
  const [loading, setLoading] = useState(true);
  const [clients, setClients] = useState([]);
  const [signals, setSignals] = useState([]);
  const [messages, setMessages] = useState([]);

  useEffect(() => {
    if (!token || !firm?.id) return;
    let alive = true;
    (async () => {
      try {
        const [links, sigs, msgs] = await Promise.all([
          sb.select(token, "firm_client_links", {
            filter: `firm_id=eq.${firm.id}&accepted_at=not.is.null&revoked_at=is.null`,
            select: "id,company_id,accepted_at",
            order: "accepted_at.desc",
            limit: 50
          }),
          sb.select(token, "firm_signals", {
            filter: `firm_id=eq.${firm.id}&status=eq.open`,
            select: "id,company_id,severity,title,created_at",
            order: "created_at.desc",
            limit: 20
          }),
          sb.select(token, "firm_messages", {
            filter: `firm_id=eq.${firm.id}`,
            select: "id,company_id,author_role,content,created_at,read_at",
            order: "created_at.desc",
            limit: 10
          })
        ]);
        if (!alive) return;

        const linksList = links || [];
        const companyIds = linksList.map((l) => l.company_id);
        let companies = [];
        if (companyIds.length > 0) {
          companies = await sb.select(token, "companies", {
            filter: `id=in.(${companyIds.join(",")})`,
            select: "id,legal_name,trade_name,siret,sub_status",
            limit: companyIds.length
          });
        }
        const clientsList = linksList.map((l) => {
          const co = (companies || []).find((c) => c.id === l.company_id);
          return {
            link_id: l.id,
            company_id: l.company_id,
            name: co?.trade_name || co?.legal_name || "Société sans nom",
            siret: co?.siret,
            sub_status: co?.sub_status,
            signals_count: (sigs || []).filter((s) => s.company_id === l.company_id).length
          };
        });

        if (!alive) return;
        setClients(clientsList);
        setSignals(sigs || []);
        setMessages(msgs || []);
      } catch (e) {
        console.warn("[FirmDashboard] error:", e?.message);
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, firm?.id]);

  const todayStr = new Date().toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  });

  const kpis = {
    toValidate: 0,
    signalsOpen: signals.length,
    deadlines7: 0,
    unreadMessages: messages.filter((m) => m.author_role === "client" && !m.read_at).length
  };

  return (
    <div className="page">
      {/* Header */}
      <div className="page-header">
        <div>
          <div className="page-title">CABINET</div>
          <div className="page-sub">
            {firm.name} · {clients.length} {clients.length > 1 ? "clients" : "client"} · {todayStr}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Link to="/firm/clients/new" className="btn btn-primary">
            <Icon name="plus" size={14} />
            Inviter un client
          </Link>
        </div>
      </div>

      {/* KPIs — utilise les classes natives .kpi-grid, .kpi, .kpi-label, .kpi-val */}
      <div className="kpi-grid">
        <KpiCard
          label="À valider"
          value={kpis.toValidate}
          colorClass="gold"
          hint="Mode Marathon — Sprint 5"
        />
        <KpiCard
          label="Signalements ouverts"
          value={kpis.signalsOpen}
          colorClass={kpis.signalsOpen > 0 ? "red" : "gold"}
          hint="En attente de résolution"
        />
        <KpiCard
          label="Échéances 7 jours"
          value={kpis.deadlines7}
          colorClass="gold"
          hint="TVA · URSSAF · DSN"
        />
        <KpiCard
          label="Messages non lus"
          value={kpis.unreadMessages}
          colorClass={kpis.unreadMessages > 0 ? "gold" : "gold"}
          hint="Côté clients"
        />
      </div>

      {/* CTA Mode Marathon */}
      <div className="card card-pad" style={{ marginTop: 22, marginBottom: 22 }}>
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12
        }}>
          <div>
            <div style={{
              fontFamily: "Syne, sans-serif",
              fontSize: 16,
              fontWeight: 700,
              color: "var(--gold)",
              marginBottom: 4
            }}>
              🚀 Mode Marathon
            </div>
            <div style={{ fontSize: 12, color: "var(--muted2)" }}>
              Validez les factures de vos clients en série, ultra-rapide.
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" disabled title="Disponible au Sprint 5">
            Bientôt disponible
          </button>
        </div>
      </div>

      {/* Grid 2 colonnes : Mes clients + Messages récents */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 22,
        marginBottom: 22
      }}>
        {/* Mes clients */}
        <div className="card card-pad">
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 14
          }}>
            <div className="kpi-label" style={{ marginBottom: 0 }}>Mes clients</div>
            <Link to="/firm/clients" style={{
              fontSize: 11,
              color: "var(--gold)",
              textDecoration: "none"
            }}>
              Tout voir →
            </Link>
          </div>

          {loading ? (
            <EmptyState text="Chargement..." />
          ) : clients.length === 0 ? (
            <EmptyState
              icon="👥"
              title="Aucun client pour l'instant"
              text="Invitez votre premier client pour démarrer."
              ctaTo="/firm/clients/new"
              ctaLabel="Inviter un client"
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {clients.slice(0, 5).map((c) => (
                <Link
                  key={c.link_id}
                  to={`/firm/clients/${c.company_id}`}
                  className="card"
                  style={{
                    padding: "10px 12px",
                    textDecoration: "none",
                    color: "var(--text)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center"
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13,
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap"
                    }}>
                      {c.name}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                      {c.siret ? `SIRET ${c.siret}` : "SIRET non renseigné"}
                    </div>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {c.signals_count > 0 && (
                      <span className="badge badge-red">{c.signals_count} ⚠</span>
                    )}
                    <span style={{ fontSize: 14, color: "var(--muted)" }}>→</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Messages récents */}
        <div className="card card-pad">
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 14
          }}>
            <div className="kpi-label" style={{ marginBottom: 0 }}>Messages récents</div>
            <Link to="/firm/messages" style={{
              fontSize: 11,
              color: "var(--gold)",
              textDecoration: "none"
            }}>
              Tout voir →
            </Link>
          </div>

          {loading ? (
            <EmptyState text="Chargement..." />
          ) : messages.length === 0 ? (
            <EmptyState
              icon="💬"
              title="Aucun message"
              text="Vos échanges avec vos clients apparaîtront ici."
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {messages.slice(0, 5).map((m) => {
                const co = clients.find((c) => c.company_id === m.company_id);
                const unread = m.author_role === "client" && !m.read_at;
                return (
                  <div
                    key={m.id}
                    className="card"
                    style={{
                      padding: "10px 12px",
                      borderLeft: unread ? "3px solid var(--gold)" : "1px solid var(--border2)"
                    }}
                  >
                    <div style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginBottom: 4
                    }}>
                      <div style={{ fontSize: 12, fontWeight: 500 }}>
                        {co?.name || "Client"}
                        {unread && (
                          <span style={{
                            marginLeft: 6,
                            fontSize: 10,
                            color: "var(--gold)"
                          }}>
                            ● non lu
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 10, color: "var(--muted)" }}>
                        {new Date(m.created_at).toLocaleDateString("fr-FR", {
                          day: "numeric",
                          month: "short"
                        })}
                      </div>
                    </div>
                    <div style={{
                      fontSize: 11,
                      color: "var(--muted2)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap"
                    }}>
                      {m.content}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Signalements ouverts */}
      <div className="card card-pad">
        <div className="kpi-label" style={{ marginBottom: 14 }}>Signalements ouverts</div>

        {loading ? (
          <EmptyState text="Chargement..." />
        ) : signals.length === 0 ? (
          <EmptyState
            icon="✓"
            title="Aucun signalement ouvert"
            text="Tous les comptes de vos clients sont à jour."
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {signals.slice(0, 8).map((s) => {
              const co = clients.find((c) => c.company_id === s.company_id);
              const badgeClass = s.severity === "critical" ? "badge badge-red"
                : s.severity === "warning" ? "badge badge-orange"
                : "badge badge-gold";
              const icon = s.severity === "critical" ? "🚨"
                : s.severity === "warning" ? "⚠️"
                : "ℹ️";
              return (
                <Link
                  key={s.id}
                  to={`/firm/clients/${s.company_id}`}
                  className="card"
                  style={{
                    padding: "10px 12px",
                    textDecoration: "none",
                    color: "var(--text)",
                    display: "flex",
                    alignItems: "center",
                    gap: 10
                  }}
                >
                  <span style={{ fontSize: 14 }}>{icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 500 }}>{s.title}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                      {co?.name || "Client"} · {new Date(s.created_at).toLocaleDateString("fr-FR")}
                    </div>
                  </div>
                  <span className={badgeClass}>{s.severity}</span>
                  <span style={{ fontSize: 14, color: "var(--muted)" }}>→</span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * KpiCard — utilise les classes natives .kpi, .kpi-label, .kpi-val (avec
 * variante de couleur : gold, green, orange, red).
 */
function KpiCard({ label, value, colorClass, hint }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-val ${colorClass || ""}`}>{value}</div>
      {hint && <div className="kpi-foot">{hint}</div>}
    </div>
  );
}

/**
 * EmptyState — pas de classe native disponible, donc styles inline minimaux
 * mais respectant les variables CSS.
 */
function EmptyState({ icon, title, text, ctaTo, ctaLabel }) {
  return (
    <div style={{ padding: "24px 16px", textAlign: "center" }}>
      {icon && <div style={{ fontSize: 32, marginBottom: 8 }}>{icon}</div>}
      {title && (
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, color: "var(--text)" }}>
          {title}
        </div>
      )}
      {text && (
        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: ctaTo ? 14 : 0 }}>
          {text}
        </div>
      )}
      {ctaTo && (
        <Link
          to={ctaTo}
          className="btn btn-ghost btn-sm"
          style={{ color: "var(--gold)" }}
        >
          {ctaLabel}
        </Link>
      )}
    </div>
  );
}
