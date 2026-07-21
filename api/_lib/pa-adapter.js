// IO BILL — api/_lib/pa-adapter.js
// ════════════════════════════════════════════════════════════════════
// Adapter Plateforme Agréée (PA / ex-PDP).
// Préfixe underscore ⇒ Vercel ne le compte PAS comme fonction serverless.
//
// Endpoints SUPER PDP vérifiés sur leur quick_start.js officiel :
//   POST /oauth2/token                          (form-urlencoded)
//   GET  /v1.beta/companies/me
//   POST /v1.beta/invoices                      (body = XML ou PDF brut)
//   GET  /v1.beta/invoices?starting_after_id=N
//   GET  /v1.beta/invoices/{id}
//   POST /v1.beta/invoice_events                ({invoice_id, status_code})
//   POST /v1.beta/validation_reports            (multipart, file)
//
// Interface commune (tout provider doit l'implémenter) :
//   auth, sendInvoice, getInvoice, listInvoices, sendEvent,
//   validate, fetchFile, parseWebhook
// ════════════════════════════════════════════════════════════════════

const TOKEN_CACHE = new Map();
const nowSec = () => Math.floor(Date.now() / 1000);

/* ─── Statuts cycle de vie AFNOR (codes fr:2xx) ────────────────────
   ⚠️ À reconfirmer dans la doc SUPER PDP : ce mapping est le seul
   endroit à corriger si un code diffère.                            */
export const LIFECYCLE = {
  deposee:      "fr:200",
  rejetee:      "fr:201",
  recue:        "fr:202",
  mise_a_dispo: "fr:203",
  prise_charge: "fr:204",
  approuvee:    "fr:205",
  approuvee_p:  "fr:206",
  litige:       "fr:207",
  suspendue:    "fr:208",
  completee:    "fr:209",
  refusee:      "fr:210",
  paiement_tx:  "fr:211",
  encaissee:    "fr:212"
};

/* ─── HTTP ────────────────────────────────────────────────────────── */

async function req(url, opts = {}) {
  const r = await fetch(url, opts);
  const txt = await r.text();
  let body = null;
  try { body = txt ? JSON.parse(txt) : null; } catch { body = { raw: txt }; }
  if (!r.ok) {
    const msg = (body && (body.message || body.error_description || body.error || body.detail)) || ("HTTP " + r.status);
    const e = new Error("[PA] " + msg);
    e.status = r.status;
    e.body = body;
    throw e;
  }
  return body;
}

/* ─── HMAC (WebCrypto, dispo Node 18+) ────────────────────────────── */

export async function hmacHex(secret, raw) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(raw));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ─── Normalisation EN 16931 → modèle IO BILL (cents) ─────────────── */

function toCents(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : Number(v);
  return isFinite(n) ? Math.round(n * 100) : 0;
}

/**
 * L'objet renvoyé par SUPER PDP contient `en_invoice` déjà parsé
 * en EN 16931. On mappe vers les colonnes IO BILL.
 */
export function normalizeInbound(raw, provider) {
  const en = raw.en_invoice || raw.enInvoice || {};
  const seller = en.seller || en.accounting_supplier_party || {};
  const totals = en.totals || en.legal_monetary_total || {};

  return {
    provider,
    pa_document_id: String(raw.id ?? raw.invoice_id ?? ""),
    supplier_name:       seller.name || seller.legal_name || raw.seller_name || null,
    supplier_siren:      seller.siren || null,
    supplier_siret:      seller.siret || seller.identifier || null,
    supplier_vat_number: seller.vat_number || seller.vat_identifier || null,
    invoice_number: en.number || en.id || raw.number || null,
    invoice_date:   (en.issue_date || raw.issue_date || "").slice(0, 10) || null,
    due_date:       (en.due_date || raw.due_date || "").slice(0, 10) || null,
    currency: en.currency || en.currency_code || "EUR",
    subtotal_ht_cents: toCents(totals.tax_exclusive_amount ?? en.total_ht ?? en.total_without_tax),
    vat_total_cents:   toCents(totals.tax_amount ?? en.total_tax ?? en.vat_amount),
    total_ttc_cents:   toCents(totals.tax_inclusive_amount ?? en.total_ttc ?? en.total_with_tax),
    vat_breakdown: en.tax_breakdown || en.vat_breakdown || null,
    lines: en.lines || en.invoice_lines || null,
    format: (raw.format || raw.doc_type || "factur-x").toLowerCase(),
    raw_payload: raw
  };
}

