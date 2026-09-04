// IO BILL — api/_lib/pa-actions.js
// ════════════════════════════════════════════════════════════════════
// Toutes les actions PA. Monté dans admin.js (authentifié) et
// public.js (webhook non authentifié).
// Préfixe underscore ⇒ pas compté dans les 12 fonctions Vercel.
//
// Modèle d'accès (Version 1 + dérogation) :
//   • self_service_allowed = FALSE (défaut) → l'abonné voit sa config en
//     lecture seule et ne peut que DEMANDER une modification.
//   • self_service_allowed = TRUE → l'abonné saisit ses propres codes.
//   • L'admin (is_admin) écrit toujours, et bascule le flag.
// ════════════════════════════════════════════════════════════════════

import { sbAdmin } from "./supabase-admin.js";
import { getProvider, normalizeInbound, LIFECYCLE } from "./pa-adapter.js";

const SUPA_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SR_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = "pa-inbound";

/* ─── select STRICT : lève au lieu de renvoyer [] ──────────────────
   Pattern IO BILL : sbAdmin.select avale les 400 (code 42703 =
   colonne inexistante). Ici on veut savoir.                        */
async function strictSelect(table, query) {
  const r = await fetch(SUPA_URL + "/rest/v1/" + table + "?" + query, {
    headers: { apikey: SR_KEY, Authorization: "Bearer " + SR_KEY }
  });
  const t = await r.text();
  if (!r.ok) throw new Error("[PA/" + table + "] " + r.status + " " + t);
  return t ? JSON.parse(t) : [];
}

async function upsert(table, rows, onConflict) {
  const r = await fetch(SUPA_URL + "/rest/v1/" + table + "?on_conflict=" + encodeURIComponent(onConflict), {
    method: "POST",
    headers: {
      apikey: SR_KEY, Authorization: "Bearer " + SR_KEY,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation"
    },
    body: JSON.stringify(rows)
  });
  const t = await r.text();
  if (!r.ok) throw new Error("[PA/upsert " + table + "] " + r.status + " " + t);
  return t ? JSON.parse(t) : [];
}

function fail(status, message) {
  const e = new Error(message);
  e.paStatus = status;
  return e;
}

async function logEvent(row) {
  try { await sbAdmin.insert("pa_events", [row]); }
  catch (e) { console.error("[pa_events]", e.message); }
}

/* ─── Credentials ──────────────────────────────────────────────── */

/* ══════════════════════════════════════════════════════════════════
   OAUTH2 « AUTHORIZATION CODE » — raccordement du compte d'un client
   ══════════════════════════════════════════════════════════════════
   Doc SUPER PDP : /documentation/4#authorization-code

   IO BILL est une application OAuth unique (un seul client_id/secret,
   en variables d'environnement). Chaque société cliente autorise cette
   application à accéder à SON compte SUPER PDP : c'est ce consentement
   qui remplace le mandat papier.

   Les sociétés déjà branchées en `client_credentials` ne sont PAS
   concernées : leur `auth_mode` reste à sa valeur par défaut et rien
   dans leur chemin d'exécution ne change.                             */

const OAUTH_CLIENT_ID     = process.env.SUPERPDP_OAUTH_CLIENT_ID || "";
const OAUTH_CLIENT_SECRET = process.env.SUPERPDP_OAUTH_CLIENT_SECRET || "";

/** L'URL de redirection doit être IDENTIQUE à celle déclarée dans
    l'interface SUPER PDP, au caractère près. */
function oauthRedirectUri() {
  return process.env.SUPERPDP_OAUTH_REDIRECT_URI
      || ((process.env.APP_URL || "https://app.iobill.online") + "/pa/callback");
}

function requireOauthApp() {
  if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    throw fail(503, "Application OAuth non configurée : renseignez "
      + "SUPERPDP_OAUTH_CLIENT_ID et SUPERPDP_OAUTH_CLIENT_SECRET.");
  }
}

/** Applique un couple de jetons reçu de /oauth2/token sur la ligne. */
function tokenPatch(tok) {
  const ttl = Number(tok.expires_in || 1800);
  const patch = {
    access_token: tok.access_token,
    token_expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
    last_auth_ok_at: new Date().toISOString(),
    last_error: null
  };
  // OAuth 2.1 : le refresh_token TOURNE à chaque usage. S'il est renvoyé,
  // l'ancien est mort — ne jamais le conserver.
  if (tok.refresh_token) patch.refresh_token = tok.refresh_token;
  return patch;
}

/** Renvoie une ligne pa_credentials dont l'access_token est utilisable.
    No-op complet en mode client_credentials. */
async function ensureAccessToken(creds) {
  if (creds.auth_mode !== "authorization_code") return creds;

  const exp = creds.token_expires_at ? Date.parse(creds.token_expires_at) : 0;
  // Marge de 2 min : un jeton qui expire pendant l'appel ne sert à rien.
  if (creds.access_token && exp > Date.now() + 120000) return creds;

  if (!creds.refresh_token) {
    throw fail(400, "Compte non raccordé à la plateforme agréée. "
      + "Relancez le raccordement depuis Réglages → Plateforme Agréée.");
  }
  requireOauthApp();

  const { impl, cfg } = getProvider(creds);
  let tok;
  try {
    tok = await impl.oauthRefresh(cfg, {
      refreshToken: creds.refresh_token,
      clientId: OAUTH_CLIENT_ID,
      clientSecret: OAUTH_CLIENT_SECRET
    });
  } catch (e) {
    // Une exécution concurrente a pu consommer le refresh_token juste avant
    // (rotation OAuth 2.1). On relit : si elle a écrit un jeton frais, il fait foi.
    const fresh = await sbAdmin.selectOne("pa_credentials", "company_id=eq." + creds.company_id);
    const freshExp = fresh?.token_expires_at ? Date.parse(fresh.token_expires_at) : 0;
    if (fresh?.access_token && freshExp > Date.now() + 60000) return fresh;

    await sbAdmin.update("pa_credentials", "company_id=eq." + creds.company_id,
      { last_error: "Rafraîchissement OAuth2 échoué : " + e.message });
    throw fail(401, "Raccordement expiré ou révoqué. Relancez le raccordement "
      + "depuis Réglages → Plateforme Agréée.");
  }

  const patch = tokenPatch(tok);
  // Écriture GARDÉE sur l'ancien refresh_token : si une autre exécution a
  // déjà tourné, on n'écrase pas son jeton par le nôtre.
  const guard = "company_id=eq." + creds.company_id
              + "&refresh_token=eq." + encodeURIComponent(creds.refresh_token);
  const rows = await sbAdmin.update("pa_credentials", guard, patch);
  if (!rows || rows.length === 0) {
    const fresh = await sbAdmin.selectOne("pa_credentials", "company_id=eq." + creds.company_id);
    if (fresh?.access_token) return fresh;
  }
  return { ...creds, ...patch };
}

async function loadCreds(companyId, { requireEnabled = true } = {}) {
  const rows = await strictSelect("pa_credentials", "company_id=eq." + companyId + "&select=*&limit=1");
  const c = rows[0];
  if (!c) throw fail(400, "Plateforme agréée non configurée pour cette entreprise");
  if (requireEnabled && !c.enabled) throw fail(400, "Plateforme agréée désactivée");
  // En OAuth2 « authorization_code » il n'y a pas de client_id par société :
  // c'est l'application IO BILL qui porte l'identité, et le jeton la société.
  if (requireEnabled && c.auth_mode !== "authorization_code" && !c.client_id) {
    throw fail(400, "client_id manquant");
  }
  return ensureAccessToken(c);
}

