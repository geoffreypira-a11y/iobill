import React, { useState, useEffect, useRef } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { LogoFull } from "./Logo.jsx";
import { Icon } from "./Icon.jsx";
import { sb } from "../lib/supabase.js";
import { initials } from "../lib/helpers.js";
import { useT } from "../lib/i18n.js";
import { CompanySwitcher } from "./CompanySwitcher.jsx";
import { NotificationBell } from "./NotificationBell.jsx";
import { SupportTicketModal } from "./SupportTicketModal.jsx";
import { useIsAdminMode } from "./AdminModeToggle.jsx";

export function Sidebar({ token, company, user, onSignOut }) {
  const t = useT();
  const isAdminMode = useIsAdminMode(!!company?.is_admin);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [ticketModalOpen, setTicketModalOpen] = useState(false);
  const userMenuRef = useRef(null);
  // isFirmMember retiré en v8.21 (module Cabinet abandonné).
  // Réintroduit en v8.23 avec accounting_firms (Mode Comptable).
  const [myFirm, setMyFirm] = useState(null);
  const [hasTeammates, setHasTeammates] = useState(false);
  const navigate = useNavigate();
  const modules = company?.modules || {};

  const close = () => setMobileOpen(false);

  // Fermer le menu user au click extérieur
  useEffect(() => {
    if (!userMenuOpen) return;
    function onDocClick(e) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setUserMenuOpen(false);
      }
    }
    function onEsc(e) {
      if (e.key === "Escape") setUserMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [userMenuOpen]);

  // Charge en arriere-plan : presence d'autres membres + appartenance cabinet
  useEffect(() => {
    if (!token || !user?.id) return;
    let alive = true;
    (async () => {
      // Co-équipiers de la company courante
      if (company?.id) {
        const cu = await sb.select(token, "company_users", { filter: `company_id=eq.${company.id}`, select: "id", limit: 5 });
        if (!alive) return;
        setHasTeammates((cu || []).length > 1);
      }
      // Appartenance cabinet comptable (v8.23 Mode Comptable)
      const members = await sb.select(token, "firm_members", {
        filter: `user_id=eq.${user.id}`,
        select: "firm_id,role",
        order: "joined_at.desc",
        limit: 1
      });
      if (!alive) return;
      if (members && members.length > 0) {
        const firm = await sb.selectOne(token, "accounting_firms", `id=eq.${members[0].firm_id}`);
        if (!alive) return;
        setMyFirm(firm);
      }
    })();
    return () => { alive = false; };
  }, [token, user?.id, company?.id]);

  return (
    <>
      <button className="hamburger" onClick={() => setMobileOpen(true)} aria-label="Menu">
        <span />
      </button>
      <div
        className={"mobile-overlay" + (mobileOpen ? " open" : "")}
        onClick={close}
      />
      <aside className={"sidebar" + (mobileOpen ? " open" : "")}>
        <LogoFull />

        {/* Multi-company switcher + cloche notifications */}
        <div style={{ padding: "0 16px 14px", marginTop: -4, display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <CompanySwitcher token={token} user={user} currentCompany={company} />
          </div>
          <NotificationBell token={token} company={company} user={user} />
        </div>

        {isAdminMode ? (
          // ═══════════════════════════════════════════════════════
          // MODE ADMIN : uniquement Admin + Stats plateforme
          // ═══════════════════════════════════════════════════════
          <div className="nav-section">
            <div className="nav-label">Administration</div>
            <NavLink to="/admin" end className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
              <Icon name="settings" className="nav-icon" />
              🛡 Dashboard Admin
            </NavLink>
            <NavLink to="/admin/stats" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
              <Icon name="dashboard" className="nav-icon" />
              📊 Stats plateforme
            </NavLink>
          </div>
        ) : myFirm ? (
          // ═══════════════════════════════════════════════════════
          // MODE COMPTABLE : navigation cabinet (v8.23)
          // ═══════════════════════════════════════════════════════
          <>
            <div className="nav-section">
              <div className="nav-label">{t("Cabinet")}</div>
              <NavLink to="/firm" end className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
                <Icon name="dashboard" className="nav-icon" />
                Tableau de bord
              </NavLink>
              <NavLink to="/firm/clients" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
                <Icon name="user" className="nav-icon" />
                Mes clients
              </NavLink>
              <NavLink to="/firm/anomalies" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
                <Icon name="warning" className="nav-icon" />
                Signalements
              </NavLink>
              <NavLink to="/firm/marathon" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
                <Icon name="invoice" className="nav-icon" />
                Mode Marathon
              </NavLink>
              <NavLink to="/firm/messages" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
                <Icon name="handshake" className="nav-icon" />
                Messages
              </NavLink>
            </div>
            <div className="nav-section">
              <div className="nav-label">{t("Réglages")}</div>
              <NavLink to="/firm/settings" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
                <Icon name="settings" className="nav-icon" />
                Réglages cabinet
              </NavLink>
            </div>
          </>
        ) : (
          // ═══════════════════════════════════════════════════════
          // MODE UTILISATEUR : navigation classique (sans admin)
          // ═══════════════════════════════════════════════════════
          <>
            <div className="nav-section">
              <div className="nav-label">{t("Pilotage")}</div>
              <NavLink to="/" end className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
                <Icon name="dashboard" className="nav-icon" />
                {t("Tableau de bord")}
              </NavLink>

              {modules.quotes !== false && (
                <NavLink to="/quotes" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
                  <Icon name="quote" className="nav-icon" />
                  {t("Devis")}
                </NavLink>
              )}

              {modules.invoicing !== false && (
                <NavLink to="/invoices" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
                  <Icon name="invoice" className="nav-icon" />
                  {t("Factures")}
                </NavLink>
              )}

              {modules.credit_notes !== false && (
                <NavLink to="/credit-notes" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
                  <Icon name="quote" className="nav-icon" />
                  {t("Avoirs")}
                </NavLink>
              )}

              {modules.purchases !== false && (
                <NavLink to="/purchases" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
                  <Icon name="cart" className="nav-icon" />
                  {t("Achats")}
                </NavLink>
              )}

              <NavLink to="/clients" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
                <Icon name="users" className="nav-icon" />
                {t("Clients")}
              </NavLink>
            </div>

            <div className="nav-section">
              <div className="nav-label">{t("Conformité") || "Conformité"}</div>

              {modules.vat && (
                <NavLink to="/vat" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
                  <Icon name="euro" className="nav-icon" />
                  {t("TVA")}
                </NavLink>
              )}

              {modules.urssaf && (
                <NavLink to="/urssaf" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
                  <Icon name="clock" className="nav-icon" />
                  {t("URSSAF")}
                </NavLink>
              )}

              {modules.accounting !== false && (
                <NavLink to="/accounting" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
                  <Icon name="download" className="nav-icon" />
                  {t("Export compta")}
                </NavLink>
              )}

              {modules.banking && (
                <NavLink to="/banking" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
                  <Icon name="bank" className="nav-icon" />
                  {t("Banque")}
                </NavLink>
              )}
            </div>

            {/* Section Avancé : visible uniquement si modules.advanced = true.
                Active par défaut OFF — l'abonné l'active depuis Paramètres → Modules. */}
            {modules.advanced === true && (
              <div className="nav-section">
                <div className="nav-label">{t("Avancé")}</div>
                {/* Cabinet retiré en v8.21 — sera reconstruit en v8.23 */}
                {hasTeammates && (
                  <NavLink to="/team" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
                    <Icon name="handshake" className="nav-icon" />
                    {t("Équipe")}
                  </NavLink>
                )}
                <NavLink to="/audit" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
                  <Icon name="check" className="nav-icon" />
                  {t("Journal d'audit")}
                </NavLink>
                <NavLink to="/developers" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
                  <Icon name="settings" className="nav-icon" />
                  API Développeur
                </NavLink>
              </div>
            )}
          </>
        )}

        <div className="sidebar-footer">
          <NavLink
            to="/settings"
            className={({ isActive }) => "nav-item" + (isActive ? " active" : "")}
            onClick={close}
            style={{ marginBottom: 8 }}
          >
            <Icon name="settings" className="nav-icon" />
            {t("Paramètres")}
          </NavLink>
          <div ref={userMenuRef} style={{ position: "relative" }}>
            <div
              className="userbox"
              onClick={() => setUserMenuOpen((o) => !o)}
              title={userMenuOpen ? "Fermer le menu" : "Menu utilisateur"}
              style={{ cursor: "pointer" }}
            >
              <div className="avatar">{initials(company?.legal_name || user?.email)}</div>
              <div className="userbox-info">
                <div className="userbox-name">{company?.legal_name || user?.email || "—"}</div>
                <div className="userbox-plan">
                  {company?.sub_status === "active" ? "Pro · 9,90€" : company?.sub_status === "trialing" ? "Essai gratuit" : "Découverte"}
                </div>
              </div>
              <div style={{ fontSize: 10, color: "var(--muted)", marginLeft: 6, transform: userMenuOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
                ▾
              </div>
            </div>

            {userMenuOpen && (
              <div style={{
                position: "absolute",
                bottom: "calc(100% + 6px)",
                left: 0,
                right: 0,
                background: "var(--card-bg, #1a1d22)",
                border: "1px solid var(--border, rgba(255,255,255,0.08))",
                borderRadius: 8,
                boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                overflow: "hidden",
                zIndex: 100
              }}>
                <button
                  onClick={() => {
                    setUserMenuOpen(false);
                    close();
                    navigate("/settings");
                  }}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    width: "100%", padding: "10px 14px",
                    background: "transparent", border: 0, cursor: "pointer",
                    color: "var(--text)", fontSize: 13, textAlign: "left"
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.04)"}
                  onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                >
                  <Icon name="settings" style={{ width: 16, height: 16 }} />
                  Mon compte
                </button>
                <div style={{ height: 1, background: "var(--border, rgba(255,255,255,0.06))" }} />
                <button
                  onClick={() => {
                    setUserMenuOpen(false);
                    close();
                    setTicketModalOpen(true);
                  }}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    width: "100%", padding: "10px 14px",
                    background: "transparent", border: 0, cursor: "pointer",
                    color: "var(--text)", fontSize: 13, textAlign: "left"
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.04)"}
                  onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                >
                  <span style={{ fontSize: 14 }}>🎫</span>
                  Signaler un problème
                </button>
                <div style={{ height: 1, background: "var(--border, rgba(255,255,255,0.06))" }} />
                <button
                  onClick={async () => {
                    setUserMenuOpen(false);
                    close();
                    if (onSignOut) await onSignOut();
                  }}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    width: "100%", padding: "10px 14px",
                    background: "transparent", border: 0, cursor: "pointer",
                    color: "var(--red, #e0556a)", fontSize: 13, textAlign: "left"
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = "rgba(224,85,106,0.08)"}
                  onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                >
                  <span style={{ fontSize: 14 }}>↪</span>
                  Se déconnecter
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>
      {ticketModalOpen && (
        <SupportTicketModal token={token} onClose={() => setTicketModalOpen(false)} />
      )}
    </>
  );
}
