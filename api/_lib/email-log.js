// IO BILL — Journal d'envoi des emails + accusés de réception Resend
// ═══════════════════════════════════════════════════════════════════
// Deux responsabilités :
//   1. sendTrackedEmail() : un SEUL point d'envoi Resend pour toute l'app.
//      Il enregistre systématiquement une ligne dans `email_log`, en succès
//      comme en échec (avec le message d'erreur exact renvoyé par Resend).
//   2. handleEmailEventsWebhook() : reçoit les événements Resend
//      (delivered / bounced / complained / opened...) et met à jour la ligne
//      correspondante → l'utilisateur voit si le client a VRAIMENT reçu.
//
// Configuration Resend (une fois) :
//   Resend → Webhooks → Add endpoint
//     URL    : https://app.iobill.online/api/public?op=email_events
//     Events : email.sent, email.delivered, email.delivery_delayed,
//              email.bounced, email.complained, email.opened, email.clicked
//   Puis copier le "Signing secret" dans la variable d'env
//   RESEND_EVENTS_WEBHOOK_SECRET (whsec_...).
// ═══════════════════════════════════════════════════════════════════

import crypto from "node:crypto";
import { sbAdmin } from "./supabase-admin.js";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EVENTS_SECRET =
  process.env.RESEND_EVENTS_WEBHOOK_SECRET || process.env.RESEND_WEBHOOK_SECRET;

// Hiérarchie des statuts : un événement en retard ne doit pas faire
// "régresser" une ligne déjà délivrée/ouverte.
const STATUS_RANK = {
  skipped: 0,
  queued: 1,
  sent: 2,
  delayed: 3,
  delivered: 4,
  opened: 5,
  clicked: 6,
  // Les états négatifs priment toujours : c'est l'information utile.
  complained: 90,
  bounced: 95,
  failed: 96
};

/**
 * v8.49 — Un champ email de fiche client peut contenir PLUSIEURS adresses,
 * séparées par ";" , "," ou un retour à la ligne.
 * La première est le destinataire principal (to), les suivantes sont mises
 * en copie (cc).
 * @returns {{to: string|null, cc: string[], all: string[]}}
 */
export function parseRecipients(raw) {
  const isValid = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  const all = String(raw || "")
    .split(/[;,\n]/)
    .map((e) => e.trim())
    .filter((e) => e && isValid(e));
  return { to: all[0] || null, cc: all.slice(1), all };
}

/**
 * Insère une ligne dans email_log. Ne throw JAMAIS : la traçabilité ne doit
 * pas empêcher un envoi de partir (ni faire échouer la requête si la
 * migration v8.48 n'est pas encore appliquée).
 */
export async function logEmail(row) {
  try {
    const inserted = await sbAdmin.insert("email_log", {
      ...row,
      created_at: row.created_at || new Date().toISOString()
    });
    if (Array.isArray(inserted) && inserted[0]) return inserted[0];
    return inserted || null;
  } catch (e) {
    console.warn("[email-log] insert impossible:", e?.message);
    return null;
  }
}

/**
 * Envoie un email via Resend ET le journalise.
 *
 * @param {object} payload  corps accepté par l'API Resend (from, to, subject,
 *                          html, text, reply_to, attachments...)
 * @param {object} meta     contexte métier : { company_id, kind, document_type,
 *                          document_id, document_number, reminder_template,
 *                          trigger_source }
 * @returns {{ok:boolean, id:string|null, error:string|null, log_id:string|null}}
 */