/** Config sans aucun secret — c'est ce que voit le front. */
function publicCfg(c, companyId) {
  if (!c) {
    return {
      configured: false,
      self_service_allowed: false,
      webhook_url: (process.env.APP_URL || "https://app.iobill.online") + "/api/public?op=pa_webhook&company_id=" + companyId
    };
  }
  return {
    configured: true,
    provider: c.provider,
    environment: c.environment,
    base_url: c.base_url,
    enabled: c.enabled !== false,
    // v8.128 — Transmission effective : bloquée UNIQUEMENT si la réception est
    // EXPLICITEMENT désactivée (enabled === false). null/absent = actif (comme
    // avant la séparation réception/transmission) → ne casse pas l'existant.
    transmission_enabled: c.enabled !== false && c.transmission_enabled !== false,
    self_service_allowed: c.self_service_allowed === true,
    managed_by_admin: c.managed_by_admin === true,
    has_client_secret: !!c.client_secret,
    has_webhook_secret: !!c.webhook_secret,
    client_id: c.client_id || null,
    // v8.130 — Raccordement OAuth2 (aucun jeton n'est exposé au front).
    auth_mode: c.auth_mode || "client_credentials",
    oauth_linked: !!(c.auth_mode === "authorization_code" && c.refresh_token),
    oauth_linked_at: c.oauth_linked_at || null,
    company_verification_status: c.company_verification_status || null,
    user_identity_verification_status: c.user_identity_verification_status || null,
    directory_identifier: c.directory_identifier || null,
    directory_status: c.directory_status || null,
    last_error: c.last_error,
    last_auth_ok_at: c.last_auth_ok_at,
    cursor_id: c.cursor_id,
    webhook_url: (process.env.APP_URL || "https://app.iobill.online") + "/api/public?op=pa_webhook&company_id=" + companyId
  };
}

/* ══════════════════════════════════════════════════════════════════
   ACTIONS ABONNÉ
   ══════════════════════════════════════════════════════════════════ */

export async function paConfigGet(company) {
  const rows = await strictSelect("pa_credentials", "company_id=eq." + company.id + "&select=*&limit=1");
  const pending = await strictSelect(
    "pa_credential_requests",
    "company_id=eq." + company.id + "&status=eq.pending&select=*&order=created_at.desc&limit=5"
  );
  return { config: publicCfg(rows[0], company.id), pending_requests: pending };
}

/** Écriture par l'abonné : autorisée UNIQUEMENT si self_service_allowed. */
export async function paConfigSaveBySubscriber(company, payload) {
  const rows = await strictSelect("pa_credentials", "company_id=eq." + company.id + "&select=*&limit=1");
  const existing = rows[0];

  if (existing && existing.self_service_allowed !== true) {
    throw fail(403, "Configuration verrouillée par IO BILL. Utilisez « Demander une modification ».");
  }

  const patch = {
    company_id: company.id,
    provider: payload.provider || "superpdp",
    environment: payload.environment || "sandbox",
    base_url: payload.base_url || null,
    enabled: !!payload.enabled,
    self_service_allowed: existing ? existing.self_service_allowed : true,
    updated_by: "subscriber"
  };
  if (payload.client_id) patch.client_id = payload.client_id;
  if (payload.client_secret) patch.client_secret = payload.client_secret;
  if (payload.webhook_secret) patch.webhook_secret = payload.webhook_secret;

  await upsert("pa_credentials", [patch], "company_id");
  await logEvent({
    company_id: company.id, direction: "admin", event_type: "credentials.updated",
    status: "ok", message: "Modifiées par l'abonné (self-service)"
  });
  return { ok: true };
}

/** Demande de modification quand la config est verrouillée. */
export async function paRequestChange(user, company, payload) {
  const message = String(payload?.message || "").trim();
  if (!message) throw fail(400, "Message requis");
  if (message.length > 2000) throw fail(400, "Message trop long (max 2000)");

  const dup = await strictSelect(
    "pa_credential_requests",
    "company_id=eq." + company.id + "&status=eq.pending&select=id&limit=1"
  );
  if (dup[0]) throw fail(409, "Une demande est déjà en attente de traitement");

  await sbAdmin.insert("pa_credential_requests", [{
    company_id: company.id, user_id: user.id, message, status: "pending"
  }]);
  await logEvent({
    company_id: company.id, direction: "admin", event_type: "credentials.change_requested",
    status: "pending", message: message.slice(0, 500)
  });
  return { ok: true };
}

/* ─── Émission ──────────────────────────────────────────────────── */

/** Récupère le PDF Factur-X déjà généré par generate-facturx.js. */
async function fetchFacturxPdf(inv) {
  const path = inv.facturx_pdf_url || inv.pdf_url;
  if (!path) return null;
  let url;
  if (/^https?:/i.test(path)) {
    url = path;
  } else {
    const enc = path.split("/").map(encodeURIComponent).join("/");
    url = SUPA_URL + "/storage/v1/object/invoices-pdf/" + enc;
  }
  const r = await fetch(url, { headers: { apikey: SR_KEY, Authorization: "Bearer " + SR_KEY } });
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
}

/** Valide la conformité SANS transmettre. Gratuit chez SUPER PDP. */
export async function paValidateInvoice(company, payload) {
  const inv = await sbAdmin.selectOne("invoices", "id=eq." + payload.invoice_id);
  if (!inv || inv.company_id !== company.id) throw fail(404, "Facture introuvable");

  const bytes = await fetchFacturxPdf(inv);
  if (!bytes) throw fail(400, "PDF Factur-X absent — génère-le d'abord");

  const creds = await loadCreds(company.id);
  const { impl, cfg } = getProvider(creds);
  const rep = await impl.validate(cfg, bytes, (inv.number || "facture") + ".pdf", "application/pdf");

  // v8.48.20 — Log complet du retour SUPER PDP pour debug conformité.
  console.log("[PA] validate response for invoice", inv.id, JSON.stringify(rep).slice(0, 2000));

  await logEvent({
    company_id: company.id, direction: "outbound", invoice_id: inv.id,
    event_type: "invoice.validated", status: rep.is_valid ? "valid" : "invalid",
    message: rep.profile || null, payload: { errors: (rep.errors || []).slice(0, 20), raw: rep.raw }
  });
  return rep;
}

export async function paSendInvoice(company, payload) {
  const inv = await sbAdmin.selectOne("invoices", "id=eq." + payload.invoice_id);
  if (!inv) throw fail(404, "Facture introuvable");
  if (inv.company_id !== company.id) throw fail(403, "Facture hors périmètre");
  if (inv.status === "draft") throw fail(400, "Émets la facture avant de la transmettre");
  if (inv.pdp_transmission_id) throw fail(409, "Facture déjà transmise (id " + inv.pdp_transmission_id + ")");

  const bytes = await fetchFacturxPdf(inv);
  if (!bytes) throw fail(400, "PDF Factur-X absent — génère-le d'abord");

  const creds = await loadCreds(company.id);
  // v8.101 — PORTE DE TRANSMISSION. La réception (achats) reste active dès que le
  // PDP est configuré ; seule l'ÉMISSION de factures vers la Plateforme Agréée
  // peut être coupée par l'admin (`transmission_enabled=false`). Tant qu'elle est
  // OFF, AUCUNE facture ne part au PDP (elle reste chez IOBILL/IOCAR, payée en
  // local). ⚠️ On ne bloque QUE sur `=== false` explicite : colonne absente /
  // null / undefined (tout l'existant avant migration) → comportement d'origine
  // strictement inchangé. La génération Factur-X n'est PAS concernée (elle a lieu
  // en amont ; ici on ne fait que la télétransmission).
  if (creds.transmission_enabled === false) {
    throw fail(403, "Transmission PDP désactivée — l'émission de factures vers la Plateforme Agréée n'est pas encore activée pour cette entreprise. (La facture reste disponible, la Factur-X est bien générée ; elle n'est simplement pas télétransmise.)");
  }
  const { impl, cfg } = getProvider(creds);

  try {
    // v8.80 (P3a) — Détection B2C : client particulier → processing_rule="B2C".
    // SUPER PDP fait alors l'e-reporting au lieu de router vers un acheteur.
    // B2B (société) : on ne pose rien → comportement d'origine strictement intact.
    const isB2C = inv.client_snapshot?.client_type === "individual";
    const out = await impl.sendInvoice(cfg, {
      bytes, contentType: "application/pdf", filename: (inv.number || "facture") + ".pdf",
      processingRule: isB2C ? "B2C" : undefined
    });
    await sbAdmin.update("invoices", "id=eq." + inv.id, {
      pdp_provider: creds.provider,
      pdp_transmission_id: out.pa_document_id,
      pdp_transmitted_at: new Date().toISOString(),
      facturx_status: "transmitted"
    });
    await logEvent({
      company_id: company.id, direction: "outbound", provider: creds.provider,
      pa_document_id: out.pa_document_id, invoice_id: inv.id,
      event_type: "invoice.submitted", status: "deposee",
      message: "Facture " + (inv.number || "")
    });

    // v8.60.10 — fr:212 auto encaissée en SYNCHRONE (await).
    //
    // Contexte : ce mécanisme (v8.57) déclenche automatiquement fr:212 après
    // la transmission fr:200 lorsque la facture est déjà payée. En B2C c'est
    // le workflow standard : le clic "🚗 Livré" côté IOCAR passe la facture
    // en paid, et immédiatement fr:200 (dépôt SUPER PDP) → fr:212 (e-reporting
    // paiement) doivent s'enchaîner sans intervention utilisateur.
    //
    // Bug d'origine : appel en fire-and-forget (Promise sans await + .catch)
    // → sur Vercel Hobby, le worker termine dès le `return { ok: true }`
    // suivant, TUANT la promesse avant qu'elle atteigne le POST vers SUPER PDP.
    // Résultat observable : facturx_status reste à "transmitted" pour toujours,
    // Burger Queen ne fait jamais son e-reporting paiement B2C → hors conformité.
    //
    // Fix : await synchrone. Le catch garde le comportement de logger sans
    // faire échouer paSendInvoice (la transmission fr:200 elle-même a réussi,
    // pas de raison de la remonter en erreur si fr:212 rate — la commande
    // pa_invoice_encaisser reste appelable manuellement pour rattraper).
    //
    // Même pattern que v8.60.3 sur push_invoice (triggerFacturxGenerationSync).
    if (inv.status === "paid" || inv.status === "encaissee") {
      // Recharge la version fraîche avec le pdp_transmission_id posé
      const invFresh = { ...inv, pdp_transmission_id: out.pa_document_id };
      try {
        await paInvoiceEncaisser(company, { invoice_id: invFresh.id });
        console.log("[PA] v8.60.10 auto-fr:212 OK invoice=" + inv.id);
      } catch (e) {
        console.warn("[PA] v8.60.10 auto-fr:212 après transmission échoué : " + e.message);
      }
    }

    return { ok: true, pa_document_id: out.pa_document_id };
  } catch (e) {
    await sbAdmin.update("invoices", "id=eq." + inv.id, { facturx_status: "rejected" });
    await logEvent({
      company_id: company.id, direction: "outbound", invoice_id: inv.id,
      event_type: "invoice.error", status: "error", message: String(e.message).slice(0, 500)
    });
    throw e;
  }
}

