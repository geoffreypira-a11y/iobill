import React, { useState, useEffect, useRef } from "react";
import { sb } from "../lib/supabase.js";
import { setActiveCompanyId } from "../lib/session.js";
import { Icon } from "./Icon.jsx";
import { initials } from "../lib/helpers.js";

/**
 * CompanySwitcher — Selecteur de company active.
 * Visible uniquement si l'utilisateur est membre de plusieurs companies.
 * Click → liste deroulante avec recherche; selection → reload pour changer le contexte
 * (rechargement complet pour s'assurer que toutes les requetes RLS pointent vers la nouvelle company).
 */
export function CompanySwitcher({ token, user, currentCompany }) {
  const [companies, setCompanies] = useState([]);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      // Recuperer toutes les companies dont le user est membre (accepted)
      const memberships = await sb.select(token, "company_users", {
        filter: `user_id=eq.${user.id}&accepted_at=not.is.null`,
        select: "company_id,role"
      });
      if (!alive || !memberships || memberships.length === 0) {
        // Fallback : peut-etre user_id sur companies (V1)
        const fallback = await sb.select(token, "companies", {
          filter: `user_id=eq.${user.id}`,
          select: "id,legal_name,trade_name"
        });
        setCompanies(fallback || []);
        return;
      }
      // Charger les details des companies
      const ids = memberships.map((m) => m.company_id).filter(Boolean);
      if (ids.length === 0) return;
      const cos = await sb.select(token, "companies", {
        filter: `id=in.(${ids.join(",")})`,
        select: "id,legal_name,trade_name"
      });
      if (!alive) return;

      const enriched = (cos || []).map((c) => {
        const m = memberships.find((mm) => mm.company_id === c.id);
        return { ...c, role: m?.role };
      });
      setCompanies(enriched);
    })();
    return () => { alive = false; };
  }, [token, user.id]);

  // Click outside
  useEffect(() => {
    function onClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  function switchTo(companyId) {
    if (companyId === currentCompany?.id) { setOpen(false); return; }
    setActiveCompanyId(companyId);
    // Reload complet pour reinit toutes les requetes
    window.location.href = "/";
  }

  // Si une seule company, on n'affiche pas le selecteur
  if (companies.length <= 1) {
    return null;
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Changer de société"
        style={{
          display: "flex", alignItems: "center", gap: 8,
          background: open ? "var(--card2)" : "transparent",
          border: "1px solid var(--border2)", borderRadius: 8,
          padding: "6px 10px", cursor: "pointer", color: "var(--text)",
          fontSize: 12, width: "100%", textAlign: "left",
          transition: "background 0.15s"
        }}
      >
        <div style={{
          width: 24, height: 24, borderRadius: 6, background: "var(--gold)", color: "#0b0c10",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontWeight: 700, fontSize: 10, flexShrink: 0
        }}>
          {initials(currentCompany?.legal_name || currentCompany?.trade_name)}
        </div>
        <div style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {currentCompany?.trade_name || currentCompany?.legal_name || "—"}
        </div>
        <span style={{ color: "var(--muted)", fontSize: 10, transform: open ? "rotate(180deg)" : "none" }}>▼</span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0,
            background: "var(--card)", border: "1px solid var(--border2)", borderRadius: 8,
            zIndex: 100, maxHeight: 320, overflow: "auto",
            boxShadow: "0 12px 32px rgba(0,0,0,0.5)"
          }}
        >
          <div style={{ padding: "8px 12px", fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--muted)", borderBottom: "1px solid var(--border)" }}>
            Mes sociétés ({companies.length})
          </div>
          {companies.map((c) => {
            const active = c.id === currentCompany?.id;
            return (
              <button
                key={c.id}
                onClick={() => switchTo(c.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 8, width: "100%",
                  background: active ? "rgba(212, 168, 67, 0.08)" : "transparent",
                  border: "none", padding: "10px 12px", cursor: "pointer",
                  textAlign: "left", color: "var(--text)", fontSize: 12,
                  borderBottom: "1px solid var(--border)"
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--card2)"; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
              >
                <div style={{
                  width: 22, height: 22, borderRadius: 5,
                  background: active ? "var(--gold)" : "var(--card2)",
                  color: active ? "#0b0c10" : "var(--muted2)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontWeight: 700, fontSize: 9, flexShrink: 0
                }}>
                  {initials(c.legal_name || c.trade_name)}
                </div>
                <div style={{ flex: 1, overflow: "hidden" }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: active ? 600 : 400 }}>
                    {c.trade_name || c.legal_name}
                  </div>
                  {c.role && (
                    <div style={{ fontSize: 9, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1 }}>
                      {c.role}
                    </div>
                  )}
                </div>
                {active && <span style={{ color: "var(--gold)", fontSize: 12 }}>✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
