import React, { useEffect, useState } from "react";
import { useNavigate, Navigate } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { useMyFirm } from "../../components/FirmMode.jsx";
import { useIsComptableMode } from "../../components/AdminModeToggle.jsx";
import { fmtDate } from "../../lib/helpers.js";

/**
 * FirmAnomaliesPage — v8.27 Sprint 3
 * Vue globale de tous les signalements ouverts du cabinet (multi-clients)
 */
export function FirmAnomaliesPage({ token, user, company }) {
  const navigate = useNavigate();
  const isComptableMode = useIsComptableMode(!!company?.is_admin);
  const { loading: firmLoading, firm } = useMyFirm(token, user?.id);
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("open");
  const [companies, setCompanies] = useState({});

  async function load() {
    if (!firm?.id) { setLoading(false); return; }
    setLoading(true);

    const rows = await sb.select(token, "firm_signals", {
      filter: `firm_id=eq.${firm.id}`,
      select: "*",
      order: "created_at.desc",
      limit: 200
    });

    // Hydrater avec noms de companies
    const companyIds = [...new Set((rows || []).map((s) => s.company_id))];
    const cmap = {};
    for (const cid of companyIds) {
      const c = await sb.selectOne(token, "companies", `id=eq.${cid}`, "id,legal_name");
      if (c) cmap[cid] = c;
    }

    // Hydrater avec link_id (pour navigation)
    const links = await sb.select(token, "firm_client_links", {
      filter: `firm_id=eq.${firm.id}&status=eq.accepted`,
      select: "id,company_id"
    });
    const linkMap = {};
    for (const l of (links || [])) linkMap[l.company_id] = l.id;

    setCompanies(cmap);
    setSignals((rows || []).map((s) => ({ ...s, _company: cmap[s.company_id], _link_id: linkMap[s.company_id] })));
    setLoading(false);
  }

  useEffect(() => { load(); }, [firm?.id]);

  if (firmLoading || loading) return <div style={loadingStyle}>Chargement...</div>;
  if (!firm && !isComptableMode) return <Navigate to="/firm" replace />;

  const effectiveFirm = firm || { id: "__preview__", name: "Mode aperçu" };
  if (effectiveFirm.id === "__preview__") {
    return (
      <div style={pageStyle}>
        <h1 style={titleStyle}>SIGNALEMENTS</h1>
        <div className="card card-pad" style={{ textAlign: "center", padding: 40 }}>
          📋 Mode aperçu admin — Aucun cabinet réel
        </div>
      </div>
    );
  }

  const filtered = signals.filter((s) => filter === "all" || s.status === filter);
  const counts = {
    open: signals.filter((s) => s.status === "open").length,
    resolved: signals.filter((s) => s.status === "resolved").length,
    dismissed: signals.filter((s) => s.status === "dismissed").length
  };

  return (
    <div style={pageStyle}>
      <h1 style={titleStyle}>SIGNALEMENTS</h1>
      <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 24 }}>
        {firm.name} · {counts.open} ouvert{counts.open > 1 ? "s" : ""} sur l'ensemble de vos clients
      </div>

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
        <div className="card card-pad" style={{ textAlign: "center", padding: 60, color: "var(--muted)" }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>{filter === "open" ? "✨" : "—"}</div>
          <div style={{ fontSize: 14 }}>
            {filter === "open" ? "Aucune anomalie ouverte. Tout est propre." : "Aucun signalement dans ce filtre."}
          </div>
        </div>
      ) : (
        filtered.map((s) => (
          <div key={s.id} className="card" style={{ padding: 14, marginBottom: 8, cursor: "pointer" }} onClick={() => s._link_id && navigate(`/firm/clients/${s._link_id}`)}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                  <span>{SEV_EMOJI[s.severity]}</span>
                  <strong style={{ fontSize: 14 }}>{s.title}</strong>
                  <StatusBadgeSignal status={s.status} />
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>
                  <strong>{s._company?.legal_name || "Client inconnu"}</strong> · {s.target_type} · Créé le {fmtDate(s.created_at)}
                </div>
                {s.content && (
                  <div style={{ marginTop: 6, fontSize: 12, color: "var(--muted2)", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                    {s.content}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
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

const SEV_EMOJI = { info: "🟦", warning: "🟧", critical: "🟥" };
const pageStyle = { maxWidth: 1000, margin: "0 auto", padding: "20px 24px" };
const titleStyle = { fontFamily: "Syne, sans-serif", fontSize: 32, fontWeight: 700, margin: "0 0 8px 0", letterSpacing: "-0.02em" };
const loadingStyle = { minHeight: 400, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 13 };