export async function paInvoiceStatus(company, payload) {
  const inv = await sbAdmin.selectOne("invoices", "id=eq." + payload.invoice_id);
  if (!inv || inv.company_id !== company.id) throw fail(404, "Facture introuvable");
  if (!inv.pdp_transmission_id) throw fail(400, "Facture jamais transmise");

  const creds = await loadCreds(company.id);
  const { impl, cfg } = getProvider(creds);
  const j = await impl.getInvoice(cfg, inv.pdp_transmission_id);

  // v8.57.8 — Lecture du cycle de vie complet AFNOR avec 5 états UI :
  //
  //   PRIORITÉ (du plus terminal au moins) :
  //     rejected      = fr:210 (refus manuel) / fr:213 (rejet plateforme) / fr:501 (irrecevable)
  //     paid          = fr:212 (Encaissée, le vendeur confirme réception paiement)
  //     payment_sent  = fr:211 (Paiement transmis par l'acheteur)
  //     accepted      = fr:205 (Approuvée par l'acheteur)
  //     transmitted   = fr:200 → fr:204 (cycle en cours, aucun terminal atteint)
  //
  // Un refus (rejected) est ABSOLU : dès qu'il apparaît, il l'emporte sur tout.
  // Pour les autres, on prend le plus avancé chronologiquement.
  const events = Array.isArray(j.events) ? j.events : [];

  const REJECT_CODES = new Set([LIFECYCLE.refusee, LIFECYCLE.rejetee, LIFECYCLE.irrecevable]);
  const PAID_CODE    = LIFECYCLE.encaissee;    // fr:212
  const PSENT_CODE   = LIFECYCLE.paiement_tx;  // fr:211
  const ACCEPT_CODE  = LIFECYCLE.approuvee;    // fr:205

  let seenRejected = false;
  let seenPaid = false;
  let seenPaymentSent = false;
  let seenAccepted = false;
  let latestCode = null;
  let latestCreatedAt = "";

  for (const e of events) {
    const c = e?.status_code;
    if (!c) continue;
    if (REJECT_CODES.has(c)) seenRejected = true;
    if (c === PAID_CODE)     seenPaid = true;
    if (c === PSENT_CODE)    seenPaymentSent = true;
    if (c === ACCEPT_CODE)   seenAccepted = true;
    const ts = String(e.created_at || "");
    if (ts >= latestCreatedAt) { latestCreatedAt = ts; latestCode = c; }
  }

  // Résolution du fx selon la priorité
  const fx = seenRejected    ? "rejected"
           : seenPaid        ? "paid"
           : seenPaymentSent ? "payment_sent"
           : seenAccepted    ? "accepted"
           : "transmitted";

  // Ne met à jour la base que si le statut a effectivement changé
  if (fx !== inv.facturx_status) {
    await sbAdmin.update("invoices", "id=eq." + inv.id, { facturx_status: fx });
  }

  return { ok: true, status_code: latestCode, facturx_status: fx, events_count: events.length };
}

/* ─── Réception ─────────────────────────────────────────────────── */

async function storeFile(companyId, impl, cfg, paDocId) {
  try {
    const f = await impl.fetchFile(cfg, paDocId, "pdf");
    console.log("[PA] storeFile got bytes=" + f.bytes.length + " ct=" + f.contentType);
    const path = companyId + "/" + paDocId + "." + f.ext;
    const enc = path.split("/").map(encodeURIComponent).join("/");
    const uploadUrl = SUPA_URL + "/storage/v1/object/" + BUCKET + "/" + enc;
    const r = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        apikey: SR_KEY, Authorization: "Bearer " + SR_KEY,
        "Content-Type": f.contentType, "x-upsert": "true"
      },
      body: f.bytes
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.error("[PA] storeFile upload " + r.status + " @ " + uploadUrl + " → " + body.slice(0, 300));
      return null;
    }
    console.log("[PA] storeFile OK → " + path);
    return path;
  } catch (e) {
    console.warn("[PA] storeFile exception :", e.message);
    return null;
  }
}

async function persistInbound(companyId, creds, impl, cfg, item) {
  // v8.48.2 — Fix majeur : SUPER PDP /v1.beta/invoices renvoie juste
  // { id, direction, company_id, created_at }. Le détail (numéro, montants,
  // vendeur, en_invoice) est dans GET /v1.beta/invoices/{id}. Il FAUT
  // hydrater avant de normaliser, sinon la ligne créée est vide.
  const rawId = String(item.id ?? item.invoice_id ?? item.pa_document_id ?? "");
  if (!rawId) return null;

  // Hydratation systématique : le hit /invoices/{id} est peu coûteux et
  // idempotent, ça évite tous les cas où la liste renvoie une projection légère.
  let full = item;
  try {
    full = await impl.getInvoice(cfg, rawId);
  } catch (e) {
    console.warn("[PA] getInvoice indisponible, fallback sur item de liste :", e.message);
  }

  const norm = normalizeInbound(full, creds.provider);
  if (!norm.pa_document_id) return null;

  const ex = await strictSelect(
    "pa_inbound_invoices",
    "company_id=eq." + companyId + "&pa_document_id=eq." + encodeURIComponent(norm.pa_document_id) + "&select=id&limit=1"
  );
  if (ex[0]) return ex[0];

  const file_url = await storeFile(companyId, impl, cfg, norm.pa_document_id);

  const [row] = await upsert("pa_inbound_invoices", [{
    company_id: companyId, provider: creds.provider,
    pa_document_id: norm.pa_document_id,
    supplier_name: norm.supplier_name, supplier_siren: norm.supplier_siren,
    supplier_siret: norm.supplier_siret, supplier_vat_number: norm.supplier_vat_number,
    invoice_number: norm.invoice_number, invoice_date: norm.invoice_date, due_date: norm.due_date,
    currency: norm.currency,
    subtotal_ht_cents: norm.subtotal_ht_cents, vat_total_cents: norm.vat_total_cents,
    total_ttc_cents: norm.total_ttc_cents, vat_breakdown: norm.vat_breakdown, lines: norm.lines,
    format: norm.format, file_url, status: "received", raw_payload: norm.raw_payload
  }], "company_id,provider,pa_document_id");

  // Accusé de réception : obligation réglementaire côté destinataire.
  try {
    await impl.sendEvent(cfg, norm.pa_document_id, LIFECYCLE.recue);
    await sbAdmin.update("pa_inbound_invoices", "id=eq." + row.id, {
      pa_ack_status: "recue", pa_ack_sent_at: new Date().toISOString()
    });
  } catch (e) { console.warn("[PA] ack auto échoué", e.message); }

  await logEvent({
    company_id: companyId, direction: "inbound", provider: creds.provider,
    pa_document_id: norm.pa_document_id, inbound_id: row.id,
    event_type: "invoice.received", status: "received",
    message: (norm.invoice_number || "?") + " — " + (norm.supplier_name || "?")
  });
  return row;
}

