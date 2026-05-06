import React, { useState, useEffect } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { LogoFull } from "./Logo.jsx";
import { Icon } from "./Icon.jsx";
import { sb } from "../lib/supabase.js";
import { initials } from "../lib/helpers.js";
import { useT } from "../lib/i18n.js";
import { CompanySwitcher } from "./CompanySwitcher.jsx";
import { NotificationBell } from "./NotificationBell.jsx";

export function Sidebar({ token, company, user, onSignOut }) {
  const t = useT();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isFirmMember, setIsFirmMember] = useState(false);
  const [hasTeammates, setHasTeammates] = useState(false);
  const navigate = useNavigate();
  const modules = company?.modules || {};

  const close = () => setMobileOpen(false);

  // Charge en arriere-plan : appartenance firm + presence d'autres membres
  useEffect(() => {
    if (!token || !user?.id || !company?.id) return;
    let alive = true;
    (async () => {
      const [fu, cu] = await Promise.all([
        sb.select(token, "firm_users", { filter: `user_id=eq.${user.id}`, select: "id", limit: 1 }),
        sb.select(token, "company_users", { filter: `company_id=eq.${company.id}`, select: "id", limit: 5 })
      ]);
      if (!alive) return;
      setIsFirmMember((fu || []).length > 0);
      setHasTeammates((cu || []).length > 1); // > 1 → owner + au moins un autre
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

        {/* Cabinet / Equipe / Audit / Admin */}
        <div className="nav-section">
          <div className="nav-label">{t("Avancé")}</div>
          {isFirmMember && (
            <NavLink to="/firm" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
              <Icon name="user" className="nav-icon" />
              {t("Cabinet")}
            </NavLink>
          )}
          {(hasTeammates || company?.is_admin) && (
            <NavLink to="/team" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
              <Icon name="user" className="nav-icon" />
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
          {company?.is_admin && (
            <NavLink to="/admin/stats" className={({ isActive }) => "nav-item" + (isActive ? " active" : "")} onClick={close}>
              <Icon name="dashboard" className="nav-icon" />
              {t("Stats plateforme")}
            </NavLink>
          )}
        </div>

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
          <div
            className="userbox"
            onClick={() => {
              close();
              navigate("/settings");
            }}
            title="Voir mon compte"
          >
            <div className="avatar">{initials(company?.legal_name || user?.email)}</div>
            <div className="userbox-info">
              <div className="userbox-name">{company?.legal_name || user?.email || "—"}</div>
              <div className="userbox-plan">
                {company?.sub_status === "active" ? "Pro · 9,90€" : company?.sub_status === "trialing" ? "Essai gratuit" : "Découverte"}
              </div>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
