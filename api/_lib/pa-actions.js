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

async function loadCreds(companyId, { requireEnabled = true } = {}) {
  const rows = await strictSelect("pa_credentials", "company_id=eq." + companyId + "&select=*&limit=1");
  const c = rows[0];
  if (!c) throw fail(400, "Plateforme agréée non configurée pour cette entreprise");
  if (requireEnabled && !c.enabled) throw fail(400, "Plateforme agréée désactivée");
  if (requireEnabled && !c.client_id) throw fail(400, "client_id manquant");
  return c;
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
    enabled: c.enabled,
    self_service_allowed: c.self_service_allowed === true,
    managed_by_admin: c.managed_by_admin === true,
    has_client_secret: !!c.client_secret,
    has_webhook_secret: !!c.webhook_secret,
    client_id: c.client_id || null,
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

  await logEvent({
    company_id: company.id, direction: "outbound", invoice_id: inv.id,
    event_type: "invoice.validated", status: rep.is_valid ? "valid" : "invalid",
    message: rep.profile || null, payload: { errors: (rep.errors || []).slice(0, 20) }
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
  const { impl, cfg } = getProvider(creds);

  try {
    const out = await impl.sendInvoice(cfg, {
      bytes, contentType: "application/pdf", filename: (inv.number || "facture") + ".pdf"
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
  const code = j.status_code || j.latest_status_code || null;

  const fx = code === LIFECYCLE.refusee || code === LIFECYCLE.rejetee ? "rejected"
           : code === LIFECYCLE.approuvee || code === LIFECYCLE.encaissee ? "accepted"
           : "transmitted";
  await sbAdmin.update("invoices", "id=eq." + inv.id, { facturx_status: fx });

  return { ok: true, status_code: code, facturx_status: fx, raw: j };
}

/* ─── Réception ─────────────────────────────────────────────────── */

async function storeFile(companyId, impl, cfg, paDocId) {
  try {
    const f = await impl.fetchFile(cfg, paDocId, "pdf");
    const path = companyId + "/" + paDocId + "." + f.ext;
    const enc = path.split("/").map(encodeURIComponent).join("/");
    const r = await fetch(SUPA_URL + "/storage/v1/object/" + BUCKET + "/" + enc, {
      method: "POST",
      headers: {
        apikey: SR_KEY, Authorization: "Bearer " + SR_KEY,
        "Content-Type": f.contentType, "x-upsert": "true"
      },
      body: f.bytes
    });
    return r.ok ? path : null;
  } catch (e) {
    console.warn("[PA] fichier indisponible", e.message);
    return null;
  }
}

async function persistInbound(companyId, creds, impl, cfg, item) {
  const norm = normalizeInbound(item, creds.provider);
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

  const { items, cursor } = await impl.listInvoices(cfg, {
    cursor: creds.cursor_id || null, order: "asc", limit: 50
  });

  let created = 0;
  for (const it of items) {
    // On ne garde que les factures d'ACHAT (reçues), pas nos propres ventes.
    const dir = String(it.direction || it.type || it.kind || "").toLowerCase();
    if (dir && /sale|vente|outbound|sent/.test(dir)) continue;
    const r = await persistInbound(company.id, creds, impl, cfg, it);
    if (r) created++;
  }
  if (cursor && cursor !== creds.cursor_id) {
    await sbAdmin.update("pa_credentials", "company_id=eq." + company.id, { cursor_id: cursor });
  }
  return { ok: true, fetched: items.length, created, cursor };
}

export async function paInboxAck(company, payload) {
  const map = { approved: LIFECYCLE.approuvee, refused: LIFECYCLE.refusee, paid: LIFECYCLE.encaissee };
  const code = map[payload.status];
  if (!code) throw fail(400, "status doit être approved | refused | paid");

  const row = await sbAdmin.selectOne("pa_inbound_invoices", "id=eq." + payload.inbound_id);
  if (!row || row.company_id !== company.id) throw fail(404, "Facture entrante introuvable");
  if (payload.status === "refused" && !String(payload.reason || "").trim()) {
    throw fail(400, "Motif obligatoire pour un refus");
  }

  const creds = await loadCreds(company.id);
  const { impl, cfg } = getProvider(creds);
  await impl.sendEvent(cfg, row.pa_document_id, code, payload.reason);

  await sbAdmin.update("pa_inbound_invoices", "id=eq." + row.id, {
    status: payload.status === "refused" ? "refused" : "approved",
    refusal_reason: payload.status === "refused" ? payload.reason : null,
    pa_ack_status: payload.status, pa_ack_sent_at: new Date().toISOString()
  });
  await logEvent({
    company_id: company.id, direction: "inbound", provider: creds.provider,
    pa_document_id: row.pa_document_id, inbound_id: row.id,
    event_type: "invoice." + payload.status, status: payload.status,
    message: payload.reason || null
  });
  return { ok: true };
}

/** Transforme une facture reçue en achat → alimente la TVA déductible. */
export async function paInboxConvert(company, payload) {
  const row = await sbAdmin.selectOne("pa_inbound_invoices", "id=eq." + payload.inbound_id);
  if (!row || row.company_id !== company.id) throw fail(404, "Facture entrante introuvable");
  if (row.purchase_id) return { ok: true, purchase_id: row.purchase_id, already: true };

  const ins = await sbAdmin.insert("purchases", [{
    company_id: company.id,
    supplier_name: row.supplier_name,
    invoice_number: row.invoice_number,
    purchase_date: row.invoice_date,
    subtotal_ht_cents: row.subtotal_ht_cents,
    vat_total_cents: row.vat_total_cents,
    total_ttc_cents: row.total_ttc_cents,
    vat_breakdown: row.vat_breakdown,
    currency: row.currency || "EUR",
    file_url: row.file_url,   // ⚠️ purchases = file_url, PAS pdf_url
    status: "to_pay"
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
  if (!row.file_url) throw fail(404, "Fichier absent");

  const enc = row.file_url.split("/").map(encodeURIComponent).join("/");
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
  const companies = await sbAdmin.select("companies", { order: "created_at.desc", limit: 1000, select: "id,name,siret,email,is_active" });
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
  if (payload.client_id) patch.client_id = payload.client_id;
  if (payload.client_secret) patch.client_secret = payload.client_secret;
  if (payload.webhook_secret) patch.webhook_secret = payload.webhook_secret;

  await upsert("pa_credentials", [patch], "company_id");
  await logEvent({
    company_id: companyId, direction: "admin", event_type: "credentials.admin_updated",
    status: "ok", message: "self_service=" + patch.self_service_allowed + " enabled=" + patch.enabled
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
      const c = evt.status_code;
      const fx = c === LIFECYCLE.refusee || c === LIFECYCLE.rejetee ? "rejected"
               : c === LIFECYCLE.approuvee || c === LIFECYCLE.encaissee ? "accepted"
               : "transmitted";
      await sbAdmin.update("invoices", "id=eq." + inv.id, { facturx_status: fx });
      await logEvent({
        company_id: inv.company_id, direction: "outbound", provider: creds.provider,
        pa_document_id: evt.pa_document_id, invoice_id: inv.id,
        event_type: evt.event, status: c, payload: evt.payload
      });
    }
  }
  return { status: 200, body: { ok: true } };
}

/* ─── Routeur monté dans admin.js ──────────────────────────────── */

export const PA_SUBSCRIBER_ACTIONS = new Set([
  "pa_config", "pa_config_save", "pa_request_change",
  "pa_validate", "pa_send", "pa_status",
  "pa_inbox_sync", "pa_inbox_ack", "pa_inbox_convert", "pa_inbox_file"
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