/** Polling curseur. Filet de sécurité derrière le webhook. */
export async function paInboxSync(company) {
  const creds = await loadCreds(company.id);
  const { impl, cfg } = getProvider(creds);

  // v8.57.5 — Force `direction=in` côté SUPER PDP pour ne récupérer QUE
  // les factures entrantes (achat). Sans ce filtre, l'API renvoie aussi
  // nos propres émissions (out), qui étaient certes skippées côté client
  // mais faisaient AVANCER le cursor → les factures entrantes suivantes
  // arrivées avec un id inférieur au dernier out vu étaient sautées et
  // perdues à jamais. C'était le bug "je ne reçois plus rien depuis N".
  const { items, cursor } = await impl.listInvoices(cfg, {
    cursor: creds.cursor_id || null, order: "asc", limit: 50, direction: "in"
  });

  let created = 0;
  for (const it of items) {
    // Défense en profondeur : SUPER PDP applique déjà direction=in, mais on
    // re-vérifie au cas où (rétrocompat + éviter les régressions futures).
    const dir = String(it.direction || it.type || it.kind || "").toLowerCase();
    if (dir === "out" || /sale|vente|outbound|sent/.test(dir)) continue;
    const r = await persistInbound(company.id, creds, impl, cfg, it);
    if (r) created++;
  }
  if (cursor && cursor !== creds.cursor_id) {
    await sbAdmin.update("pa_credentials", "company_id=eq." + company.id, { cursor_id: cursor });
  }
  return { ok: true, fetched: items.length, created, cursor };
}

export async function paInboxAck(company, payload) {
  // v8.56 — Structure MDT-113 officielle documentée par SUPER PDP :
  //   POST /v1.beta/invoice_events
  //   {
  //     "invoice_id": <int>,
  //     "status_code": "fr:210",           // Refus
  //     "details": [{
  //       "reason": "IC001",                // code MDT-113 (AFNOR XP Z12-012)
  //       "notes": [{"contents": [{"content": "libellé libre"}]}]
  //     }]
  //   }
  // Le champ `reason` est une STRING SIMPLE, pas un objet {code,label}.

  const map = {
    approved: LIFECYCLE.approuvee,
    paid: LIFECYCLE.paiement_tx,  // v8.57 — fr:211 : nous ACHETEUR, on transmet
                                  // le paiement au fournisseur. Avant v8.57 :
                                  // fr:212 (encaissée) qui est réservé au VENDEUR.
                                  // Cf. AFNOR CDAR : fr:211 = Payment sent (acheteur),
                                  // fr:212 = Payment received (vendeur).
    refused: LIFECYCLE.refusee    // v8.56 — était bloqué en 503 avant
  };
  const code = map[payload.status];
  if (!code) throw fail(400, "status doit être approved | paid | refused");

  // v8.56 — Le refus AFNOR (fr:210) impose un code motif MDT-113
  // (règle BR-FR-CDV-15). Sans motif, SUPER PDP rejette la requête.
  if (payload.status === "refused") {
    const reason = payload.reason;
    const hasCode = reason && (typeof reason === "string"
      ? reason.trim().length > 0
      : reason.code && String(reason.code).trim().length > 0);
    if (!hasCode) {
      throw fail(400, "Le refus nécessite un code motif MDT-113 (AFNOR XP Z12-012)");
    }
  }

  const row = await sbAdmin.selectOne("pa_inbound_invoices", "id=eq." + payload.inbound_id);
  if (!row || row.company_id !== company.id) throw fail(404, "Facture entrante introuvable");

  const creds = await loadCreds(company.id);
  const { impl, cfg } = getProvider(creds);
  await impl.sendEvent(cfg, row.pa_document_id, code, payload.reason);

  // v8.56 — Statut local reflète l'action réelle (refused ≠ approved).
  const localStatus = payload.status === "refused" ? "refused" : "approved";
  await sbAdmin.update("pa_inbound_invoices", "id=eq." + row.id, {
    status: localStatus,
    pa_ack_status: payload.status,
    pa_ack_sent_at: new Date().toISOString()
  });
  await logEvent({
    company_id: company.id, direction: "inbound", provider: creds.provider,
    pa_document_id: row.pa_document_id, inbound_id: row.id,
    event_type: "invoice." + payload.status, status: payload.status
  });
  return { ok: true };
}

/** Transforme une facture reçue en achat → alimente la TVA déductible. */
export async function paInboxConvert(company, payload) {
  const row = await sbAdmin.selectOne("pa_inbound_invoices", "id=eq." + payload.inbound_id);
  if (!row || row.company_id !== company.id) throw fail(404, "Facture entrante introuvable");
  if (row.purchase_id) return { ok: true, purchase_id: row.purchase_id, already: true };

  const creds = await loadCreds(company.id);
  const { impl, cfg } = getProvider(creds);

  // v8.48.4 — Comptabiliser envoie AUSSI l'approbation au fournisseur (fr:205)
  try {
    await impl.sendEvent(cfg, row.pa_document_id, LIFECYCLE.approuvee);
    await sbAdmin.update("pa_inbound_invoices", "id=eq." + row.id, {
      pa_ack_status: "approved", pa_ack_sent_at: new Date().toISOString()
    });
  } catch (e) {
    console.warn("[PA] ack approuvée échoué à la comptabilisation :", e.message);
  }

  // v8.48.8 — Copie le PDF vers le bucket purchases-attach que PurchasesPage
  // sait lire. Sans ça, le purchase créé n'a pas d'aperçu utilisable.
  // Auto-guérison : si le PDF n'a jamais été récupéré (file_url vide),
  // on le fetch maintenant.
  let purchasesAttachPath = null;
  try {
    let sourcePath = row.file_url;
    let bytes = null;
    let mime = "application/pdf";

    if (sourcePath) {
      // Lire depuis pa-inbound
      const enc = sourcePath.split("/").map(encodeURIComponent).join("/");
      const r = await fetch(SUPA_URL + "/storage/v1/object/pa-inbound/" + enc, {
        headers: { apikey: SR_KEY, Authorization: "Bearer " + SR_KEY }
      });
      if (r.ok) {
        bytes = new Uint8Array(await r.arrayBuffer());
        mime = r.headers.get("content-type") || mime;
      }
    }

    // Si toujours pas de bytes, on retente le fetch depuis la PA
    if (!bytes) {
      const f = await impl.fetchFile(cfg, row.pa_document_id, "pdf");
      bytes = f.bytes;
      mime = f.contentType || mime;
    }

    if (bytes && bytes.length > 100) {
      const filename = (row.invoice_number || row.pa_document_id).replace(/[^a-zA-Z0-9._-]/g, "_") + ".pdf";
      purchasesAttachPath = company.id + "/" + row.pa_document_id + "-" + filename;
      const enc = purchasesAttachPath.split("/").map(encodeURIComponent).join("/");
      const up = await fetch(SUPA_URL + "/storage/v1/object/purchases-attach/" + enc, {
        method: "POST",
        headers: {
          apikey: SR_KEY, Authorization: "Bearer " + SR_KEY,
          "Content-Type": mime, "x-upsert": "true"
        },
        body: bytes
      });
      if (!up.ok) {
        const body = await up.text().catch(() => "");
        console.error("[PA] convert upload purchases-attach " + up.status + " → " + body.slice(0, 300));
        purchasesAttachPath = null;
      }
    }
  } catch (e) {
    console.warn("[PA] convert copy fichier échoué :", e.message);
  }

  const ins = await sbAdmin.insert("purchases", [{
    company_id: company.id,
    vendor_name: row.supplier_name || "Fournisseur inconnu",  // NOT NULL en base
    vendor_siret: row.supplier_siret,
    vendor_vat_number: row.supplier_vat_number,
    number: row.invoice_number,
    issue_date: row.invoice_date,
    due_date: row.due_date,
    subtotal_ht_cents: row.subtotal_ht_cents,
    vat_total_cents: row.vat_total_cents,
    total_ttc_cents: row.total_ttc_cents,
    vat_breakdown: row.vat_breakdown || [],
    currency: row.currency || "EUR",
    source: "api",
    ocr_status: "done",
    status: "pending",
    file_url: purchasesAttachPath, // ⚠️ chemin dans purchases-attach maintenant
    file_mime: "application/pdf",
    notes: "Reçue via plateforme agréée (" + row.provider + ") — doc " + row.pa_document_id
  }]);
  if (!ins || !ins[0]) throw fail(500, "Création de l'achat échouée : " + JSON.stringify(sbAdmin._lastError || {}));

  await sbAdmin.update("pa_inbound_invoices", "id=eq." + row.id, {
    status: "converted", purchase_id: ins[0].id
  });
  return { ok: true, purchase_id: ins[0].id };
}

