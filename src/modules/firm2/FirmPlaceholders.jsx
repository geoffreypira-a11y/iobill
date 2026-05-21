import React from "react";
import { Link, Navigate } from "react-router-dom";
import { useMyFirm } from "../../components/FirmMode.jsx";

/**
 * Pages placeholder pour les Sprints 2-7 du Mode Comptable.
 * Toutes protégées : un user qui n'est pas firm_member est redirigé.
 */

function useGuardedFirm(token, user, company) {
  const { loading, firm } = useMyFirm(token, user?.id);
  if (loading) return { loading: true, firm: null, redirect: null };
  if (!firm) {
    // Pas firm_member : si company existe → Pro, redirige vers /. Sinon onboarding cabinet.
    return {
      loading: false,
      firm: null,
      redirect: company ? "/" : "/firm"
    };
  }
  return { loading: false, firm, redirect: null };
}

export function FirmClientsListPage({ token, user, company }) {
  const { loading, firm, redirect } = useGuardedFirm(token, user, company);
  if (loading) return null;
  if (redirect) return <Navigate to={redirect} replace />;
  return <PlaceholderPage firm={firm} title="Mes clients" sprint="2"
    description="Liste complète, recherche, filtres, ajout/retrait de clients du cabinet." />;
}

export function FirmClientFichePage({ token, user, company }) {
  const { loading, firm, redirect } = useGuardedFirm(token, user, company);
  if (loading) return null;
  if (redirect) return <Navigate to={redirect} replace />;
  return <PlaceholderPage firm={firm} title="Vue client" sprint="3"
    description="Vue lecture seule du compte client avec bandeau, anomalies IA, signalements." />;
}

export function FirmInviteClientPage({ token, user, company }) {
  const { loading, firm, redirect } = useGuardedFirm(token, user, company);
  if (loading) return null;
  if (redirect) return <Navigate to={redirect} replace />;
  return <PlaceholderPage firm={firm} title="Inviter un client" sprint="2"
    description="Formulaire d'invitation par email avec génération de lien et préfilling du compte." />;
}

export function FirmMarathonPage({ token, user, company }) {
  const { loading, firm, redirect } = useGuardedFirm(token, user, company);
  if (loading) return null;
  if (redirect) return <Navigate to={redirect} replace />;
  return <PlaceholderPage firm={firm} title="Mode Marathon" sprint="5"
    description="Validation en série des factures de tous vos clients avec raccourcis clavier." />;
}

export function FirmMessagesPage({ token, user, company }) {
  const { loading, firm, redirect } = useGuardedFirm(token, user, company);
  if (loading) return null;
  if (redirect) return <Navigate to={redirect} replace />;
  return <PlaceholderPage firm={firm} title="Messages" sprint="4"
    description="Messagerie cabinet ↔ clients avec notifications temps réel." />;
}

export function FirmSettingsPage({ token, user, company }) {
  const { loading, firm, redirect } = useGuardedFirm(token, user, company);
  if (loading) return null;
  if (redirect) return <Navigate to={redirect} replace />;
  return <PlaceholderPage firm={firm} title="Réglages cabinet" sprint="7"
    description="Infos cabinet, membres, branding, paramètres notifications." />;
}

function PlaceholderPage({ firm, title, sprint, description }) {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">{title.toUpperCase()}</div>
          <div className="page-sub">{firm?.name || "Cabinet"} · Sprint {sprint}</div>
        </div>
      </div>

      <div className="card card-pad" style={{
        textAlign: "center",
        padding: "40px 20px",
        
      }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🚧</div>
        <h2 style={{
          fontFamily: "Syne, sans-serif",
          fontSize: 18,
          margin: "0 0 10px 0",
          color: "var(--gold)"
        }}>
          En cours de développement
        </h2>
        <p style={{
          fontSize: 13,
          color: "var(--muted2)",
          maxWidth: 480,
          margin: "0 auto 18px",
          lineHeight: 1.6
        }}>
          {description}
        </p>
        <span className="badge badge-gold" style={{ marginBottom: 20 }}>
          Disponible au Sprint {sprint}
        </span>
        <div style={{ marginTop: 20 }}>
          <Link to="/firm" className="btn btn-ghost btn-sm" style={{ color: "var(--gold)" }}>
            ← Retour au Dashboard Cabinet
          </Link>
        </div>
      </div>
    </div>
  );
}
