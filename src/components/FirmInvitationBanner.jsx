import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { sb } from "../lib/supabase.js";

/**
 * FirmInvitationBanner — v8.26.4
 * 
 * Affiche les invitations cabinet pending pour l'abonné connecté.
 * 
 * Stratégie de recherche (cumulative) :
 *   1. Toutes les invitations où invited_email = user.email
 *   2. Toutes les invitations sur company_id de l'user
 * 
 * Indépendant de la "company active" du contexte UI.
 */
export function FirmInvitationBanner({ token, user, company }) {
  const [pending, setPending] = useState([]);

  async function load() {
    if (!token || !user?.email) return;

    // 1) Par email (le plus fiable)
    const byEmail = await sb.select(token, "firm_client_links", {
      filter: `invited_email=eq.${encodeURIComponent(user.email)}&status=eq.pending&initiated_by=eq.firm`,
      select: "id,firm_id,message_invite,created_at,company_id",
      order: "created_at.desc",
      limit: 10
    }) || [];

    // 2) Par company (au cas où le user a plusieurs companies)
    let byCompany = [];
    if (company?.id) {
      byCompany = await sb.select(token, "firm_client_links", {
        filter: `company_id=eq.${company.id}&status=eq.pending&initiated_by=eq.firm`,
        select: "id,firm_id,message_invite,created_at,company_id",
        order: "created_at.desc",
        limit: 10
      }) || [];
    }

    // Union dédupliquée par id
    const map = new Map();
    for (const l of [...byEmail, ...byCompany]) map.set(l.id, l);
    const merged = Array.from(map.values());

    // Hydrater avec nom du cabinet
    const out = [];
    for (const l of merged) {
      const firm = await sb.selectOne(token, "accounting_firms", `id=eq.${l.firm_id}`, "name,email");
      out.push({ ...l, _firm: firm });
    }
    setPending(out);
  }

  useEffect(() => { load(); }, [token, user?.email, company?.id]);

  if (pending.length === 0) return null;

  return (
    <div className="card" style={{
      padding: 14,
      marginBottom: 16,
      background: "rgba(212,168,67,0.08)",
      border: "1px solid rgba(212,168,67,0.3)"
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--gold)", marginBottom: 4 }}>
            🔔 {pending.length === 1 
              ? "Un cabinet comptable souhaite gérer votre compte" 
              : `${pending.length} cabinets souhaitent gérer votre compte`}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted2)" }}>
            {pending[0]._firm?.name}{pending.length > 1 ? ` et ${pending.length - 1} autre${pending.length > 2 ? "s" : ""}` : ""}
          </div>
        </div>
        <Link to="/settings/firm-link" className="btn btn-gold btn-sm">
          Voir →
        </Link>
      </div>
    </div>
  );
}