export async function paInboxFile(company, payload) {
  const row = await sbAdmin.selectOne("pa_inbound_invoices", "id=eq." + payload.inbound_id);
  if (!row || row.company_id !== company.id) throw fail(404, "Introuvable");

  // v8.48.4 — Auto-guérison : si le fichier n'a jamais été stocké
  // (échec silencieux au sync initial), on retente maintenant à la demande.
  let filePath = row.file_url;
  if (!filePath) {
    const creds = await loadCreds(company.id);
    const { impl, cfg } = getProvider(creds);
    filePath = await storeFile(company.id, impl, cfg, row.pa_document_id);
    if (!filePath) throw fail(404, "Fichier indisponible chez la Plateforme Agréée");
    await sbAdmin.update("pa_inbound_invoices", "id=eq." + row.id, { file_url: filePath });
  }

  const enc = filePath.split("/").map(encodeURIComponent).join("/");
  const r = await fetch(SUPA_URL + "/storage/v1/object/sign/" + BUCKET + "/" + enc, {
    method: "POST",
    headers: { apikey: SR_KEY, Authorization: "Bearer " + SR_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 3600 })
  });
  const j = await r.json();
  if (!r.ok) throw fail(500, "Signature échouée : " + JSON.stringify(j));
  return { ok: true, url: SUPA_URL + "/storage/v1" + j.signedURL };
}

/* ══════════════════════════════════════════════════════════════════
   ACTIONS ADMIN (is_admin uniquement)
   ══════════════════════════════════════════════════════════════════ */

export async function paAdminList() {
  // v8.105 — On NE met PAS de `select` explicite : une des colonnes
  // (email, sur l'owner et pas sur la société) n'existe pas → PostgREST 42703 →
  // sbAdmin.select renvoyait [] SILENCIEUSEMENT → companies vide → le modal PDP
  // ne trouvait aucune société → tout retombait sur les valeurs par défaut.
  // On aligne sur l'action admin `list` (sans select) qui, elle, fonctionne.
  const companies = await sbAdmin.select("companies", { order: "created_at.desc", limit: 1000 });
  const creds = await strictSelect("pa_credentials", "select=*");
  const reqs = await strictSelect("pa_credential_requests", "status=eq.pending&select=*&order=created_at.desc");
  const byCompany = {};
  for (const c of creds) byCompany[c.company_id] = publicCfg(c, c.company_id);
  return {
    companies: (companies || []).map(c => ({ ...c, pa: byCompany[c.id] || null })),
    pending_requests: reqs
  };
}

export async function paAdminSave(adminUser, payload) {
  const companyId = payload.company_id;
  if (!companyId) throw fail(400, "company_id manquant");

  const patch = {
    company_id: companyId,
    provider: payload.provider || "superpdp",
    environment: payload.environment || "sandbox",
    base_url: payload.base_url || null,
    enabled: !!payload.enabled,
    self_service_allowed: !!payload.self_service_allowed,
    managed_by_admin: true,
    updated_by: "admin:" + adminUser.id,
    last_error: null
  };
  // v8.101 — Toggle TRANSMISSION indépendant. Réception active dès que le PDP est
  // configuré ; la transmission peut être coupée sans toucher la réception.
  // Si l'UI admin ne l'envoie pas (ancien front), on retombe sur `enabled` →
  // comportement inchangé (actif = transmission possible).
  patch.transmission_enabled = (payload.transmission_enabled !== undefined)
    ? !!payload.transmission_enabled
    : !!payload.enabled;
  if (payload.client_id) patch.client_id = payload.client_id;
  if (payload.client_secret) patch.client_secret = payload.client_secret;
  if (payload.webhook_secret) patch.webhook_secret = payload.webhook_secret;

  await upsert("pa_credentials", [patch], "company_id");
  await logEvent({
    company_id: companyId, direction: "admin", event_type: "credentials.admin_updated",
    status: "ok", message: "self_service=" + patch.self_service_allowed + " enabled=" + patch.enabled + " transmission=" + patch.transmission_enabled
  });
  return { ok: true };
}

export async function paAdminToggleSelfService(adminUser, payload) {
  const allow = !!payload.self_service_allowed;
  await sbAdmin.update("pa_credentials", "company_id=eq." + payload.company_id, {
    self_service_allowed: allow, updated_by: "admin:" + adminUser.id
  });
  await logEvent({
    company_id: payload.company_id, direction: "admin",
    event_type: allow ? "selfservice.enabled" : "selfservice.disabled", status: "ok"
  });
  return { ok: true, self_service_allowed: allow };
}

export async function paAdminTest(payload) {
  const creds = await loadCreds(payload.company_id, { requireEnabled: false });
  const { impl, cfg } = getProvider(creds);
  try {
    await impl.auth(cfg);
    const me = await impl.me(cfg).catch(() => null);
    await sbAdmin.update("pa_credentials", "company_id=eq." + payload.company_id, {
      last_error: null, last_auth_ok_at: new Date().toISOString()
    });
    return { ok: true, message: "Authentification réussie" + (me?.formal_name ? " — " + me.formal_name : "") };
  } catch (e) {
    await sbAdmin.update("pa_credentials", "company_id=eq." + payload.company_id, {
      last_error: String(e.message).slice(0, 500)
    });
    return { ok: false, message: e.message };
  }
}

export async function paAdminResolveRequest(adminUser, payload) {
  const status = payload.status === "done" ? "done" : "rejected";
  await sbAdmin.update("pa_credential_requests", "id=eq." + payload.request_id, {
    status, admin_note: payload.admin_note || null,
    resolved_at: new Date().toISOString(), resolved_by: adminUser.id
  });
  return { ok: true };
}

/* ══════════════════════════════════════════════════════════════════
   WEBHOOK (monté dans public.js — NON authentifié, HMAC obligatoire)
   ══════════════════════════════════════════════════════════════════ */

