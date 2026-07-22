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
 * en EN 16931. Mapping vérifié sur payload réel (v8.48.3) :
 *   totals.total_without_vat        → HT (string)
 *   totals.total_with_vat           → TTC (string)
 *   totals.total_vat_amount.value   → TVA (objet)
 *   seller.name                     → Fournisseur
 *   seller.legal_registration_identifier.value  → SIREN
 *   seller.vat_identifier           → n° TVA
 *   number                          → numéro facture
 *   issue_date, payment_due_date    → dates
 *   currency_code                   → devise
 *   vat_break_down[]                → détail TVA (attention à l'underscore)
 *   lines[]                         → lignes détaillées
 */
export function normalizeInbound(raw, provider) {
  const en = raw.en_invoice || raw.enInvoice || {};
  const seller = en.seller || {};
  const totals = en.totals || {};
  // total_vat_amount peut être un objet {value, currency_code} ou un scalaire
  const vatRaw = totals.total_vat_amount;
  const vatValue = vatRaw && typeof vatRaw === "object" ? vatRaw.value : vatRaw;

  const sirenFromLegal = seller.legal_registration_identifier?.value || null;

  return {
    provider,
    pa_document_id: String(raw.id ?? raw.invoice_id ?? ""),
    supplier_name:       seller.name || null,
    supplier_siren:      sirenFromLegal,                       // 9 chiffres
    supplier_siret:      sirenFromLegal,                       // même valeur en sandbox
    supplier_vat_number: seller.vat_identifier || null,
    invoice_number: en.number || raw.number || null,
    invoice_date:   (en.issue_date || "").slice(0, 10) || null,
    due_date:       (en.payment_due_date || en.due_date || "").slice(0, 10) || null,
    currency: en.currency_code || "EUR",
    subtotal_ht_cents: toCents(totals.total_without_vat ?? totals.sum_invoice_lines_amount),
    vat_total_cents:   toCents(vatValue),
    total_ttc_cents:   toCents(totals.total_with_vat ?? totals.amount_due_for_payment),
    vat_breakdown: (en.vat_break_down || []).map(v => ({
      rate:        Number(v.vat_category_rate) || 0,
      base_cents:  toCents(v.vat_category_taxable_amount),
      vat_cents:   toCents(v.vat_category_tax_amount),
      code:        v.vat_category_code || null
    })),
    lines: (en.lines || []).map(l => ({
      label:            l.item_information?.name || null,
      description:      l.item_information?.description || null,
      qty:              Number(l.invoiced_quantity) || 0,
      unit:             l.invoiced_quantity_code || null,
      unit_price_cents: toCents(l.price_details?.item_net_price),
      total_ht_cents:   toCents(l.net_amount),
      vat_rate:         Number(l.vat_information?.invoiced_item_vat_rate) || 0
    })),
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

  /** Remonte un statut de cycle de vie au fournisseur.
   * details peut être :
   *   - une string : label libre
   *   - un objet { code, label } : pour les refus (fr:210), code obligatoire.
   *     Codes AFNOR : IC001 (facture erronée), IC003 (destinataire incorrect),
   *     IC005 (montant erroné), IC006 (TVA erronée), IC008 (autre motif).
   *
   * v8.48.9 — SUPER PDP renvoie une erreur schéma AFNOR (MDT-113
   * ProcessConditionCode) quand le motif n'est pas au bon endroit. Comme
   * leur doc n'est pas publique, on envoie plusieurs variantes de champs
   * en même temps ; SUPER PDP prendra celui qu'il connaît.
   */
  async sendEvent(cfg, paDocId, statusCode, details) {
    let code = null, label = null;
    if (details) {
      if (typeof details === "object" && details.code) {
        code = details.code;
        label = String(details.label || "").slice(0, 500);
      } else {
        code = "IC008"; // motif générique si simple string
        label = String(details).slice(0, 500);
      }
    }

    const body = {
      invoice_id: Number(paDocId),
      status_code: statusCode
    };

    if (code) {
      // v8.48.11 — L'erreur SUPER PDP mentionne le chemin XPath AFNOR :
      //   ReferenceReferencedDocument/ProcessConditionCode
      // On tente à la fois les variantes plates ET les variantes imbriquées.
      body.details = [{ code, label }];
      body.reason = { code, label };
      body.reason_code = code;
      body.reason_label = label;
      body.motif = { code, label };
      body.motif_code = code;
      body.motif_label = label;
      body.process_condition_code = code;
      body.processConditionCode = code;
      // Structure imbriquée qui suit le XPath AFNOR
      body.reference_referenced_document = {
        process_condition_code: code,
        processConditionCode: code
      };
      body.referenceReferencedDocument = {
        processConditionCode: code
      };
      body.acknowledgement_document = {
        reference_referenced_document: {
          process_condition_code: code
        }
      };
    }

    // v8.48.10 — Log complet pour debug le format attendu par SUPER PDP.
    const bodyStr = JSON.stringify(body);
    console.log("[PA] sendEvent POST " + statusCode + " body=" + bodyStr);

    const r = await fetch(cfg.base_url + "/v1.beta/invoice_events", {
      method: "POST",
      headers: await this._h(cfg, { "Content-Type": "application/json" }),
      body: bodyStr
    });
    const respTxt = await r.text();
    console.log("[PA] sendEvent RESP " + r.status + " " + respTxt.slice(0, 800));
    if (!r.ok) {
      const e = new Error("[PA] sendEvent " + r.status + " — " + respTxt.slice(0, 400));
      e.status = r.status;
      throw e;
    }
    try { return JSON.parse(respTxt); } catch { return { raw: respTxt }; }
  },

  /** Conformité : valide un fichier SANS l'envoyer. Gratuit. */
  async validate(cfg, bytes, filename, contentType) {
    const fd = new FormData();
    fd.append("file", new Blob([bytes], { type: contentType || "application/pdf" }), filename || "invoice.pdf");
    const url = cfg.base_url + "/v1.beta/validation_reports";
    console.log("[PA] validate POST " + url + " file=" + (filename || "invoice.pdf") + " size=" + bytes.length);
    const j = await req(url, {
      method: "POST",
      headers: await this._h(cfg), // pas de Content-Type : FormData le pose
      body: fd
    });
    // v8.48.20 — Log complet du retour SUPER PDP pour debug conformité.
    console.log("[PA] validate RESP " + JSON.stringify(j).slice(0, 3000));
    const rep = Array.isArray(j) ? j[0] : (j.data ? j.data[0] : j);
    return {
      is_valid: rep?.is_valid === true || rep?.valid === true || rep?.status === "valid",
      profile: rep?.profile || rep?.detected_profile || null,
      errors: rep?.errors || rep?.violations || rep?.messages || rep?.warnings || [],
      raw: rep
    };
  },

  /** Fichier d'une facture reçue. docType=Converted ⇒ format préféré (Factur-X). */
  async fetchFile(cfg, paDocId, kind = "pdf") {
    // v8.48.6 — La route /v1.beta/invoices/{id}?format=... renvoie 404.
    // SUPER PDP mentionne explicitement "l'API AFNOR" dans son UI, avec
    // docType=Converted → format préféré. On tente les 4 conventions
    // AFNOR/PA les plus probables, avec log précis dans Vercel.
    const token = await this.auth(cfg);
    const headers = { Authorization: "Bearer " + token, Accept: "application/pdf,application/xml,*/*" };
    const id = encodeURIComponent(paDocId);
    const docType = kind === "xml" ? "Original" : "Converted";

    const attempts = [
      // API AFNOR (XP Z12-013) — la plus probable vu leur UI
      cfg.base_url + "/v1.beta/afnor/invoices/" + id + "?docType=" + docType,
      cfg.base_url + "/afnor/v1/invoices/" + id + "?docType=" + docType,
      // Route documents / attachments
      cfg.base_url + "/v1.beta/invoices/" + id + "/documents?docType=" + docType,
      cfg.base_url + "/v1.beta/invoices/" + id + "/attachments/factur-x",
      // Variantes simples
      cfg.base_url + "/v1.beta/invoices/" + id + "/pdf",
      cfg.base_url + "/v1.beta/invoices/" + id + "/xml",
      cfg.base_url + "/v1.beta/invoices/" + id + "/download?docType=" + docType,
      cfg.base_url + "/v1.beta/invoices/" + id + "/file?docType=" + docType
    ];

    const errors = [];
    for (const url of attempts) {
      try {
        const r = await fetch(url, { headers });
        // Log CHAQUE tentative pour qu'on voie dans Vercel Logs ce qui répond quoi
        console.log("[PA] fetchFile try", r.status, url);
        if (r.ok) {
          const ct = r.headers.get("content-type") || "";
          const buf = new Uint8Array(await r.arrayBuffer());
          if (buf.length < 100) {
            errors.push("empty(" + buf.length + ") " + url);
            continue;
          }
          // Si c'est du JSON avec un lien vers le fichier, on va chercher
          if (ct.includes("json")) {
            try {
              const j = JSON.parse(new TextDecoder().decode(buf));
              const link = j.url || j.download_url || j.file_url || j.href;
              if (link) {
                console.log("[PA] fetchFile follow", link);
                const r2 = await fetch(link, { headers });
                if (r2.ok) {
                  const ct2 = r2.headers.get("content-type") || "application/pdf";
                  return {
                    bytes: new Uint8Array(await r2.arrayBuffer()),
                    contentType: ct2,
                    ext: ct2.includes("xml") ? "xml" : "pdf"
                  };
                }
              }
              errors.push("json-no-link " + url);
              continue;
            } catch {
              errors.push("bad-json " + url);
              continue;
            }
          }
          return {
            bytes: buf,
            contentType: ct || "application/pdf",
            ext: ct.includes("xml") ? "xml" : "pdf"
          };
        }
        errors.push(r.status + " " + url);
      } catch (e) {
        errors.push(e.message + " " + url);
      }
    }
    throw new Error("[PA] fetchFile aucun endpoint accessible — " + errors.join(" | "));
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