export async function sendTrackedEmail(payload, meta = {}) {
  const base = {
    company_id: meta.company_id || null,
    kind: meta.kind || "other",
    document_type: meta.document_type || null,
    document_id: meta.document_id || null,
    document_number: meta.document_number || null,
    reminder_template: meta.reminder_template || null,
    trigger_source: meta.trigger_source || null,
    channel: "email",
    recipient: [
      ...(Array.isArray(payload?.to) ? payload.to : [payload?.to].filter(Boolean)),
      ...(Array.isArray(payload?.cc) ? payload.cc : [])
    ].join(", ") || null,
    subject: payload?.subject || null,
    meta: meta.extra || null
  };

  if (!RESEND_API_KEY) {
    await logEmail({ ...base, status: "failed", error: "RESEND_API_KEY manquante" });
    return { ok: false, id: null, error: "RESEND_API_KEY manquante", log_id: null };
  }
  if (!base.recipient) {
    await logEmail({
      ...base,
      status: "skipped",
      error: "missing_recipient_email — aucune adresse email pour le destinataire"
    });
    return { ok: false, id: null, error: "missing_recipient_email", log_id: null };
  }

  let r, bodyText = "";
  try {
    r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`
      },
      body: JSON.stringify(payload)
    });
    bodyText = await r.text().catch(() => "");
  } catch (e) {
    const err = "Réseau Resend indisponible : " + (e?.message || "inconnu");
    const row = await logEmail({ ...base, status: "failed", error: err });
    return { ok: false, id: null, error: err, log_id: row?.id || null };
  }

  if (!r.ok) {
    // Le corps de la réponse Resend contient la vraie cause (domaine non
    // vérifié, adresse invalide, quota...) — on la garde telle quelle.
    const err = `Resend ${r.status} — ${bodyText.slice(0, 400)}`;
    const row = await logEmail({ ...base, status: "failed", error: err });
    return { ok: false, id: null, error: err, log_id: row?.id || null, status: r.status };
  }

  let data = {};
  try { data = bodyText ? JSON.parse(bodyText) : {}; } catch {}

  const row = await logEmail({
    ...base,
    status: "sent",
    provider_message_id: data.id || null,
    sent_at: new Date().toISOString(),
    last_event_at: new Date().toISOString()
  });

  return { ok: true, id: data.id || null, error: null, log_id: row?.id || null };
}

/**
 * Version texte d'un email HTML (améliore nettement la délivrabilité : un
 * email HTML sans partie texte est un signal de spam classique).
 */
export function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li)>/gi, "\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 : $1")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n").map((l) => l.trim()).join("\n")
    .trim();
}

// ═══════════════════════════════════════════════════════════════════
// WEBHOOK RESEND — accusés de délivrance
// ═══════════════════════════════════════════════════════════════════

async function readRawBody(req) {
  const bufs = [];
  for await (const chunk of req) bufs.push(chunk);
  return Buffer.concat(bufs).toString("utf8");
}

// Signature Svix (format des webhooks Resend) :
// signedContent = "{svix-id}.{svix-timestamp}.{body}", HMAC-SHA256 en base64.
function verifySvix(secret, headers, rawBody) {
  try {
    const id = headers["svix-id"];
    const ts = headers["svix-timestamp"];
    const sigHeader = headers["svix-signature"];
    if (!id || !ts || !sigHeader || !secret) return false;
    const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const expected = crypto
      .createHmac("sha256", secretBytes)
      .update(`${id}.${ts}.${rawBody}`)
      .digest("base64");
    const provided = sigHeader.split(" ").map((s) => s.split(",")[1]).filter(Boolean);
    return provided.some((p) => {
      try {
        const a = Buffer.from(p);
        const b = Buffer.from(expected);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
      } catch { return false; }
    });
  } catch { return false; }
}

const EVENT_MAP = {
  "email.sent": { status: "sent", field: "sent_at" },
  "email.delivered": { status: "delivered", field: "delivered_at" },
  "email.delivery_delayed": { status: "delayed", field: null },
  "email.opened": { status: "opened", field: "opened_at" },
  "email.clicked": { status: "clicked", field: null },
  "email.bounced": { status: "bounced", field: "bounced_at" },
  "email.complained": { status: "complained", field: null },
  "email.failed": { status: "failed", field: null }
};

export async function handleEmailEventsWebhook(req, res) {
  const reply = (status, body) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };

  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });

  let raw = "";
  try { raw = await readRawBody(req); } catch { return reply(400, { error: "body illisible" }); }

  if (EVENTS_SECRET && !verifySvix(EVENTS_SECRET, req.headers, raw)) {
    console.warn("[email-events] signature webhook invalide");
    return reply(401, { error: "Signature invalide" });
  }

  let evt;
  try { evt = JSON.parse(raw); } catch { return reply(400, { error: "JSON invalide" }); }

  const mapped = EVENT_MAP[evt?.type];
  const messageId = evt?.data?.email_id || evt?.data?.id;
  if (!mapped || !messageId) {
    // Événement non suivi : on acquitte pour que Resend ne rejoue pas.
    return reply(200, { ok: true, ignored: evt?.type || "unknown" });
  }

  const rows = await sbAdmin.select("email_log", {
    filter: `provider_message_id=eq.${messageId}`,
    limit: 1
  });
  const row = rows && rows[0];
  if (!row) return reply(200, { ok: true, ignored: "log introuvable" });

  const at = evt.created_at ? new Date(evt.created_at).toISOString() : new Date().toISOString();
  const patch = { last_event_at: at };

  // On ne rétrograde jamais un statut déjà plus avancé.
  if ((STATUS_RANK[mapped.status] ?? 0) > (STATUS_RANK[row.status] ?? 0)) {
    patch.status = mapped.status;
  }
  if (mapped.field && !row[mapped.field]) patch[mapped.field] = at;

  if (evt.type === "email.bounced") {
    const b = evt?.data?.bounce || {};
    patch.error = [b.type, b.subType, b.message].filter(Boolean).join(" — ")
      || "Email rejeté par le serveur du destinataire (bounce)";
  } else if (evt.type === "email.complained") {
    patch.error = "Le destinataire a marqué l'email comme indésirable (spam)";
  } else if (evt.type === "email.delivery_delayed") {
    patch.error = "Livraison retardée par le serveur du destinataire — nouvelle tentative en cours";
  }

  await sbAdmin.update("email_log", `id=eq.${row.id}`, patch);

  // v8.49 — Retour actif en cas de non-distribution : l'émetteur doit être
  // prévenu dans l'app, sans avoir à consulter le journal. Une seule notif par
  // email (le webhook peut rejouer un événement).
  // patch.status n'est renseigné que si le statut PROGRESSE réellement :
  // un même événement rejoué par Resend ne redéclenche donc pas de notif.
  if ((evt.type === "email.bounced" || evt.type === "email.complained")
      && row.company_id && patch.status) {
    const quoi = row.document_number
      ? `${row.kind === "reminder" ? "La relance de la facture" : "Le document"} ${row.document_number}`
      : "Un email";
    await sbAdmin.rpc("create_notification", {
      p_company_id: row.company_id,
      p_notif_type: "email_bounced",
      p_title: evt.type === "email.bounced" ? "Email non distribué" : "Email signalé comme spam",
      p_body: `${quoi} n'est pas parvenu à ${row.recipient || "son destinataire"}. `
        + (evt.type === "email.bounced"
          ? "Vérifiez l'adresse email sur la fiche client."
          : "Le destinataire l'a marqué comme indésirable."),
      p_url: row.document_type === "invoice" ? "/invoices"
        : row.document_type === "quote" ? "/quotes" : "/settings",
      p_severity: "warning",
      p_icon: evt.type === "email.bounced" ? "⛔" : "🚫",
      p_metadata: {
        email_log_id: row.id,
        recipient: row.recipient,
        document_number: row.document_number,
        reason: patch.error
      }
    }).catch(() => {});
  }

  return reply(200, { ok: true, status: patch.status || row.status });
}
