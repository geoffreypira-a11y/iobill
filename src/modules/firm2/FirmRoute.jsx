import React from "react";
import { Navigate } from "react-router-dom";
import { useMyFirm } from "../../components/FirmMode.jsx";
import { useIsComptableMode } from "../../components/AdminModeToggle.jsx";
import { FirmDashboardPage } from "./FirmDashboardPage.jsx";
import { FirmOnboardingPage } from "./FirmOnboardingPage.jsx";

/**
 * FirmRoute — composant racine pour /firm.
 *
 * v8.24 : ajout du Mode Comptable admin (aperçu pour tester sans compte séparé).
 *
 * Règles :
 *   - Admin IO BILL en mode comptable → FirmDashboardPage avec firm fictif
 *   - Comptable déjà membre          → FirmDashboardPage normal
 *   - Pending firm setup             → FirmOnboardingPage
 *   - Abonné Pro (a une company)     → REDIRIGÉ vers / (interdit)
 */
export function FirmRoute({ token, user, company }) {
  const isComptableMode = useIsComptableMode(!!company?.is_admin);
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

  // CAS 0 (v8.24) : Admin IO BILL en mode comptable
  // Affiche un Dashboard cabinet d'aperçu (sans réelles données firm).
  // Si l'admin est aussi firm_member d'un vrai cabinet, on utilise celui-là.
  if (isComptableMode) {
    const previewFirm = firm || {
      id: "__admin_preview__",
      name: "Mode Comptable (aperçu admin)",
      brand_color: "#d4a843"
    };
    const previewMember = member || { role: "viewer", receive_email_notifications: false };
    return <FirmDashboardPage token={token} user={user} firm={previewFirm} member={previewMember} />;
  }

  // CAS 1 : Comptable membre → Dashboard cabinet
  if (firm) {
    return <FirmDashboardPage token={token} user={user} firm={firm} member={member} />;
  }

  // CAS 2 : Pending firm setup
  let pendingFirm = false;
  try { pendingFirm = localStorage.getItem("iobill_pending_firm_setup") === "1"; } catch {}
  if (pendingFirm) {
    return <FirmOnboardingPage token={token} user={user} />;
  }

  // CAS 3 : Abonné Pro → INTERDIT
  if (company) {
    return <Navigate to="/" replace />;
  }

  // CAS 4 : User sans rien → onboarding
  return <FirmOnboardingPage token={token} user={user} />;
}

/**
 * FirmOnboardingRoute — route /firm/onboarding.
 */
export function FirmOnboardingRoute({ token, user, company }) {
  const isComptableMode = useIsComptableMode(!!company?.is_admin);
  const { loading, firm } = useMyFirm(token, user?.id);
  if (loading) return null;
  if (isComptableMode) return <Navigate to="/firm" replace />;
  if (firm) return <Navigate to="/firm" replace />;
  if (company) return <Navigate to="/" replace />;
  return <FirmOnboardingPage token={token} user={user} />;
}
