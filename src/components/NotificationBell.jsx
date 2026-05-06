import React, { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { sb } from "../lib/supabase.js";
import { fmtDate } from "../lib/helpers.js";

/**
 * NotificationBell — badge cloche dans la sidebar.
 * Agrege en lecture seule (poll toutes les 60s) :
 *  - invitations en attente (firm_clients accepted_at NULL)
 *  - paiements recents (payments dans les 24h)
 *  - factures qui viennent de passer overdue
 *  - SMS envoyes recents
 */
export function NotificationBell({ token, company, user }) {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    let alive = true;
    let timer = null;

    async function load() {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();

      const [pendingFirmInvites, recentPayments, newOverdue, recentSms] = await Promise.all([
        // Invitations cabinet en attente que l'utilisateur peut accepter
        sb.select(token, "firm_clients", {
          filter: `company_id=eq.${company.id}&accepted_at=is.null&revoked_at=is.null`,
          select: "id,firm_id,invited_at,access_level",
          limit: 10
        }),
        // Paiements recus dans les dernieres 24h
        sb.select(token, "payments", {
          filter: `company_id=eq.${company.id}&paid_at=gte.${yesterday}`,
          select: "id,invoice_id,amount_cents,method,paid_at",
          order: "paid_at.desc",
          limit: 5
        }),
        // Factures qui viennent de passer overdue (status overdue + last_reminder dans les 24h)
        sb.select(token, "invoices", {
          filter: `company_id=eq.${company.id}&status=eq.overdue&last_reminder_sent_at=gte.${yesterday}`,
          select: "id,number,total_ttc_cents,paid_cents,client_snapshot",
          limit: 5
        }),
        // SMS envoyes
        sb.select(token, "sms_log", {
          filter: `company_id=eq.${company.id}&sent_at=gte.${yesterday}&status=eq.sent`,
          select: "id,recipient_phone,sent_at",
          limit: 3
        }).catch(() => [])
      ]);

      if (!alive) return;

      const aggregated = [];
      (pendingFirmInvites || []).forEach((inv) => {
        aggregated.push({
          id: "firminv-" + inv.id,
          icon: "🏛️",
          title: "Demande de supervision cabinet",
          body: `Un cabinet souhaite accéder à vos dossiers (${inv.access_level === "editor" ? "édition" : "lecture"})`,
          time: inv.invited_at,
          url: `/firm-invite/${inv.id}`,
          severity: "gold"
        });
      });
      (recentPayments || []).forEach((p) => {
        aggregated.push({
          id: "pay-" + p.id,
          icon: "💰",
          title: "Paiement reçu",
          body: `${(p.amount_cents / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" })} via ${p.method || "—"}`,
          time: p.paid_at,
          url: p.invoice_id ? `/invoices/${p.invoice_id}` : null,
          severity: "green"
        });
      });
      (newOverdue || []).forEach((inv) => {
        const remaining = (inv.total_ttc_cents || 0) - (inv.paid_cents || 0);
        const cs = inv.client_snapshot;
        const name = cs?.legal_name || `${cs?.first_name || ""} ${cs?.last_name || ""}`.trim() || "Client";
        aggregated.push({
          id: "overdue-" + inv.id,
          icon: "⚠️",
          title: `Facture ${inv.number} en retard`,
          body: `${name} · ${(remaining / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" })} dû`,
          time: null,
          url: `/invoices/${inv.id}`,
          severity: "red"
        });
      });
      (recentSms || []).forEach((s) => {
        aggregated.push({
          id: "sms-" + s.id,
          icon: "📱",
          title: "SMS de relance envoyé",
          body: s.recipient_phone,
          time: s.sent_at,
          url: null,
          severity: "muted"
        });
      });

      // Tri par date desc
      aggregated.sort((a, b) => {
        if (!a.time) return -1;
        if (!b.time) return 1;
        return new Date(b.time) - new Date(a.time);
      });
      setItems(aggregated);
    }

    load();
    timer = setInterval(load, 60000);

    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [token, company.id]);

  // Click outside
  useEffect(() => {
    function onClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const count = items.length;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Notifications"
        style={{
          position: "relative", background: "transparent", border: "1px solid var(--border2)",
          borderRadius: "50%", width: 36, height: 36, cursor: "pointer", color: "var(--text)",
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16,
          transition: "background 0.15s"
        }}
        onMouseEnter={(e) => e.currentTarget.style.background = "var(--card2)"}
        onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
      >
        🔔
        {count > 0 && (
          <span style={{
            position: "absolute", top: -2, right: -2,
            background: "var(--red)", color: "#fff",
            fontSize: 9, fontWeight: 700,
            minWidth: 16, height: 16, borderRadius: 8,
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: "0 4px",
            border: "2px solid var(--bg)"
          }}>
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0,
            background: "var(--card)", border: "1px solid var(--border2)", borderRadius: 8,
            zIndex: 100, width: 340, maxHeight: 460, overflow: "auto",
            boxShadow: "0 12px 32px rgba(0,0,0,0.5)"
          }}
        >
          <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--muted)", fontWeight: 600 }}>
              Notifications
            </div>
            <div style={{ fontSize: 10, color: "var(--muted)" }}>{count} récentes</div>
          </div>
          {count === 0 ? (
            <div style={{ padding: 30, textAlign: "center", color: "var(--muted)" }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>✨</div>
              <div style={{ fontSize: 12 }}>Tout est à jour</div>
            </div>
          ) : (
            items.map((it) => {
              const colorMap = { gold: "var(--gold)", green: "var(--green)", red: "var(--red)", muted: "var(--muted)" };
              const Inner = (
                <div style={{
                  padding: "12px 14px", borderBottom: "1px solid var(--border)",
                  display: "flex", gap: 10, alignItems: "flex-start", cursor: it.url ? "pointer" : "default",
                  transition: "background 0.15s"
                }}
                  onMouseEnter={(e) => e.currentTarget.style.background = "var(--card2)"}
                  onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                >
                  <div style={{ fontSize: 18, flexShrink: 0, marginTop: -2 }}>{it.icon}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 500, color: colorMap[it.severity] || "var(--text)", marginBottom: 2 }}>
                      {it.title}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted2)", lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {it.body}
                    </div>
                    {it.time && (
                      <div style={{ fontSize: 9, color: "var(--muted)", marginTop: 4 }}>
                        {fmtRelative(it.time)}
                      </div>
                    )}
                  </div>
                </div>
              );
              return it.url ? (
                <Link key={it.id} to={it.url} onClick={() => setOpen(false)} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
                  {Inner}
                </Link>
              ) : (
                <div key={it.id}>{Inner}</div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function fmtRelative(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "à l'instant";
  if (sec < 3600) return `il y a ${Math.floor(sec / 60)} min`;
  if (sec < 86400) return `il y a ${Math.floor(sec / 3600)} h`;
  return fmtDate(iso);
}
