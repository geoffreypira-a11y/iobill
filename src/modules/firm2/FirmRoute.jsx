import React from "react";
import { Navigate } from "react-router-dom";
import { useMyFirm } from "../../components/FirmMode.jsx";
import { FirmDashboardPage } from "./FirmDashboardPage.jsx";
import { FirmOnboardingPage } from "./FirmOnboardingPage.jsx";

/**
 * FirmRoute — composant racine pour /firm.
 *
 * Règles strictes :
 *   - Abonné Pro (a une company)        → REDIRIGÉ vers / (interdit /firm)
 *   - Pending firm setup (vient d'inscrire en Cabinet) → FirmOnboardingPage
 *   - Comptable déjà membre              → FirmDashboardPage
 *
 * Un abonné ne peut JAMAIS accéder au mode comptable. Les types sont
 * exclusifs (option 3 retenue : comptable = rôle exclusif).
 */
export function FirmRoute({ token, user, company }) {
  const { loading, firm, member } = useMyFirm(token, user?.id);

  if (loading) {
    return (
      <div style={{
        minHeight: 400,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--muted)",
        fontSize: 13
      }}>
        Chargement...
      </div>
    );
  }

  // CAS 1 : Comptable déjà membre → Dashboard cabinet
  if (firm) {
    return <FirmDashboardPage token={token} user={user} firm={firm} member={member} />;
  }

  // CAS 2 : Pending firm setup (vient de s'inscrire en Cabinet et confirmé l'email)
  // → Onboarding pour qu'il crée son cabinet
  let pendingFirm = false;
  try { pendingFirm = localStorage.getItem("iobill_pending_firm_setup") === "1"; } catch {}
  if (pendingFirm) {
    return <FirmOnboardingPage token={token} user={user} />;
  }

  // CAS 3 : Abonné Pro (a une company) → INTERDIT, redirection vers /
  if (company) {
    return <Navigate to="/" replace />;
  }

  // CAS 4 : User sans company ni firm_member ni pending_firm_setup
  // → Edge case (user qui a déconnecté pendant signup ?). On l'envoie sur l'onboarding
  return <FirmOnboardingPage token={token} user={user} />;
}

/**
 * FirmOnboardingRoute — route dédiée /firm/onboarding (accès direct).
 * Idem : interdit aux abonnés Pro.
 */
export function FirmOnboardingRoute({ token, user, company }) {
  const { loading, firm } = useMyFirm(token, user?.id);
  if (loading) return null;
  if (firm) return <Navigate to="/firm" replace />;
  if (company) return <Navigate to="/" replace />;  // abonné Pro : interdit
  return <FirmOnboardingPage token={token} user={user} />;
}
