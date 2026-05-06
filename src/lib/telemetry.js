// IO BILL - Telemetrie produit & erreurs
// - Sentry : tracking erreurs front + serverless (init lazy si DSN configure)
// - PostHog : evenements produit (identify, capture)
//
// Fonctionne en mode dégradé sans clé : les fonctions sont des no-op.

let sentryReady = false;
let posthogReady = false;
let SentryClient = null;
let PostHogClient = null;

const SENTRY_DSN = import.meta.env?.VITE_SENTRY_DSN;
const POSTHOG_KEY = import.meta.env?.VITE_POSTHOG_KEY;
const POSTHOG_HOST = import.meta.env?.VITE_POSTHOG_HOST || "https://eu.i.posthog.com";

// ─── Sentry (front) ────────────────────────────────────────
export async function initSentry() {
  if (sentryReady || !SENTRY_DSN) return;
  try {
    // Lazy import pour ne pas bloquer le bundle initial
    const Sentry = await import("@sentry/react");
    Sentry.init({
      dsn: SENTRY_DSN,
      environment: import.meta.env?.MODE || "production",
      tracesSampleRate: 0.1,    // 10% des transactions
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0.5,
      ignoreErrors: [
        "Non-Error promise rejection captured",
        "ResizeObserver loop limit exceeded",
        "Failed to fetch"
      ]
    });
    SentryClient = Sentry;
    sentryReady = true;
  } catch (e) {
    // Sentry non installe -> mode degrade
    console.warn("[telemetry] Sentry init failed:", e?.message);
  }
}

export function captureException(err, context) {
  if (sentryReady && SentryClient) {
    SentryClient.captureException(err, { extra: context || {} });
  } else if (typeof console !== "undefined") {
    console.error("[error]", err, context);
  }
}

export function setSentryUser(user) {
  if (sentryReady && SentryClient && user) {
    SentryClient.setUser({ id: user.id, email: user.email });
  }
}

// ─── PostHog (analytics produit) ────────────────────────────
export async function initPostHog() {
  if (posthogReady || !POSTHOG_KEY) return;
  try {
    const ph = (await import("posthog-js")).default;
    ph.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      capture_pageview: true,
      capture_pageleave: true,
      autocapture: false,           // on prefere des events explicites
      disable_session_recording: true,
      respect_dnt: true,
      persistence: "localStorage+cookie"
    });
    PostHogClient = ph;
    posthogReady = true;
  } catch (e) {
    console.warn("[telemetry] PostHog init failed:", e?.message);
  }
}

export function identify(user, company) {
  if (!posthogReady || !PostHogClient) return;
  try {
    PostHogClient.identify(user.id, {
      email: user.email,
      created_at: user.created_at
    });
    if (company) {
      PostHogClient.group("company", company.id, {
        name: company.legal_name,
        plan: company.subscription_plan || "free",
        vat_regime: company.vat_regime,
        fiscal_regime: company.fiscal_regime,
        modules_active: Object.entries(company.modules || {}).filter(([_, v]) => v).map(([k]) => k).join(",")
      });
    }
  } catch {}
}

/**
 * Capture un evenement produit.
 * @param {string} eventName Nom snake_case (ex: "invoice_issued", "quote_signed")
 * @param {object} props Proprietes additionnelles
 */
export function capture(eventName, props) {
  if (posthogReady && PostHogClient) {
    try { PostHogClient.capture(eventName, props || {}); } catch {}
  }
  // Fallback : log discret en dev pour debug
  if (typeof console !== "undefined" && import.meta.env?.DEV) {
    console.debug("[event]", eventName, props || {});
  }
}

// ─── Module usage : track via RPC Supabase (server-side count) ───
// Important : on stocke un agregat journalier en DB pour les stats internes
// independamment de PostHog (qui peut etre desactive par RGPD opt-out).
import { sb } from "./supabase.js";

export function bumpModuleUsage(token, companyId, moduleKey) {
  if (!token || !companyId || !moduleKey) return;
  // Fire-and-forget
  sb.rpc(token, "bump_module_usage", { p_company_id: companyId, p_module: moduleKey })
    .catch(() => {});
}

// ─── Initialisation generale ────────────────────────────────
export function initTelemetry() {
  initSentry();
  initPostHog();
}

export function shutdownTelemetry() {
  if (PostHogClient) {
    try { PostHogClient.reset(); } catch {}
  }
}
