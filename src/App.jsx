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
// Cabinet (Firm) v8.19 retiré en v8.21 — sera reconstruit en v8.23 (Mode Comptable)
import { FirmRoute, FirmOnboardingRoute } from "./modules/firm2/FirmRoute.jsx";
// v8.26 : vraies pages Sprint 2 (invitation bidirectionnelle)
import { FirmClientsListPage } from "./modules/firm2/FirmClientsListPage.jsx";
import { FirmInviteClientPage } from "./modules/firm2/FirmInviteClientPage.jsx";
// Placeholders pour Sprint 3-7 encore en dev
import {
  FirmClientFichePage,
  FirmMarathonPage,
  FirmMessagesPage,
  FirmSettingsPage
} from "./modules/firm2/FirmPlaceholders.jsx";
import { MyFirmSettingsPage } from "./modules/settings/MyFirmSettingsPage.jsx";
import { FirmInvitationLandingPage } from "./modules/firm2/FirmInvitationLandingPage.jsx";
import { useMyFirm } from "./components/FirmMode.jsx";
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
          <Route path="firm/clients/:id" element={<FirmClientFichePage token={session.token} user={session.user} company={null} />} />
          <Route path="firm/marathon" element={<FirmMarathonPage token={session.token} user={session.user} company={null} />} />
          <Route path="firm/messages" element={<FirmMessagesPage token={session.token} user={session.user} company={null} />} />
          {/* Page d'arrivée depuis email d'invitation (v8.26.3) */}
          <Route path="firm-invitation" element={<FirmInvitationLandingPage session={session} />} />
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
        <Route path="firm/clients/:id" element={<FirmClientFichePage token={session.token} user={session.user} company={company} />} />
        <Route path="firm/marathon" element={<FirmMarathonPage token={session.token} user={session.user} company={company} />} />
        <Route path="firm/messages" element={<FirmMessagesPage token={session.token} user={session.user} company={company} />} />
        <Route path="firm/settings" element={<FirmSettingsPage token={session.token} user={session.user} company={company} />} />

        {/* Multi-utilisateurs (equipe) */}
        <Route path="team" element={<TeamPage token={session.token} company={company} user={session.user} />} />

        {/* Mon cabinet comptable (v8.26 Sprint 2) */}
        <Route path="settings/firm-link" element={<MyFirmSettingsPage token={session.token} user={session.user} company={company} />} />

        {/* Page d'arrivée depuis email d'invitation cabinet (v8.26.3) */}
        <Route path="firm-invitation" element={<FirmInvitationLandingPage session={session} />} />

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
        <Outlet />
        <LegalFooter />
      </main>
      <AdminModeToggle isAdmin={!!company?.is_admin} />
      <OnboardingTour user={session.user} company={company} />
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
      <aside className="sidebar" style={{ minWidth: 220 }}>
        <div style={{ padding: "20px 16px", borderBottom: "1px solid var(--border2)" }}>
          <div style={{ fontFamily: "Syne, sans-serif", fontWeight: 700, fontSize: 20, color: "var(--gold)" }}>
            IO BILL
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
            Mode Cabinet
          </div>
        </div>
        <nav style={{ padding: 12, display: "flex", flexDirection: "column", gap: 4 }}>
          <a href="/firm" className="nav-item">📊 Tableau de bord</a>
          <a href="/firm/clients" className="nav-item">👥 Mes clients</a>
          <a href="/firm/marathon" className="nav-item">🚀 Mode Marathon</a>
          <a href="/firm/messages" className="nav-item">💬 Messages</a>
          <a href="/firm/settings" className="nav-item">⚙ Réglages cabinet</a>
        </nav>
        <div style={{ marginTop: "auto", padding: 12, borderTop: "1px solid var(--border2)" }}>
          <div style={{ fontSize: 11, color: "var(--muted2)", marginBottom: 8, padding: "0 8px" }}>
            {session.user?.email}
          </div>
          <button
            onClick={onSignOut}
            className="btn btn-ghost btn-sm"
            style={{ width: "100%", justifyContent: "center" }}
          >
            Se déconnecter
          </button>
        </div>
      </aside>
      <main className="content">
        <Outlet />
        <LegalFooter />
      </main>
    </div>
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
  return <DashboardPage token={session.token} company={company} />;
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
