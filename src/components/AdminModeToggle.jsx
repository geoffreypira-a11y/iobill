import React from "react";
import { useNavigate, useLocation } from "react-router-dom";

const STORAGE_KEY = "iobill_admin_mode";

/**
 * AdminModeToggle — Badge fixe en haut à droite (visible uniquement si is_admin).
 *
 * Permet de basculer entre :
 *   - Mode ADMIN : accès au panel /admin, sidebar admin visible
 *   - Mode UTILISATEUR : IO BILL comme un abonné lambda (pour tester)
 *
 * Le mode est persisté en localStorage. À la connexion, si is_admin=TRUE et
 * pas encore de préférence, on bascule par défaut en mode admin et ouvre /admin.
 */
export function AdminModeToggle({ isAdmin }) {
  const navigate = useNavigate();
  const location = useLocation();

  if (!isAdmin) return null;

  const mode = getAdminMode(); // "admin" | "user"
  const isAdminMode = mode === "admin";

  function toggleMode() {
    const newMode = isAdminMode ? "user" : "admin";
    localStorage.setItem(STORAGE_KEY, newMode);
    // Force re-render via reload léger : on redirige
    if (newMode === "admin") {
      navigate("/admin");
    } else {
      navigate("/");
    }
    // Petit refresh des composants qui lisent isAdminMode
    setTimeout(() => window.dispatchEvent(new Event("admin-mode-changed")), 0);
  }

  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        right: 16,
        zIndex: 200,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        background: isAdminMode ? "rgba(212,168,67,0.15)" : "rgba(62,207,122,0.12)",
        border: `1px solid ${isAdminMode ? "rgba(212,168,67,0.4)" : "rgba(62,207,122,0.4)"}`,
        borderRadius: 999,
        boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
        cursor: "pointer",
        userSelect: "none",
        fontSize: 12,
        fontWeight: 500,
        backdropFilter: "blur(8px)",
        transition: "all 0.15s"
      }}
      onClick={toggleMode}
      title={`Mode actuel : ${isAdminMode ? "Admin" : "Utilisateur"}. Cliquez pour basculer.`}
      onMouseEnter={(e) => e.currentTarget.style.transform = "scale(1.03)"}
      onMouseLeave={(e) => e.currentTarget.style.transform = "scale(1)"}
    >
      <span style={{ fontSize: 14 }}>{isAdminMode ? "🛡" : "👤"}</span>
      <span style={{ color: isAdminMode ? "var(--gold)" : "var(--green, #3ecf7a)" }}>
        {isAdminMode ? "Mode Admin" : "Mode Utilisateur"}
      </span>
      <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 4 }}>
        ⇄ basculer
      </span>
    </div>
  );
}

/**
 * Lit le mode admin courant. Par défaut "admin" pour les is_admin (cf. App).
 */
export function getAdminMode() {
  return localStorage.getItem(STORAGE_KEY) || "admin";
}

/**
 * Définit le mode (utile au login pour initialiser).
 */
export function setAdminMode(mode) {
  localStorage.setItem(STORAGE_KEY, mode === "user" ? "user" : "admin");
}

/**
 * Hook léger : retourne true si l'utilisateur est admin ET en mode admin.
 * Écoute les changements (event "admin-mode-changed").
 */
export function useIsAdminMode(isAdmin) {
  const [v, setV] = React.useState(() => isAdmin && getAdminMode() === "admin");
  React.useEffect(() => {
    function refresh() { setV(isAdmin && getAdminMode() === "admin"); }
    refresh();
    window.addEventListener("admin-mode-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("admin-mode-changed", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [isAdmin]);
  return v;
}
