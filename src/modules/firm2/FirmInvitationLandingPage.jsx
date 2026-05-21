import React, { useEffect, useState } from "react";
import { useNavigate, useLocation, Link } from "react-router-dom";
import { sb } from "../../lib/supabase.js";

/**
 * FirmInvitationLandingPage — v8.26.3
 * Page d'arrivée quand le client clique "Voir l'invitation" depuis l'email.
 * URL : /firm-invitation?token=XXX
 *
 * Si pas connecté → on redirige vers login en gardant le token en mémoire
 * Si connecté → on cherche l'invitation, on affiche les détails, on permet accept/refuse
 */
export function FirmInvitationLandingPage({ session }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [invitation, setInvitation] = useState(null);
  const [firm, setFirm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null); // "accepted" | "refused"

  const token = new URLSearchParams(location.search).get("token");

  useEffect(() => {
    if (!token) {
      setError("Token manquant dans le lien d'invitation.");
      setLoading(false);
      return;
    }

    // Si pas connecté, on garde le token en localStorage et on redirige vers login
    if (!session?.token) {
      localStorage.setItem("pending_firm_invitation_token", token);
      navigate("/auth?redirect=" + encodeURIComponent("/firm-invitation?token=" + token));
      return;
    }

    // Connecté : on cherche l'invitation par token
    (async () => {
      const links = await sb.select(session.token, "firm_client_links", {
        filter: `invitation_token=eq.${token}`,
        select: "id,firm_id,company_id,invited_email,status,message_invite,initiated_by,created_at",
        limit: 1
      });
      if (!links || links.length === 0) {
        setError("Invitation introuvable ou déjà traitée. Le lien a peut-être expiré.");
        setLoading(false);
        return;
      }
      const inv = links[0];
      setInvitation(inv);
      const f = await sb.selectOne(session.token, "accounting_firms", `id=eq.${inv.firm_id}`, "name,email,siret");
      setFirm(f);
      setLoading(false);
    })();
  }, [token, session?.token]);

  async function handleAction(action) {
    if (!invitation) return;
    setActionLoading(true);
    setError(null);
    const r = await fetch("/api/firm-invitation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ action, payload: { link_id: invitation.id } })
    });
    const data = await r.json();
    setActionLoading(false);
    if (!r.ok) {
      setError(data.error || "Échec de l'action");
      return;
    }
    setDone(action === "accept" ? "accepted" : "refused");
    localStorage.removeItem("pending_firm_invitation_token");
  }

  if (loading) {
    return (
      <div style={pageStyle}>
        <div style={{ textAlign: "center", color: "var(--muted)", padding: 40 }}>Chargement de l'invitation...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={pageStyle}>
        <div className="card card-pad" style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>⚠️</div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Erreur</div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 20 }}>{error}</div>
          <Link to="/" className="btn btn-primary">Retour au tableau de bord</Link>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div style={pageStyle}>
        <div className="card card-pad" style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>{done === "accepted" ? "✅" : "❌"}</div>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
            {done === "accepted" ? "Invitation acceptée" : "Invitation refusée"}
          </div>
          <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 20 }}>
            {done === "accepted"
              ? `Le cabinet ${firm?.name} peut désormais consulter votre comptabilité.`
              : "L'invitation a été refusée."}
          </div>
          <Link to="/settings/firm-link" className="btn btn-primary">Voir mes cabinets</Link>
        </div>
      </div>
    );
  }

  if (invitation.status !== "pending") {
    const labels = {
      accepted: { icon: "✅", label: "Invitation déjà acceptée" },
      refused: { icon: "❌", label: "Invitation refusée" },
      revoked: { icon: "🚫", label: "Invitation révoquée" }
    };
    const l = labels[invitation.status] || { icon: "ℹ️", label: "Statut : " + invitation.status };
    return (
      <div style={pageStyle}>
        <div className="card card-pad" style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>{l.icon}</div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 20 }}>{l.label}</div>
          <Link to="/settings/firm-link" className="btn btn-primary">Voir mes cabinets</Link>
        </div>
      </div>
    );
  }

  // Status pending → on affiche la fiche + les boutons accept/refuse
  return (
    <div style={pageStyle}>
      <div className="card card-pad" style={{ padding: 32 }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🦉</div>
          <h1 style={{ fontFamily: "Syne, sans-serif", fontSize: 26, fontWeight: 700, margin: "0 0 8px 0", letterSpacing: "-0.02em" }}>
            INVITATION CABINET
          </h1>
          <div style={{ fontSize: 13, color: "var(--muted)" }}>
            Le cabinet comptable suivant souhaite gérer votre comptabilité :
          </div>
        </div>

        <div style={{ background: "rgba(212,168,67,0.08)", border: "1px solid rgba(212,168,67,0.3)", borderRadius: 8, padding: 20, marginBottom: 24 }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: "var(--gold)", marginBottom: 6 }}>
            {firm?.name || "Cabinet"}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            SIRET {firm?.siret} · {firm?.email}
          </div>
        </div>

        {invitation.message_invite && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: "var(--muted)", marginBottom: 8 }}>
              Message du cabinet
            </div>
            <div style={{ fontSize: 13, fontStyle: "italic", color: "var(--text)", padding: "12px 16px", background: "rgba(255,255,255,0.03)", borderRadius: 6, borderLeft: "3px solid var(--gold)" }}>
              «{invitation.message_invite}»
            </div>
          </div>
        )}

        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 1, color: "var(--muted)", marginBottom: 8 }}>
            Ce que ce cabinet pourra faire
          </div>
          <ul style={{ fontSize: 13, color: "var(--text)", paddingLeft: 20, margin: 0, lineHeight: 1.7 }}>
            <li>Consulter vos factures et achats (lecture seule)</li>
            <li>Signaler des anomalies ou demandes de correction</li>
            <li>Échanger avec vous via une messagerie sécurisée</li>
          </ul>
          <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 12 }}>
            Vos données restent privées tant que vous n'avez pas validé. Vous pouvez révoquer l'accès à tout moment.
          </div>
        </div>

        {error && (
          <div className="alert-danger" style={{ marginBottom: 16, fontSize: 13 }}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          <button className="btn btn-ghost" onClick={() => handleAction("refuse")} disabled={actionLoading}>
            Refuser
          </button>
          <button className="btn btn-primary" onClick={() => handleAction("accept")} disabled={actionLoading}>
            {actionLoading ? "..." : "✅ Accepter l'invitation"}
          </button>
        </div>
      </div>
    </div>
  );
}

const pageStyle = { maxWidth: 640, margin: "40px auto", padding: "20px 24px" };
