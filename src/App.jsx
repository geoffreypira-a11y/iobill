import React, { useEffect, useState } from "react";
import { Routes, Route, Outlet, Navigate, useNavigate } from "react-router-dom";
import { sb } from "./lib/supabase.js";
import { saveSession, loadSession, clearSession } from "./lib/session.js";
import { Sidebar } from "./components/Sidebar.jsx";
import { LogoFull } from "./components/Logo.jsx";
import { VatReminderBanner } from "./components/VatReminderBanner.jsx";

// Core
import { AuthPage } from "./modules/core/AuthPage.jsx";
import { Onboarding } from "./modules/core/Onboarding.jsx";
import { DashboardPage } from "./modules/core/DashboardPage.jsx";
import { SettingsPage } from "./modules/core/SettingsPage.jsx";

// CRM
import { ClientsListPage } from "./modules/clients/ClientsListPage.jsx";
import { ClientFichePage } from "./modules/clients/ClientFichePage.jsx";

// Devis & Factures
import { QuotesListPage } from "./modules/invoicing/QuotesListPage.jsx";
import { InvoicesListPage } from "./modules/invoicing/InvoicesListPage.jsx";
import { CreditNotesListPage } from "./modules/invoicing/CreditNotesListPage.jsx";
import { CreditNoteEditorPage } from "./modules/invoicing/CreditNoteEditorPage.jsx";

// Achats
import { PurchasesPage } from "./modules/purchases/PurchasesPage.jsx";

// Conformite
import { VatPage } from "./modules/vat/VatPage.jsx";
import { UrssafPage } from "./modules/urssaf/UrssafPage.jsx";
import { AccountingExportPage } from "./modules/accounting/AccountingExportPage.jsx";
import { BankingPage } from "./modules/banking/BankingPage.jsx";

// Pages publiques (sans auth)
import { PublicQuotePage, PublicInvoicePage, PublicPortalPage } from "./modules/public/PublicPages.jsx";

// Cabinet expert-comptable + Equipe + Admin
// Cabinet (Firm) v8.19 retiré en v8.21 — sera reconstruit en v8.23 (Mode Comptable)
import { FirmRoute, FirmOnboardingRoute } from "./modules/firm2/FirmRoute.jsx";
// v8.26 : vraies pages Sprint 2 (invitation bidirectionnelle)
import { FirmClientsListPage } from "./modules/firm2/FirmClientsListPage.jsx";
import { FirmInviteClientPage } from "./modules/firm2/FirmInviteClientPage.jsx";
// v8.27 : vraies pages Sprint 3 (vue lecture + signalements)
import { FirmClientFichePage } from "./modules/firm2/FirmClientFichePage.jsx";
import { FirmAnomaliesPage } from "./modules/firm2/FirmAnomaliesPage.jsx";
import { FirmMessagesPage } from "./modules/firm2/FirmMessagesPage.jsx";
// v8.33 : vraie page Réglages cabinet
import { FirmSettingsPage } from "./modules/firm2/FirmSettingsPage.jsx";
// Placeholders pour Sprint 5-7 encore en dev
import {
  FirmMarathonPage
} from "./modules/firm2/FirmPlaceholders.jsx";
import { MyFirmSettingsPage } from "./modules/settings/MyFirmSettingsPage.jsx";
import { MySignalsPage } from "./modules/signals/MySignalsPage.jsx";
import { useMyFirm } from "./components/FirmMode.jsx";
import { TeamPage } from "./modules/team/TeamPage.jsx";
import { AdminStatsPage } from "./modules/core/AdminStatsPage.jsx";
import { ChatBubble } from "./components/ChatBubble.jsx";
import { SupportTicketModal } from "./components/SupportTicketModal.jsx";

// Audit log
import { AuditLogPage } from "./modules/audit/AuditLogPage.jsx";