export async function paWebhook(companyId, rawBody, headers) {
  if (!companyId) return { status: 400, body: { error: "company_id manquant" } };

  const rows = await strictSelect("pa_credentials", "company_id=eq." + companyId + "&select=*&limit=1");
  const creds = rows[0];
  if (!creds) return { status: 404, body: { error: "inconnu" } };
  if (!creds.webhook_secret) return { status: 401, body: { error: "webhook non armé" } };

  const { impl, cfg } = getProvider(creds);
  const lower = {};
  for (const k of Object.keys(headers || {})) lower[k.toLowerCase()] = headers[k];

  const evt = await impl.parseWebhook(cfg, rawBody, lower);
  if (!evt.valid) {
    console.warn("[PA webhook] rejeté :", evt.reason, "company", companyId);
    return { status: 401, body: { error: "signature invalide" } };
  }

  if (evt.direction === "inbound") {
    let item = null;
    try {
      item = await impl.getInvoice(cfg, evt.pa_document_id);
    } catch (e) { console.warn("[PA webhook] getInvoice", e.message); }
    if (item) await persistInbound(companyId, creds, impl, cfg, item);
  } else {
    const inv = await sbAdmin.selectOne("invoices", "pdp_transmission_id=eq." + encodeURIComponent(evt.pa_document_id));
    if (inv) {
      // v8.57.8 — Mapping événement unique reçu → facturx_status.
      // Un webhook reçoit un seul event, on ne peut pas voir tout l'historique.
      // Règle : on ne dégrade JAMAIS un statut plus terminal vers un moins
      // terminal. Ex : si on a déjà "paid" et qu'on reçoit un fr:205 en
      // retard, on ne repasse pas à "accepted".
      const c = evt.status_code;
      const RANK = { transmitted: 0, accepted: 1, payment_sent: 2, paid: 3, rejected: 99 };
      const REJECT_CODES = new Set([LIFECYCLE.refusee, LIFECYCLE.rejetee, LIFECYCLE.irrecevable]);
      let newFx = null;
      if (REJECT_CODES.has(c))              newFx = "rejected";
      else if (c === LIFECYCLE.encaissee)   newFx = "paid";
      else if (c === LIFECYCLE.paiement_tx) newFx = "payment_sent";
      else if (c === LIFECYCLE.approuvee)   newFx = "accepted";

      if (newFx) {
        const currentRank = RANK[inv.facturx_status] ?? -1;
        const newRank = RANK[newFx];
        // Rejet toujours prioritaire, sinon on n'écrase que si "plus terminal"
        if (newFx === "rejected" || newRank > currentRank) {
          await sbAdmin.update("invoices", "id=eq." + inv.id, { facturx_status: newFx });
        }
      }
      await logEvent({
        company_id: inv.company_id, direction: "outbound", provider: creds.provider,
        pa_document_id: evt.pa_document_id, invoice_id: inv.id,
        event_type: evt.event, status: c, payload: evt.payload
      });
    }
  }
  return { status: 200, body: { ok: true } };
}

// ═══════════════════════════════════════════════════════════════════
// v8.57 — fr:212 Encaissée (VENDEUR déclare avoir reçu le paiement)
// ═══════════════════════════════════════════════════════════════════
// Envoyé pour une facture ÉMISE passée à `paid`. Utilisé pour :
//   1. Cycle de vie AFNOR B2B (le vendeur confirme au PPF et au client
//      qu'il a reçu le paiement — signal fiscal important).
//   2. E-reporting des factures B2C (SUPER PDP extrait automatiquement
//      les données de paiement à partir de ce message).
//
// Idempotent : si `pa_ack_status = "paid"` sur la ligne pa_events la plus
// récente pour cette facture → on skippe. Best-effort : erreurs loguées
// mais l'API répond quand même OK pour le caller.
//
// Payload attendu : { invoice_id: <uuid> }
export async function paInvoiceEncaisser(company, payload) {
  const invoiceId = payload.invoice_id;
  if (!invoiceId) throw fail(400, "invoice_id manquant");

  const inv = await sbAdmin.selectOne("invoices", "id=eq." + invoiceId);
  if (!inv) throw fail(404, "Facture introuvable");
  if (inv.company_id !== company.id) throw fail(403, "Facture hors périmètre");

  // Skip silencieux si la facture n'est pas transmise à un PDP.
  if (!inv.pdp_transmission_id) {
    return { ok: true, skipped: "not_transmitted" };
  }

  // Idempotence : cherche un event.paid déjà émis pour cette facture.
  const existingEvents = await sbAdmin.select("pa_events", {
    filter: "invoice_id=eq." + inv.id + "&event_type=eq.invoice.paid",
    limit: 1
  });
  if (Array.isArray(existingEvents) && existingEvents.length > 0) {
    return { ok: true, skipped: "already_sent" };
  }

  // Date d'encaissement = MAX(payments.paid_at). Sinon aujourd'hui.
  let paymentDate = new Date().toISOString().slice(0, 10);
  const payments = await sbAdmin.select("payments", {
    filter: "invoice_id=eq." + inv.id,
    order: "paid_at.desc",
    limit: 1
  });
  if (Array.isArray(payments) && payments.length > 0 && payments[0].paid_at) {
    paymentDate = String(payments[0].paid_at).slice(0, 10);
  }

  const currency = inv.currency || "EUR";

  // v8.57.11 — Reconstruction du breakdown TVA.
  //
  // Problème observé : `invoices.vat_breakdown` est un array vide `[]` sur les
  // factures existantes, ce qui déclenchait un fallback foireux calculant un
  // taux "moyen" (vat_total / subtotal_ht × 100 = 12.52%) — non conforme
  // fiscalement en France où les taux sont 0/2.1/5.5/10/20.
  //
  // Fix : si `vat_breakdown` est vide/absent, on RECONSTRUIT le breakdown
  // à partir des lignes de la facture (`document_lines`). Chaque ligne a
  // `vat_rate`, `line_ht_cents`, `line_vat_cents` — on agrège par taux.
  //
  // Cas gérés :
  //   - vat_breakdown array non vide → utilisé tel quel
  //   - vat_breakdown array vide OU null → reconstruction depuis lignes
  //   - Pas de lignes en base (edge case) → fallback global
  let breakdown = Array.isArray(inv.vat_breakdown) ? inv.vat_breakdown : [];

  if (breakdown.length === 0) {
    const docLines = await sbAdmin.select("document_lines", {
      filter: "document_type=eq.invoice&document_id=eq." + inv.id,
      order: "sort_order.asc"
    });
    if (Array.isArray(docLines) && docLines.length > 0) {
      const byRate = {};
      for (const l of docLines) {
        const rate = Number(l.vat_rate || 0);
        const key = rate.toFixed(2);
        if (!byRate[key]) byRate[key] = { rate, base_cents: 0, vat_cents: 0 };
        byRate[key].base_cents += Number(l.line_ht_cents || 0);
        byRate[key].vat_cents  += Number(l.line_vat_cents || 0);
      }
      breakdown = Object.values(byRate);
      console.log("[PA] fr:212 breakdown reconstruit depuis " + docLines.length
        + " lignes → " + breakdown.length + " taux distinct(s)");
    }
  }

  const reportedData = [];

  if (breakdown.length > 0) {
    for (const br of breakdown) {
      const base  = Number(br.base_cents || 0);
      const vat   = Number(br.vat_cents || 0);
      const rate  = Number(br.rate || 0);
      const cents = base + vat;
      if (cents <= 0) continue;
      reportedData.push({
        type_code: "MEN",
        amount: (cents / 100).toFixed(2),
        currency_code: currency,
        date: paymentDate,
        value_percent: rate.toFixed(2)
      });
    }
  }

  // Fallback ultime : pas de breakdown et pas de lignes → un seul bloc MEN
  // au taux global calculé (rare, uniquement si la facture n'a plus de lignes).
  if (reportedData.length === 0) {
    const totalCents  = Number(inv.grand_total_cents || inv.total_ttc_cents || 0);
    const subHtCents  = Number(inv.subtotal_ht_cents || 0);
    const vatCents    = Number(inv.vat_total_cents || 0);
    const globalRate  = subHtCents > 0 ? (vatCents / subHtCents) * 100 : 0;
    reportedData.push({
      type_code: "MEN",
      amount: (totalCents / 100).toFixed(2),
      currency_code: currency,
      date: paymentDate,
      value_percent: globalRate.toFixed(2)
    });
    console.warn("[PA] fr:212 fallback global taux=" + globalRate.toFixed(2)
      + "% — vérifier vat_breakdown facture " + inv.id);
  }

  const detail = { reported_data: reportedData };

  const creds = await loadCreds(company.id);
  const { impl, cfg } = getProvider(creds);
  try {
    await impl.sendEvent(cfg, inv.pdp_transmission_id, LIFECYCLE.encaissee, detail);

    // v8.57.11 — Update `facturx_status = "paid"` en base IMMÉDIATEMENT
    // après le succès SUPER PDP. Évite la fenêtre de race où :
    //   1. sendEvent réussit (fr:212 accepté par SUPER PDP)
    //   2. le frontend perd le retour (401 refresh token, timeout, onglet fermé...)
    //   3. la base reste avec facturx_status = payment_sent
    //   4. l'utilisateur voit un badge incohérent avec la réalité SUPER PDP
    // Le patch en place côté frontend devient purement cosmétique.
    await sbAdmin.update("invoices", "id=eq." + inv.id, { facturx_status: "paid" });

    const summary = reportedData
      .map((r) => r.amount + " @ " + r.value_percent + "%")
      .join(" + ");
    await logEvent({
      company_id: company.id, direction: "outbound", provider: creds.provider,
      pa_document_id: inv.pdp_transmission_id, invoice_id: inv.id,
      event_type: "invoice.paid", status: "paid",
      message: "fr:212 encaissée · " + summary + " " + currency + " · " + paymentDate
    });
    return { ok: true };
  } catch (e) {
    console.warn("[PA] fr:212 échoué :", e.message);
    // Best-effort : erreur loguée, l'appelant n'est pas bloqué.
    return { ok: false, message: e.message };
  }
}