/* ══════════════════════════════════════════════════════════════════
   PROVIDER : SUPER PDP
   ══════════════════════════════════════════════════════════════════ */

const superpdp = {
  name: "superpdp",
  defaultBaseUrl: {
    sandbox:    "https://api.superpdp.tech",
    production: "https://api.superpdp.tech"
  },

  async auth(cfg) {
    const k = cfg.company_id + ":superpdp:" + cfg.client_id;
    const c = TOKEN_CACHE.get(k);
    if (c && c.exp > nowSec() + 60) return c.token;

    // ⚠️ form-urlencoded, PAS du JSON
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: cfg.client_id,
      client_secret: cfg.client_secret
    });
    const j = await req(cfg.base_url + "/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });
    TOKEN_CACHE.set(k, { token: j.access_token, exp: nowSec() + (j.expires_in || 3600) });
    return j.access_token;
  },

  async _h(cfg, extra = {}) {
    return { Authorization: "Bearer " + (await this.auth(cfg)), Accept: "application/json", ...extra };
  },

  async me(cfg) {
    return req(cfg.base_url + "/v1.beta/companies/me", { headers: await this._h(cfg) });
  },

  /**
   * Envoi : le body est le FICHIER BRUT (pas du JSON).
   * IO BILL pousse son PDF Factur-X existant (PDF/A-3 + CII embarqué).
   * @param {Object} doc { bytes: Uint8Array|Buffer, contentType, filename }
   */
  async sendInvoice(cfg, doc) {
    const j = await req(cfg.base_url + "/v1.beta/invoices", {
      method: "POST",
      headers: await this._h(cfg, { "Content-Type": doc.contentType || "application/pdf" }),
      body: doc.bytes
    });
    return { pa_document_id: String(j.id ?? j.invoice_id), status: "deposee", raw: j };
  },

  async getInvoice(cfg, id) {
    return req(cfg.base_url + "/v1.beta/invoices/" + encodeURIComponent(id), {
      headers: await this._h(cfg)
    });
  },

  /** Pagination par curseur bigint (starting_after_id), pas par date. */
  async listInvoices(cfg, { cursor = null, order = "asc", limit = 50 } = {}) {
    const p = new URLSearchParams({ order, limit: String(limit) });
    if (cursor) p.set("starting_after_id", String(cursor));
    const j = await req(cfg.base_url + "/v1.beta/invoices?" + p.toString(), {
      headers: await this._h(cfg)
    });
    const items = Array.isArray(j) ? j : (j.data || j.items || []);
    const maxId = items.reduce((m, it) => Math.max(m, Number(it.id) || 0), Number(cursor) || 0);
    return { items, cursor: maxId };
  },

  /** Remonte un statut de cycle de vie au fournisseur. */
  async sendEvent(cfg, paDocId, statusCode, details) {
    return req(cfg.base_url + "/v1.beta/invoice_events", {
      method: "POST",
      headers: await this._h(cfg, { "Content-Type": "application/json" }),
      body: JSON.stringify({
        invoice_id: Number(paDocId),
        status_code: statusCode,
        details: details ? [{ label: String(details).slice(0, 500) }] : []
      })
    });
  },

  /** Conformité : valide un fichier SANS l'envoyer. Gratuit. */
  async validate(cfg, bytes, filename, contentType) {
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type: contentType || "application/pdf" }), filename || "invoice.pdf");
    const j = await req(cfg.base_url + "/v1.beta/validation_reports", {
      method: "POST",
      headers: await this._h(cfg), // pas de Content-Type : FormData le pose
      body: fd
    });
    const rep = Array.isArray(j) ? j[0] : (j.data ? j.data[0] : j);
    return {
      is_valid: rep?.is_valid === true,
      profile: rep?.profile || rep?.detected_profile || null,
      errors: rep?.errors || rep?.violations || [],
      raw: rep
    };
  },

  /** Fichier d'une facture reçue. docType=Converted ⇒ format préféré (Factur-X). */
  async fetchFile(cfg, paDocId, kind = "pdf") {
    const docType = kind === "original" ? "Original" : "Converted";
    const url = cfg.base_url + "/v1.beta/invoices/" + encodeURIComponent(paDocId) + "/file?docType=" + docType;
    const r = await fetch(url, { headers: { Authorization: "Bearer " + (await this.auth(cfg)) } });
    if (!r.ok) throw new Error("[PA] fetchFile " + r.status);
    const ct = r.headers.get("content-type") || "application/pdf";
    return {
      bytes: new Uint8Array(await r.arrayBuffer()),
      contentType: ct,
      ext: ct.includes("xml") ? "xml" : "pdf"
    };
  },

  async parseWebhook(cfg, raw, headers) {
    if (!cfg.webhook_secret) return { valid: false, reason: "no_webhook_secret" };
    const given = String(headers["x-signature"] || headers["x-superpdp-signature"] || headers["x-hub-signature-256"] || "").replace(/^sha256=/, "");
    const expected = await hmacHex(cfg.webhook_secret, raw);
    if (!safeEqual(expected, given)) return { valid: false, reason: "bad_signature" };

    let p;
    try { p = JSON.parse(raw); } catch { return { valid: false, reason: "bad_json" }; }
    const event = p.event || p.type || p.event_type || "";
    const isInbound = /receiv|inbound|purchase|achat/i.test(event);
    return {
      valid: true,
      event,
      direction: isInbound ? "inbound" : "outbound",
      pa_document_id: String(p.invoice_id ?? p.id ?? p.data?.id ?? ""),
      status_code: p.status_code || p.status || null,
      payload: p
    };
  }
};

