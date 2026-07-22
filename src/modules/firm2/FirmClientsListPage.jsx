import React, { useEffect, useState } from "react";
import { Link, useNavigate, Navigate } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { useMyFirm } from "../../components/FirmMode.jsx";
import { useIsComptableMode } from "../../components/AdminModeToggle.jsx";
import { fmtDate } from "../../lib/helpers.js";

/**
 * FirmClientsListPage — Sprint 2 v8.26
 * Liste des clients du cabinet : pending / accepted / refused / revoked
 */
export function FirmClientsListPage({ token, user, company }) {
  const isComptableMode = useIsComptableMode(!!company?.is_admin);
  const { loading, firm } = useMyFirm(token, user?.id);

  if (loading) return <div style={loadingStyle}>Chargement...</div>;

  // Admin preview en mode comptable : firm fictif
  const effectiveFirm = firm || (isComptableMode ? { id: "__admin_preview__", name: "Mode Comptable (aperçu admin)" } : null);

  if (!effectiveFirm) {
    return <Navigate to={company ? "/" : "/firm"} replace />;
  }

  return <ClientsList token={token} firm={effectiveFirm} isPreview={effectiveFirm.id === "__admin_preview__"} />;
}

function ClientsList({ token, firm, isPreview }) {
  const navigate = useNavigate();
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("accepted"); // all | pending | accepted — défaut Actifs

  async function load() {
    if (isPreview) {
      setLinks([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const rows = await sb.select(token, "firm_client_links", {
      filter: `firm_id=eq.${firm.id}`,
      select: "id,company_id,invited_email,invited_siret,status,initiated_by,created_at,accepted_at,refused_at,message_invite",
      order: "created_at.desc",
      limit: 100
    });
    // Hydrater avec les noms + SIRET de companies
    const out = [];
    for (const l of (rows || [])) {
      let companyName = null;
      let companySiret = null;
      if (l.company_id) {
        const c = await sb.selectOne(token, "companies", `id=eq.${l.company_id}`, "legal_name,siret");
        companyName = c?.legal_name;
        companySiret = c?.siret;
      }
      out.push({ ...l, _company_name: companyName, _company_siret: companySiret });
    }
    setLinks(out);
    setLoading(false);
  }

  useEffect(() => { load(); }, [firm?.id]);

  async function callAction(linkId, action, confirmMsg) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    const r = await fetch("/api/firm-invitation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, payload: { link_id: linkId } })
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      alert(d.error || `Échec ${action}`);
      return;
    }
    load();
  }

  async function revoke(linkId) {
    await callAction(linkId, "revoke", "Révoquer cette invitation / rompre la liaison ?");
  }
  // v8.48.33 — accept/refuse pour les invitations initiées côté client
  async function accept(linkId) {
    await callAction(linkId, "accept", "Accepter cette demande client ?");
  }
  async function refuse(linkId) {
    await callAction(linkId, "refuse", "Refuser cette demande client ?");
  }

  const filtered = links.filter((l) => filter === "all" || l.status === filter);
  const pendingCount = links.filter((l) => l.status === "pending").length;
  const acceptedCount = links.filter((l) => l.status === "accepted").length;

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "20px 24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 16 }}>
        <div>
          <h1 style={{ fontFamily: "Syne, sans-serif", fontSize: 32, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>
            MES CLIENTS
          </h1>
          <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>
            {firm.name} · {acceptedCount} actif{acceptedCount > 1 ? "s" : ""} {pendingCount > 0 && `· ${pendingCount} en attente`}
          </div>
        </div>
        {!isPreview && (
          <button className="btn btn-primary" onClick={() => navigate("/firm/clients/new")}>
            + Inviter un client
          </button>
        )}
      </div>

      {isPreview && (
        <div className="card card-pad" style={{ marginBottom: 16, background: "rgba(212,168,67,0.08)", borderColor: "rgba(212,168,67,0.3)" }}>
          <div style={{ fontSize: 12, color: "var(--gold)" }}>
            📋 Mode aperçu admin — Inscription depuis un vrai compte cabinet pour gérer des clients.
          </div>
        </div>
      )}

      {/* Filtres */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {[
          { key: "all", label: `Tous (${links.length})` },
          { key: "pending", label: `⏳ En attente (${pendingCount})` },
          { key: "accepted", label: `✅ Actifs (${acceptedCount})` },
          { key: "refused", label: "❌ Refusés" },
          { key: "revoked", label: "🚫 Révoqués" }
        ].map((f) => (
          <button
            key={f.key}
            className={"btn btn-sm " + (filter === f.key ? "btn-gold" : "btn-ghost")}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="card card-pad" style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>
          Chargement...
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState filter={filter} onInvite={() => navigate("/firm/clients/new")} isPreview={isPreview} />
      ) : (
        filtered.map((l) => (
          <ClientLinkCard
            key={l.id}
            link={l}
            onRevoke={() => revoke(l.id)}
            onAccept={() => accept(l.id)}
            onRefuse={() => refuse(l.id)}
          />
        ))
      )}
    </div>
  );
}

function ClientLinkCard({ link, onRevoke, onAccept, onRefuse }) {
  const statusBadge = STATUS_BADGES[link.status] || STATUS_BADGES.pending;
  const initiatedLabel = link.initiated_by === "firm" ? "Invité par le cabinet" : "Initié par le client";
  // v8.48.33 — Quand c'est le CLIENT qui a initié, le cabinet doit pouvoir
  // accepter ou refuser. Avant on n'avait que Annuler ce qui bloquait le flow.
  const needsCabinetAction = link.status === "pending" && link.initiated_by === "client";

  return (
    <div className="card" style={{ marginBottom: 10, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>
              {link._company_name || link.invited_email || "Client sans nom"}
            </span>
            <span className={`badge ${statusBadge.cls}`}>{statusBadge.label}</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>
            {link._company_siret ? `SIRET ${link._company_siret} · ` : ""}
            {link.invited_email} · {initiatedLabel}
          </div>
          {link.message_invite && link.status === "pending" && (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted2)", fontStyle: "italic", padding: "6px 10px", background: "rgba(255,255,255,0.03)", borderRadius: 4 }}>
              «{link.message_invite}»
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <div style={{ fontSize: 10, color: "var(--muted)" }}>
            {link.status === "accepted" ? `Lié le ${fmtDate(link.accepted_at)}` 
              : link.status === "refused" ? `Refusé le ${fmtDate(link.refused_at)}`
              : `Invité le ${fmtDate(link.created_at)}`}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {link.status === "accepted" && (
              <Link to={`/firm/clients/${link.id}`} className="btn btn-ghost btn-sm">
                Ouvrir →
              </Link>
            )}
            {needsCabinetAction && (
              <>
                <button className="btn btn-primary btn-sm" onClick={onAccept}>
                  ✅ Accepter
                </button>
                <button className="btn btn-ghost btn-sm" onClick={onRefuse}>
                  ❌ Refuser
                </button>
              </>
            )}
            {(link.status === "pending" || link.status === "accepted") && (
              <button className="btn btn-ghost btn-sm" onClick={onRevoke}>
                {link.status === "pending" ? (needsCabinetAction ? "Ignorer" : "Annuler") : "Rompre"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ filter, onInvite, isPreview }) {
  if (filter !== "all") {
    return (
      <div className="card card-pad" style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>
        Aucun client dans ce filtre.
      </div>
    );
  }
  return (
    <div className="card card-pad" style={{ textAlign: "center", padding: 60 }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>👥</div>
      <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>Aucun client pour l'instant</div>
      <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 20 }}>
        {isPreview ? "L'aperçu admin n'a pas de vrais clients rattachés." : "Invitez votre premier client pour démarrer."}
      </div>
      {!isPreview && (
        <button className="btn btn-primary" onClick={onInvite}>+ Inviter un client</button>
      )}
    </div>
  );
}

const STATUS_BADGES = {
  pending: { label: "⏳ En attente", cls: "badge-orange" },
  accepted: { label: "✅ Actif", cls: "badge-green" },
  refused: { label: "❌ Refusé", cls: "badge-red" },
  revoked: { label: "🚫 Révoqué", cls: "badge-muted" }
};

const loadingStyle = { minHeight: 400, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 13 };