// API publique developpeur
import { ApiKeysPage } from "./modules/developers/ApiKeysPage.jsx";
import { AdminPage } from "./modules/admin/AdminPage.jsx";
import { AdminModeToggle, getAdminMode, useIsAdminMode } from "./components/AdminModeToggle.jsx";
import { LegalPage } from "./modules/legal/LegalPage.jsx";
import { LegalFooter } from "./components/LegalFooter.jsx";
import { TrialExpiredPage } from "./modules/core/TrialExpiredPage.jsx";
import { isTrialExpired } from "./components/TrialBanner.jsx";

// Onboarding tour
import { OnboardingTour } from "./components/OnboardingTour.jsx";

// Offline support
import { OfflineBanner } from "./components/OfflineBanner.jsx";

// Telemetry (init lazy, no-op si vars non configurees)
import { initTelemetry, identify, setSentryUser, shutdownTelemetry } from "./lib/telemetry.js";

// Charge la company active de l'utilisateur en respectant l'ordre :
//   1. activeCompanyId stocke en session (selecteur multi-company)
//   2. premiere company_users acceptee (multi-user V1.1)
//   3. company.user_id (single-user V1, fallback)
async function resolveActiveCompany(token, user, preferredId) {
  // 1) ID stocke en session
  if (preferredId) {
    const co = await sb.selectOne(token, "companies", `id=eq.${preferredId}`);
    if (co) return co;
  }
  // 2) Multi-user
  const memberships = await sb.select(token, "company_users", {
    filter: `user_id=eq.${user.id}&accepted_at=not.is.null`,
    select: "company_id",
    order: "created_at.asc",
    limit: 1
  });
  if (memberships && memberships.length > 0) {
    const co = await sb.selectOne(token, "companies", `id=eq.${memberships[0].company_id}`);
    if (co) return co;
  }
  // 3) Fallback V1
  return await sb.selectOne(token, "companies", `user_id=eq.${user.id}`);
}

