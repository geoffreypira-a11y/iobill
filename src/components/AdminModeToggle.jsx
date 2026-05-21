import React from "react";
import { useNavigate } from "react-router-dom";

const STORAGE_KEY = "iobill_admin_mode";

/**
 * AdminModeToggle — Badge fixe en haut à droite.
 *
 * RÉSERVÉ AUX ADMINS IO BILL (company.is_admin = TRUE).
 * Les utilisateurs lambdas (Pro ou Comptable) ne le voient JAMAIS.
 *
 * v8.24 : 3 modes disponibles pour tester rapidement les vues du produit :
 *   - 🛡 Mode Admin       : panel /admin avec gestion abonnés
 *   - 👤 Mode Utilisateur : IO BILL comme un Pro abonné lambda
 *   - 📋 Mode Comptable   : interface cabinet /firm (vue viewer pour tester)
 *
 * Cycle au click : admin → user → comptable → admin → ...
 *
 * Le mode est persisté en localStorage et déclenche un événement
 * "admin-mode-changed" pour que la Sidebar et les routes se rafraîchissent.
 */
export function AdminModeToggle({ isAdmin }) {
  const navigate = useNavigate();

  if (!isAdmin) return null;

  const mode = getAdminMode();
  const config = MODE_CONFIG[mode] || MODE_CONFIG.admin;

  function toggleMode() {
    // Cycle : admin → user → comptable → admin
    const next = mode === "admin" ? "user"
      : mode === "user" ? "comptable"
      : "admin";
    localStorage.setItem(STORAGE_KEY, next);
    if (next === "admin") navigate("/admin");
    else if (next === "comptable") navigate("/firm");
    else navigate("/");
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
        background: config.bg,
        border: `1px solid ${config.border}`,
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
      title={`Mode actuel : ${config.label}. Cliquez pour basculer.`}
      onMouseEnter={(e) => e.currentTarget.style.transform = "scale(1.03)"}
      onMouseLeave={(e) => e.currentTarget.style.transform = "scale(1)"}
    >
      <span style={{ fontSize: 14 }}>{config.icon}</span>
      <span style={{ color: config.color }}>{config.label}</span>
      <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 4 }}>
        ⇄ basculer
      </span>
    </div>
  );
}

const MODE_CONFIG = {
  admin: {
    icon: "🛡",
    label: "Mode Admin",
    color: "var(--gold, #d4a843)",
    bg: "rgba(212,168,67,0.15)",
    border: "rgba(212,168,67,0.4)"
  },
  user: {
    icon: "👤",
    label: "Mode Utilisateur",
    color: "var(--green, #3ecf7a)",
    bg: "rgba(62,207,122,0.12)",
    border: "rgba(62,207,122,0.4)"
  },
  comptable: {
    icon: "📋",
    label: "Mode Comptable",
    color: "var(--gold, #d4a843)",
    bg: "rgba(212,168,67,0.15)",
    border: "rgba(212,168,67,0.4)"
  }
};

/**
 * Lit le mode courant. Par défaut "admin" pour les is_admin.
 * Valeurs possibles : "admin" | "user" | "comptable"
 */
export function getAdminMode() {
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === "user" || v === "admin" || v === "comptable") return v;
  return "admin";
}

export function setAdminMode(mode) {
  if (mode === "user" || mode === "admin" || mode === "comptable") {
    localStorage.setItem(STORAGE_KEY, mode);
  }
}

/**
 * Hook : true si l'utilisateur est admin ET en mode admin.
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

/**
 * Hook v8.24 : true si l'utilisateur est admin ET en mode comptable.
 * Permet de simuler une vue cabinet sans être réellement firm_member.
 * Pratique pour Geoffrey qui veut tester le Dashboard cabinet rapidement.
 */
export function useIsComptableMode(isAdmin) {
  const [v, setV] = React.useState(() => isAdmin && getAdminMode() === "comptable");
  React.useEffect(() => {
    function refresh() { setV(isAdmin && getAdminMode() === "comptable"); }
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