/* ══════════════════════════════════════════════════════════════════
   PROVIDER : MOCK — développer sans réseau
   ══════════════════════════════════════════════════════════════════ */

const mock = {
  name: "mock",
  defaultBaseUrl: { sandbox: "mock://", production: "mock://" },
  async auth() { return "mock-token"; },
  async me() { return { formal_name: "MOCK SARL", siren: "000000000" }; },
  async sendInvoice() { return { pa_document_id: String(Date.now()), status: "deposee", raw: {} }; },
  async getInvoice(cfg, id) { return { id, status_code: LIFECYCLE.recue, en_invoice: {} }; },
  async listInvoices() { return { items: [], cursor: 0 }; },
  async sendEvent() { return { ok: true }; },
  async validate() { return { is_valid: true, profile: "mock", errors: [] }; },
  async fetchFile() { throw new Error("[PA] mock : pas de fichier"); },
  async parseWebhook(cfg, raw) {
    const p = JSON.parse(raw);
    return { valid: true, event: p.event || "mock", direction: p.direction || "outbound",
             pa_document_id: String(p.pa_document_id || ""), status_code: p.status_code || null, payload: p };
  }
};

const PROVIDERS = { superpdp, mock };

/** Résout provider + config depuis une ligne pa_credentials. */
export function getProvider(creds) {
  const name = (creds?.provider || "superpdp").toLowerCase();
  const impl = PROVIDERS[name];
  if (!impl) throw new Error("[PA] provider inconnu : " + name);
  const env = creds.environment === "production" ? "production" : "sandbox";
  return {
    impl,
    cfg: {
      company_id: creds.company_id,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      webhook_secret: creds.webhook_secret,
      base_url: (creds.base_url || impl.defaultBaseUrl[env] || "").replace(/\/$/, ""),
      environment: env
    }
  };
}

export { toCents, PROVIDERS };