export default function App() {
  const [bootstrapping, setBootstrapping] = useState(true);
  const [session, setSession] = useState(null);
  const [company, setCompany] = useState(null);

  useEffect(() => {
    initTelemetry();
    (async () => {
      // HOTFIX v8.23.1 : capter le retour de confirmation email Supabase.
      // Quand l'user clique le lien dans l'email de confirmation, il revient sur
      // app.iobill.online/#access_token=...&refresh_token=...&type=signup
      // On extrait ces tokens, on les sauvegarde, on nettoie l'URL.
      const hash = window.location.hash || "";
      if (hash.length > 1 && hash.includes("access_token=")) {
        try {
          const params = new URLSearchParams(hash.substring(1));
          const accessToken = params.get("access_token");
          const refreshToken = params.get("refresh_token");
          if (accessToken) {
            const userFromToken = await sb.getUser(accessToken);
            if (userFromToken && userFromToken.id) {
              saveSession(accessToken, refreshToken || "", userFromToken);
              // Nettoyer l'URL pour ne pas laisser le token visible
              window.history.replaceState(null, "", window.location.pathname);
            }
          }
        } catch (e) {
          console.warn("[auth-callback] hash parse error:", e?.message);
        }
      }

      const s = loadSession();
      if (!s.token) { setBootstrapping(false); return; }
      const user = await sb.getUser(s.token);
      if (!user || !user.id) {
        clearSession();
        setBootstrapping(false);
        return;
      }
      const co = await resolveActiveCompany(s.token, user, s.activeCompanyId);
      setSession({ token: s.token, refresh: s.refresh, user });
      setCompany(co);
      setSentryUser(user);
      identify(user, co);
      setBootstrapping(false);
    })();
  }, []);

  function handleAuthed({ token, refresh, user }) {
    saveSession(token, refresh, user);
    setSession({ token, refresh, user });
    setSentryUser(user);
    resolveActiveCompany(token, user, null).then((co) => {
      setCompany(co);
      identify(user, co);
    });
  }

  function handleOnboardingDone(co) {
    setCompany(co);
    if (session?.user) identify(session.user, co);
  }

  async function handleSignOut() {
    if (session?.token) await sb.signOut(session.token);
    shutdownTelemetry();
    clearSession();
    setSession(null);
    setCompany(null);
  }

  if (bootstrapping) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)" }}>
        Chargement...
      </div>
    );
  }

  // Routes publiques (sans auth) — disponibles MEME si pas connecte
  // Ces routes sont gerees ici pour bypass la verification de session.
  if (typeof window !== "undefined" && window.location.pathname.startsWith("/p/")) {
    return (
      <Routes>
        <Route path="/p/quote/:token" element={<PublicQuotePage />} />
        <Route path="/p/invoice/:token" element={<PublicInvoicePage />} />
        <Route path="/p/portal/:token" element={<PublicPortalPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  if (!session) return <AuthPage onAuthed={handleAuthed} />;

  // Détection du type d'utilisateur :
  //   - Pro : a une company, peut avoir is_admin
  //   - Comptable : pas de company, sera firm_member
  //
  // Si l'user vient de s'inscrire en Cabinet (flag posé par AuthPage)
  // OU si l'user n'a pas de company (vraisemblablement un comptable),
  // on route vers /firm sans passer par l'onboarding company.
  let pendingFirm = false;
  try { pendingFirm = localStorage.getItem("iobill_pending_firm_setup") === "1"; } catch {}

  if (!company) {
    // Pas de company → comptable (existant ou nouveau) OU nouveau Pro
    // On regarde le flag pending_firm_setup : s'il est posé, c'est qu'on
    // sait que l'user a choisi "Cabinet" à l'inscription.
    // Sinon, on assume Pro et on lance Onboarding company.
    //
    // ⚠ Edge case : un comptable existant qui se reconnecte n'a pas le flag.
    // On a deux options :
    //   (a) Toujours router vers /firm si pas de company (mais bloque les nouveaux Pro qui ont session sans company encore créée)
    //   (b) Garder l'Onboarding par défaut et laisser le comptable taper /firm manuellement
    //
    // Choix : (a) avec un sous-routage qui laisse Onboarding accessible
    // via /onboarding pour les nouveaux Pro (peu probable car la session
    // arrive juste après le Onboarding).
    if (pendingFirm) {
      try { localStorage.removeItem("iobill_pending_firm_setup"); } catch {}
    }
    return (
      <Routes>
        <Route element={<FirmLayout session={session} onSignOut={handleSignOut} />}>
          <Route path="firm" element={<FirmRoute token={session.token} user={session.user} company={null} />} />
          <Route path="firm/onboarding" element={<FirmOnboardingRoute token={session.token} user={session.user} company={null} />} />
          <Route path="firm/clients" element={<FirmClientsListPage token={session.token} user={session.user} company={null} />} />
          <Route path="firm/clients/new" element={<FirmInviteClientPage token={session.token} user={session.user} company={null} />} />
          <Route path="firm/clients/:linkId" element={<FirmClientFichePage token={session.token} user={session.user} company={null} />} />
          <Route path="firm/anomalies" element={<FirmAnomaliesPage token={session.token} user={session.user} company={null} />} />
          <Route path="firm/marathon" element={<FirmMarathonPage token={session.token} user={session.user} company={null} />} />
          <Route path="firm/messages" element={<FirmMessagesPage token={session.token} user={session.user} company={null} />} />
          <Route path="firm/settings" element={<FirmSettingsPage token={session.token} user={session.user} company={null} />} />
          <Route path="onboarding-company" element={<Onboarding token={session.token} user={session.user} onDone={handleOnboardingDone} />} />
          <Route path="*" element={<NoCompanyRouter pendingFirm={pendingFirm} session={session} onDone={handleOnboardingDone} />} />
        </Route>
      </Routes>
    );
  }

  // Trial expiré : page de blocage en plein écran.
  // Exception : l'admin IO BILL en mode admin garde l'accès complet
  // (pour pouvoir tester / dépanner). Les autres sont redirigés.
  const adminBypass = company.is_admin === true && getAdminMode() === "admin";
  if (isTrialExpired(company) && !adminBypass) {
    return (
      <TrialExpiredPage
        token={session.token}
        company={company}
        onSignOut={handleSignOut}
      />
    );
  }

  return (
    <Routes>
      <Route element={<AuthedLayout session={session} company={company} onSignOut={handleSignOut} />}>
        <Route index element={
          <IndexRoute session={session} company={company} />
        } />

        {/* CRM Clients */}
        <Route path="clients" element={<ClientsListPage token={session.token} company={company} setCompany={setCompany} />} />
        <Route path="clients/:id" element={<ClientFichePage token={session.token} company={company} />} />

        {/* Devis */}
        <Route path="quotes" element={<QuotesListPage token={session.token} company={company} />} />

        {/* Factures */}
        <Route path="invoices" element={<InvoicesListPage token={session.token} company={company} />} />

        {/* Avoirs */}
        <Route path="credit-notes" element={<CreditNotesListPage token={session.token} company={company} />} />
        <Route path="credit-notes/new" element={<CreditNoteEditorPage token={session.token} company={company} />} />
        <Route path="credit-notes/:id" element={<CreditNoteEditorPage token={session.token} company={company} />} />

        {/* Achats */}
        <Route path="purchases" element={<PurchasesPage token={session.token} company={company} />} />

        {/* Conformite */}
        <Route path="vat" element={<VatPage token={session.token} company={company} />} />
        <Route path="urssaf" element={<UrssafPage token={session.token} company={company} />} />
        <Route path="accounting" element={<AccountingExportPage token={session.token} company={company} />} />
        <Route path="banking" element={<BankingPage token={session.token} company={company} />} />

        {/* Cabinet — Mode Comptable v8.23 */}
        <Route path="firm" element={<FirmRoute token={session.token} user={session.user} company={company} />} />
        <Route path="firm/onboarding" element={<FirmOnboardingRoute token={session.token} user={session.user} company={company} />} />
        <Route path="firm/clients" element={<FirmClientsListPage token={session.token} user={session.user} company={company} />} />
        <Route path="firm/clients/new" element={<FirmInviteClientPage token={session.token} user={session.user} company={company} />} />
        <Route path="firm/clients/:linkId" element={<FirmClientFichePage token={session.token} user={session.user} company={company} />} />
        <Route path="firm/anomalies" element={<FirmAnomaliesPage token={session.token} user={session.user} company={company} />} />
        <Route path="firm/marathon" element={<FirmMarathonPage token={session.token} user={session.user} company={company} />} />
        <Route path="firm/messages" element={<FirmMessagesPage token={session.token} user={session.user} company={company} />} />
        <Route path="firm/settings" element={<FirmSettingsPage token={session.token} user={session.user} company={company} />} />

        {/* Multi-utilisateurs (equipe) */}
        <Route path="team" element={<TeamPage token={session.token} company={company} user={session.user} />} />

        {/* Mon cabinet comptable (v8.26 Sprint 2) */}
        <Route path="settings/firm-link" element={<MyFirmSettingsPage token={session.token} user={session.user} company={company} />} />

        {/* Signalements côté abonné Pro (v8.27.3 Sprint 3) */}
        <Route path="signals" element={<MySignalsPage token={session.token} user={session.user} company={company} />} />

        {/* Audit log */}
        <Route path="audit" element={<AuditLogPage token={session.token} company={company} />} />

        {/* API publique */}
        <Route path="developers" element={<ApiKeysPage token={session.token} company={company} />} />

        {/* Pages légales */}
        <Route path="legal/:kind" element={<LegalPage />} />
        <Route path="legal" element={<LegalPage />} />

        {/* Admin dashboard — réservé strict aux is_admin (ni Pro ni Comptable n'y accèdent) */}
        <Route path="admin" element={<AdminGuard company={company}><AdminPage token={session.token} company={company} /></AdminGuard>} />

        {/* Admin platform stats — uniquement si is_admin */}
        <Route path="admin/stats" element={<AdminGuard company={company}><AdminStatsPage token={session.token} company={company} /></AdminGuard>} />

        {/* Parametres */}
        <Route
          path="settings"
          element={
            <SettingsPage
              token={session.token}
              company={company}
              setCompany={setCompany}
              user={session.user}
              onSignOut={handleSignOut}
            />
          }
        />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function AuthedLayout({ session, company, onSignOut }) {
  return (
    <div className="shell">
      <OfflineBanner />
      <Sidebar token={session.token} company={company} user={session.user} onSignOut={onSignOut} />
      <main className="content">
        <VatReminderBanner token={session.token} company={company} />
        <Outlet />
        <LegalFooter />
      </main>
      <AdminModeToggle isAdmin={!!company?.is_admin} />
      <OnboardingTour user={session.user} company={company} />
      <ChatBubble token={session.token} user={session.user} company={company} />
    </div>
  );
}

/**
 * FirmLayout — Layout minimal pour les utilisateurs sans company (comptables).
 * Pas de NotificationBell, pas d'OnboardingTour, pas d'AdminModeToggle.
 * Juste une sidebar simplifiée et le contenu.
 */
function FirmLayout({ session, onSignOut }) {
  return (
    <div className="shell">
      <OfflineBanner />
      <aside className="sidebar" style={{ minWidth: 220, display: "flex", flexDirection: "column" }}>
        {/* Haut : identique à la sidebar abonné */}
        <LogoFull />
        <div style={{ padding: "0 16px 14px", marginTop: -4, fontSize: 11, color: "var(--muted)" }}>
          Mode Cabinet
        </div>

        {/* Menu */}
        <nav style={{ padding: 12, display: "flex", flexDirection: "column", gap: 4 }}>
          <a href="/firm" className="nav-item">📊 Tableau de bord</a>
          <a href="/firm/clients" className="nav-item">👥 Mes clients</a>
          <a href="/firm/messages" className="nav-item">💬 Messages</a>
          <a href="/firm/settings" className="nav-item">⚙ Réglages cabinet</a>
        </nav>

        {/* Bas : carte cabinet (logo + nom + email) */}
        <FirmSidebarFooter token={session.token} user={session.user} onSignOut={onSignOut} />
      </aside>
      <main className="content">
        <Outlet />
        <LegalFooter />
      </main>
    </div>
  );
}

/**
 * FirmSidebarFooter — affiche en bas de la sidebar cabinet :
 *   - une carte cliquable avec logo + nom du cabinet + email de l'utilisateur
 *   - au clic, popup avec : Réglages cabinet / Signaler un problème / Se déconnecter
 *
 * Comportement aligné sur le menu utilisateur de la sidebar abonné
 * (v8.35 — uniformisation UX cabinet / abonné).
 */
function FirmSidebarFooter({ token, user, onSignOut }) {
  const [firm, setFirm] = React.useState(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [ticketOpen, setTicketOpen] = React.useState(false);
  const menuRef = React.useRef(null);
  const navigate = useNavigate();

  // Charge le cabinet
  React.useEffect(() => {
    if (!token || !user?.id) return;
    let alive = true;
    (async () => {
      try {
        const memberships = await sb.select(token, "firm_members", {
          filter: `user_id=eq.${user.id}`,
          select: "firm_id",
          order: "",
          limit: 1
        });
        if (memberships && memberships[0]) {
          const f = await sb.selectOne(
            token,
            "accounting_firms",
            `id=eq.${memberships[0].firm_id}`,
            "id,name,logo_url"
          );
          if (alive) setFirm(f);
        }
      } catch {}
    })();
    return () => { alive = false; };
  }, [token, user?.id]);

  // Fermer le menu au clic extérieur + Escape
  React.useEffect(() => {
    if (!menuOpen) return;
    function onDocClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    }
    function onEsc(e) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [menuOpen]);

  return (
    <>
      <div style={{ marginTop: "auto", padding: 12, borderTop: "1px solid var(--border2)" }}>
        <div ref={menuRef} style={{ position: "relative" }}>
          {/* Carte cabinet cliquable */}
          <div
            onClick={() => setMenuOpen((o) => !o)}
            title={menuOpen ? "Fermer le menu" : "Menu cabinet"}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "8px",
              background: "rgba(255,255,255,0.02)",
              borderRadius: 6,
              cursor: "pointer",
              border: "1px solid transparent",
              transition: "background 0.15s, border-color 0.15s"
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.05)";
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(255,255,255,0.02)";
              e.currentTarget.style.borderColor = "transparent";
            }}
          >
            {firm?.logo_url ? (
              <img
                src={firm.logo_url}
                alt={firm.name}
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 4,
                  objectFit: "contain",
                  background: "#fff",
                  padding: 2,
                  flexShrink: 0
                }}
              />
            ) : (
              <div style={{
                width: 32,
                height: 32,
                borderRadius: 4,
                background: "rgba(212,168,67,0.15)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 14,
                fontWeight: 700,
                color: "var(--gold)",
                flexShrink: 0
              }}>
                {firm?.name ? firm.name.charAt(0).toUpperCase() : "?"}
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 13,
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap"
              }}>
                {firm?.name || "Mon cabinet"}
              </div>
              <div style={{
                fontSize: 11,
                color: "var(--muted, #8a8d93)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                marginTop: 2
              }}>
                {user?.email || "—"}
              </div>
            </div>
            <div style={{
              fontSize: 10,
              color: "var(--muted)",
              marginLeft: 4,
              transform: menuOpen ? "rotate(180deg)" : "none",
              transition: "transform 0.15s"
            }}>
              ▾
            </div>
          </div>

          {/* Popup menu — identique en style à Sidebar.jsx abonné */}
          {menuOpen && (
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
                  setMenuOpen(false);
                  navigate("/firm/settings");
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
                <span style={{ fontSize: 14 }}>⚙</span>
                Réglages cabinet
              </button>
              <div style={{ height: 1, background: "var(--border, rgba(255,255,255,0.06))" }} />
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setTicketOpen(true);
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
                  setMenuOpen(false);
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

      {/* Modale ticket support, montée hors de la sidebar */}
      {ticketOpen && (
        <SupportTicketModal token={token} onClose={() => setTicketOpen(false)} />
      )}
    </>
  );
}

/**
 * IndexRoute : redirige selon le contexte :
 *   - flag pending_firm_setup → /firm (membership puis onboarding auto via FirmRoute)
 *   - admin + mode admin → /admin
 *   - sinon → dashboard normal
 */
function IndexRoute({ session, company }) {
  const isAdminMode = useIsAdminMode(!!company?.is_admin);

  // Si un nouveau cabinet vient de s'inscrire (flag posé par AuthPage),
  // on le redirige vers /firm. FirmRoute se chargera d'afficher
  // l'onboarding si pas encore membre, ou le dashboard si déjà créé.
  let pendingFirm = false;
  try { pendingFirm = localStorage.getItem("iobill_pending_firm_setup") === "1"; } catch {}
  if (pendingFirm) {
    try { localStorage.removeItem("iobill_pending_firm_setup"); } catch {}
    return <Navigate to="/firm" replace />;
  }

  if (isAdminMode) {
    return <Navigate to="/admin" replace />;
  }
  return <DashboardPage token={session.token} company={company} user={session.user} />;
}

/**
 * AdminGuard — protège les routes /admin et /admin/stats.
 *
 * Seuls les comptes avec company.is_admin = TRUE peuvent accéder.
 * Les abonnés Pro et les comptables qui tapent /admin sont redirigés vers /.
 */
function AdminGuard({ company, children }) {
  if (!company?.is_admin) {
    return <Navigate to="/" replace />;
  }
  return children;
}

/**
 * NoCompanyRouter — Décide où envoyer un user sans company.
 *
 *   - Si pendingFirm (flag) ou firm_member existant → /firm
 *   - Sinon → onboarding company (Pro nouveau)
 *
 * Utilise un hook qui détecte le membership cabinet en arrière-plan.
 */
function NoCompanyRouter({ pendingFirm, session, onDone }) {
  const { loading, firm } = useMyFirm(session.token, session.user?.id);

  if (loading) return null;
  if (firm || pendingFirm) {
    return <Navigate to="/firm" replace />;
  }
  // Pro nouveau : onboarding company
  return <Onboarding token={session.token} user={session.user} onDone={onDone} />;
}
