import React, { useEffect, useState } from "react";
import { Routes, Route, Outlet, Navigate } from "react-router-dom";
import { sb } from "./lib/supabase.js";
import { saveSession, loadSession, clearSession } from "./lib/session.js";
import { Sidebar } from "./components/Sidebar.jsx";

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
import { FirmDashboardPage } from "./modules/firm/FirmDashboardPage.jsx";
import { FirmOnboardingPage } from "./modules/firm/FirmOnboardingPage.jsx";
import { FirmInviteClientPage } from "./modules/firm/FirmInviteClientPage.jsx";
import { FirmInviteAcceptPage } from "./modules/firm/FirmInviteAcceptPage.jsx";
import { FirmClientFichePage } from "./modules/firm/FirmClientFichePage.jsx";
import { TeamPage } from "./modules/team/TeamPage.jsx";
import { AdminStatsPage } from "./modules/core/AdminStatsPage.jsx";

// Audit log
import { AuditLogPage } from "./modules/audit/AuditLogPage.jsx";

// API publique developpeur
import { ApiKeysPage } from "./modules/developers/ApiKeysPage.jsx";
import { AdminPage } from "./modules/admin/AdminPage.jsx";
import { AdminModeToggle, getAdminMode, useIsAdminMode } from "./components/AdminModeToggle.jsx";
import { LegalPage } from "./modules/legal/LegalPage.jsx";
import { LegalFooter } from "./components/LegalFooter.jsx";

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
  if (!company) return <Onboarding token={session.token} user={session.user} onDone={handleOnboardingDone} />;

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

        {/* Cabinet expert-comptable */}
        <Route path="firm" element={<FirmDashboardPage token={session.token} user={session.user} />} />
        <Route path="firm/onboarding" element={<FirmOnboardingPage token={session.token} user={session.user} />} />
        <Route path="firm/clients/new" element={<FirmInviteClientPage token={session.token} user={session.user} />} />
        <Route path="firm/clients/:id" element={<FirmClientFichePage token={session.token} user={session.user} />} />
        <Route path="firm-invite/:inviteId" element={<FirmInviteAcceptPage token={session.token} user={session.user} company={company} />} />

        {/* Multi-utilisateurs (equipe) */}
        <Route path="team" element={<TeamPage token={session.token} company={company} user={session.user} />} />

        {/* Audit log */}
        <Route path="audit" element={<AuditLogPage token={session.token} company={company} />} />

        {/* API publique */}
        <Route path="developers" element={<ApiKeysPage token={session.token} company={company} />} />

        {/* Pages légales */}
        <Route path="legal/:kind" element={<LegalPage />} />
        <Route path="legal" element={<LegalPage />} />

        {/* Admin dashboard — gestion abonnés + tickets */}
        <Route path="admin" element={<AdminPage token={session.token} company={company} />} />

        {/* Admin platform stats — uniquement si is_admin */}
        <Route path="admin/stats" element={<AdminStatsPage token={session.token} company={company} />} />

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
        <Outlet />
        <LegalFooter />
      </main>
      <AdminModeToggle isAdmin={!!company?.is_admin} />
      <OnboardingTour user={session.user} company={company} />
    </div>
  );
}

/**
 * IndexRoute : redirige selon le contexte :
 *   - flag pending_firm_setup → /firm/onboarding (nouvel inscrit cabinet)
 *   - admin + mode admin → /admin
 *   - sinon → dashboard normal
 */
function IndexRoute({ session, company }) {
  const isAdminMode = useIsAdminMode(!!company?.is_admin);

  // Si un nouveau cabinet vient de s'inscrire (flag posé par AuthPage),
  // on le redirige vers la création de son cabinet.
  let pendingFirm = false;
  try { pendingFirm = localStorage.getItem("iobill_pending_firm_setup") === "1"; } catch {}
  if (pendingFirm) {
    try { localStorage.removeItem("iobill_pending_firm_setup"); } catch {}
    return <Navigate to="/firm/onboarding" replace />;
  }

  if (isAdminMode) {
    return <Navigate to="/admin" replace />;
  }
  return <DashboardPage token={session.token} company={company} />;
}
