// IO BILL - Envoi SMS via OVH SMS API
// Documentation : https://help.ovhcloud.com/csm/fr-sms-api?id=kb_article_view&sysparm_article=KB0058134
//
// L'authentification OVH utilise une signature HMAC-SHA1 :
//   sig = SHA1(applicationSecret + "+" + consumerKey + "+" + method + "+" + url + "+" + body + "+" + timestamp)
// Variables d'env requises :
//   OVH_APP_KEY, OVH_APP_SECRET, OVH_CONSUMER_KEY, OVH_SMS_SERVICE_NAME (ex: sms-ab12345-1)
//   OVH_SMS_SENDER (ex: "IOBILL", 11 chars max alphanumeriques)

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";
import { createHash } from "crypto";

const OVH_BASE = "https://eu.api.ovh.com/1.0";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { company } = auth;

  if (!company.sms_enabled) return json(res, 403, { error: "SMS module not enabled for this company" });

  const cfg = ovhConfig();
  if (!cfg.appKey) return json(res, 503, { error: "OVH SMS not configured (set OVH_APP_KEY/SECRET/CONSUMER_KEY/SMS_SERVICE_NAME)" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const { invoice_id, recipient_phone, custom_message } = body || {};
  if (!recipient_phone) return json(res, 400, { error: "recipient_phone required" });

  // Charger la facture si fournie
  let inv = null;
  if (invoice_id) {
    inv = await sbAdmin.selectOne("invoices", `id=eq.${invoice_id}&company_id=eq.${company.id}`);
    if (!inv) return json(res, 404, { error: "Invoice not found" });
  }

  // Composer le message (max 160 chars en GSM-7 standard, 70 en UCS-2)
  const message = custom_message || (inv ? defaultReminderSms(inv, company) : "");
  if (!message) return json(res, 400, { error: "message required" });
  if (message.length > 459) {
    return json(res, 400, { error: "Message too long (max 459 chars / 3 segments)" });
  }

  // Normaliser le telephone E.164 (OVH attend +33...)
  const phone = normalizePhone(recipient_phone, company.country || "FR");
  if (!phone) return json(res, 400, { error: "Invalid phone format" });

  // Insert log en mode "queued"
  const logged = await sbAdmin.insert("sms_log", {
    company_id: company.id,
    invoice_id: invoice_id || null,
    recipient_phone: phone,
    message,
    provider: "ovh",
    status: "queued"
  });
  const logId = logged?.[0]?.id;

  // Appel OVH
  const path = `/sms/${cfg.serviceName}/jobs`;
  const payload = {
    receivers: [phone],
    message,
    sender: cfg.sender || "IOBILL",
    senderForResponse: false,
    noStopClause: false,
    priority: "high"
  };

  const ovhRes = await ovhFetch(cfg, "POST", path, payload);
  if (!ovhRes.ok) {
    if (logId) await sbAdmin.update("sms_log", `id=eq.${logId}`, {
      status: "failed",
      error_message: JSON.stringify(ovhRes.data || {}).slice(0, 500)
    });
    return json(res, 502, { error: "OVH API error", detail: ovhRes.data });
  }

  // OVH renvoie validReceivers / invalidReceivers / ids
  const ovhId = (ovhRes.data?.ids || [])[0];
  if (logId) await sbAdmin.update("sms_log", `id=eq.${logId}`, {
    status: "sent",
    provider_ref: ovhId ? String(ovhId) : null
  });

  // Incrementer compteur SMS du mois (pour billing)
  await sbAdmin.update("companies", `id=eq.${company.id}`, {
    sms_count_month: (company.sms_count_month || 0) + 1
  });

  // Si lie a une facture, marquer la relance
  if (inv) {
    await sbAdmin.update("invoices", `id=eq.${inv.id}`, {
      last_reminder_sent_at: new Date().toISOString(),
      reminder_count: (inv.reminder_count || 0) + 1
    });
  }

  return json(res, 200, {
    ok: true,
    log_id: logId,
    ovh_id: ovhId,
    valid: ovhRes.data?.validReceivers || [],
    invalid: ovhRes.data?.invalidReceivers || []
  });
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
function ovhConfig() {
  return {
    appKey: process.env.OVH_APP_KEY,
    appSecret: process.env.OVH_APP_SECRET,
    consumerKey: process.env.OVH_CONSUMER_KEY,
    serviceName: process.env.OVH_SMS_SERVICE_NAME,
    sender: process.env.OVH_SMS_SENDER
  };
}

function defaultReminderSms(inv, company) {
  const remaining = (inv.total_ttc_cents - (inv.paid_cents || 0)) / 100;
  const nb = inv.reminder_count || 0;
  const n = String(remaining.toFixed(2)).replace(".", ",");
  if (nb === 0) {
    return `Bonjour, votre facture ${inv.number} de ${n}€ arrive à échéance. ${company.legal_name}.`;
  }
  if (nb === 1) {
    return `Rappel : la facture ${inv.number} (${n}€) reste impayée. Merci de régler rapidement. ${company.legal_name}.`;
  }
  return `URGENT - Facture ${inv.number} (${n}€) impayée. Procédure de recouvrement engagée si non règlement sous 7j. ${company.legal_name}.`;
}

function normalizePhone(phone, country = "FR") {
  if (!phone) return null;
  let p = String(phone).replace(/[\s\.\-\(\)]/g, "");
  if (p.startsWith("+")) return p; // deja E.164
  if (country === "FR") {
    if (p.startsWith("0")) return "+33" + p.slice(1);
    if (/^[1-9]\d{8}$/.test(p)) return "+33" + p;
  }
  return null;
}

async function ovhFetch(cfg, method, path, body) {
  const url = OVH_BASE + path;
  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyStr = body ? JSON.stringify(body) : "";

  // Signature OVH : SHA1(secret + "+" + consumerKey + "+" + method + "+" + url + "+" + body + "+" + ts)
  const toHash = [cfg.appSecret, cfg.consumerKey, method, url, bodyStr, ts].join("+");
  const sig = "$1$" + createHash("sha1").update(toHash).digest("hex");

  const headers = {
    "X-Ovh-Application": cfg.appKey,
    "X-Ovh-Consumer": cfg.consumerKey,
    "X-Ovh-Timestamp": ts,
    "X-Ovh-Signature": sig,
    "Content-Type": "application/json"
  };

  try {
    const r = await fetch(url, { method, headers, body: body ? bodyStr : undefined });
    const data = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: e.message } };
  }
}
