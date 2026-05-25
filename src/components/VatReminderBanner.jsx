import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { sb } from "../lib/supabase.js";

/**
 * VatReminderBanner — Bandeau orange affiché en haut de l'app
 * quand l'utilisateur a au moins 1 déclaration TVA "ready" (mois fini, à valider).
 *
 * Cliquer dessus → /vat
 *
 * Discret : peut être masqué via un X (mémorisé en sessionStorage).
 */
export function VatReminderBanner({ token, company }) {
  const [pending, setPending] = useState([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!token || !company?.id) return;
    const isDismissed = sessionStorage.getItem(`vat_reminder_dismissed_${company.id}`) === "1";
    if (isDismissed) {
      setDismissed(true);
      return;
    }

    let alive = true;
    (async () => {
      // 1) Auto-bascule : les in_progress dont la période est passée → ready
      const today = new Date().toISOString().slice(0, 10);
      const expired = await sb.select(token, "vat_returns", {
        filter: `company_id=eq.${company.id}&status=eq.in_progress&period_end=lt.${today}`,
        select: "id,period_start,period_end",
        limit: 20
      });
      if (expired && expired.length > 0) {
        await Promise.all(
          expired.map((r) =>
            sb.update(token, "vat_returns", `id=eq.${r.id}`, { status: "ready" })
          )
        );
      }

      // 2) Charger les déclarations à valider (ready) dont la période est passée
      const rs = await sb.select(token, "vat_returns", {
        filter: `company_id=eq.${company.id}&status=eq.ready&period_end=lt.${today}`,
        select: "id,period_start,period_end",
        order: "period_start.desc",
        limit: 10
      });
      if (!alive) return;
      setPending(rs || []);
    })();
    return () => { alive = false; };
  }, [token, company?.id]);

  function handleDismiss(e) {
    e.preventDefault();
    e.stopPropagation();
    sessionStorage.setItem(`vat_reminder_dismissed_${company.id}`, "1");
    setDismissed(true);
  }

  if (dismissed || pending.length === 0) return null;

  return (
    <Link
      to="/vat"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 16px",
        background: "rgba(255, 165, 0, 0.12)",
        borderBottom: "1px solid rgba(255, 165, 0, 0.3)",
        color: "var(--text)",
        textDecoration: "none",
        fontSize: 12
      }}
    >
      <span style={{ fontSize: 16 }}>🔔</span>
      <div style={{ flex: 1 }}>
        <span style={{ color: "var(--orange)", fontWeight: 600 }}>
          {pending.length === 1
            ? "1 déclaration TVA à valider"
            : `${pending.length} déclarations TVA à valider`}
        </span>
        <span style={{ color: "var(--muted2)", marginLeft: 8 }}>
          → cliquez ici pour les voir
        </span>
      </div>
      <button
        onClick={handleDismiss}
        title="Masquer pour cette session"
        style={{
          background: "transparent",
          border: "none",
          color: "var(--muted)",
          cursor: "pointer",
          fontSize: 14,
          padding: "0 4px"
        }}
      >
        ✕
      </button>
    </Link>
  );
}