export async function paPurchasePaid(company, payload) {
  // au fournisseur fr:211 (Paiement transmis). Avant v8.57 on envoyait à
  // tort fr:212 (Encaissée) qui est réservé au VENDEUR. Cf. AFNOR CDAR :
  //   fr:211 = Payment sent — l'ACHETEUR déclare "j'ai payé"
  //   fr:212 = Payment received — le VENDEUR déclare "j'ai encaissé"
  //
  // Note : cette fonction est appelée en fire-and-forget depuis PurchasesPage
  // et depuis la conversion. Elle est idempotente : si l'ack a déjà été
  // envoyé, on skippe silencieusement.
  const purchaseId = payload.purchase_id;
  if (!purchaseId) throw fail(400, "purchase_id manquant");

  const row = await sbAdmin.selectOne(
    "pa_inbound_invoices",
    "company_id=eq." + company.id + "&purchase_id=eq." + purchaseId
  );
  if (!row) {
    // Silencieux : l'achat n'est pas issu de la PA, rien à faire.
    return { ok: true, skipped: "not_from_pa" };
  }
  if (row.pa_ack_status === "paid") {
    return { ok: true, skipped: "already_paid" };
  }

  const creds = await loadCreds(company.id);
  const { impl, cfg } = getProvider(creds);
  try {
    await impl.sendEvent(cfg, row.pa_document_id, LIFECYCLE.paiement_tx);
    await sbAdmin.update("pa_inbound_invoices", "id=eq." + row.id, {
      pa_ack_status: "paid", pa_ack_sent_at: new Date().toISOString()
    });
    await logEvent({
      company_id: company.id, direction: "inbound", provider: creds.provider,
      pa_document_id: row.pa_document_id, inbound_id: row.id,
      event_type: "invoice.payment_sent", status: "paid"
    });
    return { ok: true };
  } catch (e) {
    console.warn("[PA] fr:211 échoué :", e.message);
    return { ok: false, message: e.message };
  }
}



/* ══════════════════════════════════════════════════════════════════
   RACCORDEMENT D'UNE SOCIÉTÉ (OAuth2 + annuaire)
   ══════════════════════════════════════════════════════════════════ */

/** SIREN à 9 chiffres extrait du SIRET stocké sur la société. */
function sirenOf(company) {
  const raw = String(company?.siret || "").replace(/\D/g, "");
  if (raw.length === 14) return raw.slice(0, 9);
  if (raw.length === 9) return raw;
  return null;
}

/** Étape 1 — renvoie l'URL du tunnel SUPER PDP à ouvrir dans le navigateur. */
export async function paOauthStart(company, payload = {}) {
  requireOauthApp();

  const siren = sirenOf(company);
  if (!siren) {
    throw fail(400, "SIRET de la société manquant ou invalide : "
      + "renseignez-le dans Réglages avant de vous raccorder.");
  }

  const existing = await sbAdmin.selectOne("pa_credentials", "company_id=eq." + company.id);
  const environment = payload.environment
    || existing?.environment
    || "production";

  // `state` : anti-CSRF ET porteur du lien vers la société, puisque le
  // callback arrive du navigateur sans jeton d'application.
  const state = crypto.randomUUID().replace(/-/g, "")
              + crypto.randomUUID().replace(/-/g, "");

  await upsert("pa_credentials", [{
    company_id: company.id,
    provider: "superpdp",
    environment,
    auth_mode: "authorization_code",
    oauth_state: state,
    oauth_state_at: new Date().toISOString(),
    self_service_allowed: existing ? existing.self_service_allowed : false,
    enabled: existing ? existing.enabled : false,
    updated_by: "oauth"
  }], "company_id");

  const { impl, cfg } = getProvider({
    company_id: company.id, provider: "superpdp", environment
  });

  // `receive` force l'inscription à l'annuaire pendant le tunnel : sans ligne
  // d'annuaire, la société ne peut RECEVOIR aucune facture. C'est le rôle
  // d'IO BILL (émission ET réception), donc on ne laisse pas le choix.
  const sendAndReceive = ["any", "send", "receive"].includes(payload.send_and_receive)
    ? payload.send_and_receive
    : "receive";

  const url = impl.oauthAuthorizeUrl(cfg, {
    clientId: OAUTH_CLIENT_ID,
    redirectUri: oauthRedirectUri(),
    state,
    loginHint: payload.email || company.email || null,
    companyNumber: siren,
    companyNumberScheme: environment === "production" ? "fr_siren" : "sandbox",
    directoryEntryIdentifier: siren,
    sendAndReceive
  });

  await logEvent({
    company_id: company.id, direction: "admin", provider: "superpdp",
    event_type: "oauth.start", status: "ok",
    message: "Tunnel de raccordement ouvert (" + environment + ", " + sendAndReceive + ")"
  });

  return { ok: true, url, environment, redirect_uri: oauthRedirectUri() };
}

/** Étape 2 — appelée par le navigateur au retour du tunnel (non authentifié :
    c'est le `state` qui prouve l'origine et désigne la société). */
export async function paOauthCallback({ code, state, error, errorDescription }) {
  if (error) {
    return { ok: false, message: "Raccordement refusé : " + (errorDescription || error) };
  }
  if (!code || !state) return { ok: false, message: "Réponse incomplète de la plateforme." };

  const row = await sbAdmin.selectOne("pa_credentials", "oauth_state=eq." + encodeURIComponent(state));
  if (!row) return { ok: false, message: "Demande de raccordement inconnue ou déjà utilisée." };

  const age = Date.now() - Date.parse(row.oauth_state_at || 0);
  if (!(age >= 0) || age > 3600_000) {
    await sbAdmin.update("pa_credentials", "company_id=eq." + row.company_id,
      { oauth_state: null, oauth_state_at: null });
    return { ok: false, message: "Demande expirée. Relancez le raccordement." };
  }

  requireOauthApp();
  const { impl, cfg } = getProvider(row);

  let tok;
  try {
    tok = await impl.oauthExchangeCode(cfg, {
      code,
      clientId: OAUTH_CLIENT_ID,
      clientSecret: OAUTH_CLIENT_SECRET,
      redirectUri: oauthRedirectUri()
    });
  } catch (e) {
    await sbAdmin.update("pa_credentials", "company_id=eq." + row.company_id,
      { oauth_state: null, oauth_state_at: null, last_error: "Échange OAuth2 échoué : " + e.message });
    return { ok: false, message: "Échange du code échoué : " + e.message };
  }

  const patch = {
    ...tokenPatch(tok),
    auth_mode: "authorization_code",
    oauth_state: null,
    oauth_state_at: null,
    oauth_linked_at: new Date().toISOString(),
    enabled: true
  };
  await sbAdmin.update("pa_credentials", "company_id=eq." + row.company_id, patch);

  // Best-effort : on remonte immédiatement l'identité et l'état de vérification.
  try {
    const live = { ...row, ...patch };
    const p = getProvider(live);
    const [me, sess] = await Promise.all([
      p.impl.me(p.cfg).catch(() => null),
      p.impl.session(p.cfg).catch(() => null)
    ]);
    const extra = {};
    if (me?.id) extra.pa_company_id = String(me.id);
    if (sess?.company_verification_status) extra.company_verification_status = sess.company_verification_status;
    if (sess?.user_identity_verification_status) extra.user_identity_verification_status = sess.user_identity_verification_status;
    if (Object.keys(extra).length) {
      await sbAdmin.update("pa_credentials", "company_id=eq." + row.company_id, extra);
    }
  } catch (_) { /* le statut sera relu depuis l'écran de réglages */ }

  await logEvent({
    company_id: row.company_id, direction: "admin", provider: "superpdp",
    event_type: "oauth.linked", status: "ok", message: "Compte raccordé par OAuth2"
  });

  return { ok: true, company_id: row.company_id };
}

