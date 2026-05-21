import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { sb } from "../lib/supabase.js";

/**
 * SignalsClientBanner — v8.27.3
 * Bandeau dashboard côté abonné Pro : affiche les signalements ouverts du cabinet
 */
export function SignalsClientBanner({ token, company }) {
  const [signals, setSignals] = useState([]);

  async function load() {
    if (!company?.id) return;
    const rows = await sb.select(token, "firm_signals", {
      filter: `company_id=eq.${company.id}&status=eq.open&visible_to_client=eq.true`,
      select: "id,severity,title,target_type,target_id,created_at,firm_id",
      order: "created_at.desc",
      limit: 5
    });
    const out = [];
    for (const s of (rows || [])) {
      const firm = await sb.selectOne(token, "accounting_firms", `id=eq.${s.firm_id}`, "name");
      out.push({ ...s, _firmName: firm?.name });
    }
    setSignals(out);
  }

  useEffect(() => { load(); }, [company?.id]);

  if (signals.length === 0) return null;

  const hasCritical = signals.some((s) => s.severity === "critical");
  const colorVar = hasCritical ? "#e54949" : "#e5973c"; // rouge ou orange

  return (
    <div className="card" style={{
      padding: 14,
      marginBottom: 16,
      background: hasCritical ? "rgba(229,73,73,0.08)" : "rgba(229,151,60,0.08)",
      border: `1px solid ${colorVar}55`
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: colorVar, marginBottom: 4 }}>
            🚩 {signals.length === 1 
              ? "Votre cabinet a signalé une anomalie" 
              : `${signals.length} signalements de votre cabinet`}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted2)" }}>
            {signals[0]._firmName} — «{signals[0].title}»{signals.length > 1 ? ` et ${signals.length - 1} autre${signals.length > 2 ? "s" : ""}` : ""}
          </div>
        </div>
        <Link to="/signals" className="btn btn-sm" style={{ background: colorVar, color: "#fff", textDecoration: "none" }}>
          Voir →
        </Link>
      </div>
    </div>
  );
}