/** État vivant du raccordement : vérification KYC/KYB + lignes d'annuaire. */
export async function paOauthStatus(company) {
  const creds = await loadCreds(company.id, { requireEnabled: false });
  if (creds.auth_mode !== "authorization_code") {
    return { ok: true, auth_mode: creds.auth_mode, linked: false };
  }
  if (!creds.access_token) {
    return { ok: true, auth_mode: creds.auth_mode, linked: false };
  }

  const fresh = await ensureAccessToken(creds);
  const { impl, cfg } = getProvider(fresh);

  let session = null, entries = null, sessionError = null;
  try {
    session = await impl.session(cfg);
  } catch (e) { sessionError = e.message; }

  // Tant que la KYB n'est pas `verified`, toutes les autres routes renvoient 403.
  if (session && session.company_verification_status === "verified") {
    try { entries = await impl.listDirectoryEntries(cfg); }
    catch (e) { sessionError = sessionError || e.message; }
  }

  if (session) {
    await sbAdmin.update("pa_credentials", "company_id=eq." + company.id, {
      company_verification_status: session.company_verification_status || null,
      user_identity_verification_status: session.user_identity_verification_status || null
    });
  }

  return {
    ok: true,
    auth_mode: "authorization_code",
    linked: true,
    linked_at: fresh.oauth_linked_at,
    environment: fresh.environment,
    session,
    directory_entries: entries,
    error: sessionError
  };
}

/** Inscrit la société à l'annuaire (utile si le tunnel a été fait en mode
    `any` ou `send`, ou pour ajouter une adresse SIRET). */
export async function paDirectoryCreate(company, payload = {}) {
  const creds = await loadCreds(company.id);
  const { impl, cfg } = getProvider(creds);

  const identifier = String(payload.identifier || sirenOf(company) || "").trim();
  if (!identifier) throw fail(400, "Identifiant d'annuaire manquant (SIREN attendu).");

  const directory = payload.directory === "peppol" ? "peppol" : "ppf";
  const entry = await impl.createDirectoryEntry(cfg, {
    directory,
    identifier,
    effectiveDate: payload.effective_date || null
  });

  await sbAdmin.update("pa_credentials", "company_id=eq." + company.id, {
    directory_identifier: entry?.identifier || identifier,
    directory_status: entry?.status || "pending"
  });
  await logEvent({
    company_id: company.id, direction: "admin", provider: creds.provider,
    event_type: "directory.created", status: "ok",
    message: directory + " · " + identifier + " · " + (entry?.status || "pending")
  });
  return { ok: true, entry };
}

/** Régime de TVA : il commande le RYTHME d'agrégation de l'e-reporting PPF. */
export async function paVatRegimeSave(company, payload = {}) {
  const valid = ["monthly", "quarterly", "simplified", "vat_exemption"];
  if (!valid.includes(payload.vat_regime)) {
    throw fail(400, "Régime de TVA invalide. Attendu : " + valid.join(", "));
  }
  const creds = await loadCreds(company.id);
  const { impl, cfg } = getProvider(creds);
  const out = await impl.updateVatRegime(cfg, {
    vatRegime: payload.vat_regime,
    hasVatOnDebits: payload.has_vat_on_debits === undefined ? null : !!payload.has_vat_on_debits
  });
  await logEvent({
    company_id: company.id, direction: "admin", provider: creds.provider,
    event_type: "company.vat_regime", status: "ok", message: payload.vat_regime
  });
  return { ok: true, company: out };
}

/** Débranche la société : révoque le refresh_token puis efface les jetons. */
export async function paOauthUnlink(company) {
  const creds = await loadCreds(company.id, { requireEnabled: false });
  if (creds.auth_mode === "authorization_code" && creds.refresh_token && OAUTH_CLIENT_ID) {
    const { impl, cfg } = getProvider(creds);
    try {
      await impl.oauthRevoke(cfg, {
        token: creds.refresh_token,
        clientId: OAUTH_CLIENT_ID,
        clientSecret: OAUTH_CLIENT_SECRET
      });
    } catch (_) { /* la révocation est best-effort, l'effacement local prime */ }
  }
  await sbAdmin.update("pa_credentials", "company_id=eq." + company.id, {
    access_token: null, refresh_token: null, token_expires_at: null,
    oauth_state: null, oauth_state_at: null, oauth_linked_at: null,
    company_verification_status: null, user_identity_verification_status: null,
    enabled: false
  });
  await logEvent({
    company_id: company.id, direction: "admin", provider: creds.provider,
    event_type: "oauth.unlinked", status: "ok", message: "Compte débranché"
  });
  return { ok: true };
}

export const PA_SUBSCRIBER_ACTIONS = new Set([
  "pa_config", "pa_config_save", "pa_request_change",
  "pa_validate", "pa_send", "pa_status",
  "pa_inbox_sync", "pa_inbox_ack", "pa_inbox_convert", "pa_inbox_file",
  "pa_purchase_paid",
  "pa_invoice_encaisser",  // v8.57 — fr:212 côté vendeur
  // v8.130 — Raccordement OAuth2 du compte client + annuaire PPF
  "pa_oauth_start", "pa_oauth_status", "pa_oauth_unlink",
  "pa_directory_create", "pa_vat_regime"
]);

export const PA_ADMIN_ACTIONS = new Set([
  "pa_admin_list", "pa_admin_save", "pa_admin_toggle_selfservice",
  "pa_admin_test", "pa_admin_resolve_request"
]);

export async function handlePaAction({ action, payload, user, company, isAdmin }) {
  switch (action) {
    case "pa_config":          return paConfigGet(company);
    case "pa_config_save":     return paConfigSaveBySubscriber(company, payload || {});
    case "pa_request_change":  return paRequestChange(user, company, payload || {});
    case "pa_validate":        return paValidateInvoice(company, payload || {});
    case "pa_send":            return paSendInvoice(company, payload || {});
    case "pa_status":          return paInvoiceStatus(company, payload || {});
    case "pa_inbox_sync":      return paInboxSync(company);
    case "pa_inbox_ack":       return paInboxAck(company, payload || {});
    case "pa_inbox_convert":   return paInboxConvert(company, payload || {});
    case "pa_inbox_file":      return paInboxFile(company, payload || {});
    case "pa_purchase_paid":   return paPurchasePaid(company, payload || {});
    case "pa_invoice_encaisser": return paInvoiceEncaisser(company, payload || {});
    case "pa_oauth_start":     return paOauthStart(company, payload || {});
    case "pa_oauth_status":    return paOauthStatus(company);
    case "pa_oauth_unlink":    return paOauthUnlink(company);
    case "pa_directory_create":return paDirectoryCreate(company, payload || {});
    case "pa_vat_regime":      return paVatRegimeSave(company, payload || {});
  }
  if (!isAdmin) throw fail(403, "Accès refusé (admin uniquement)");
  switch (action) {
    case "pa_admin_list":                 return paAdminList();
    case "pa_admin_save":                 return paAdminSave(user, payload || {});
    case "pa_admin_toggle_selfservice":   return paAdminToggleSelfService(user, payload || {});
    case "pa_admin_test":                 return paAdminTest(payload || {});
    case "pa_admin_resolve_request":      return paAdminResolveRequest(user, payload || {});
  }
  throw fail(400, "Action PA inconnue : " + action);
}
