// api/inbox-webhook.js
// ════════════════════════════════════════════════════════════════
// v8.87 — Webhook Resend Inbound pour l'Inbox OCR achats.
//
// Flux : email envoyé à achats-xxx@inbox.iobill.fr
//   → Resend le reçoit et POST cet endpoint (event "email.received")
//   → on retrouve la company via l'alias
//   → on récupère les pièces jointes via l'API Resend Receiving
//   → OCR Mistral + structuration
//   → création d'un brouillon d'achat (status draft) dans Achats
//   → log dans inbox_messages.
//
// INFRA À CONFIGURER (une fois, côté Resend / DNS / Vercel) :
//   1. Resend → Receiving : ajouter le domaine `inbox.iobill.fr` et son
//      enregistrement MX (priorité la plus basse) chez le registrar.
//   2. Resend → Webhooks : event `email.received` → URL
//      https://app.iobill.online/api/inbox-webhook
//   3. Copier le signing secret (whsec_…) → variable Vercel RESEND_WEBHOOK_SECRET.
//   Variables d'env requises :
//      RESEND_API_KEY, RESEND_WEBHOOK_SECRET, MISTRAL_API_KEY,
//      VITE_SUPABASE_URL (ou SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
// ════════════════════════════════════════════════════════════════

import crypto from "crypto";
import { sbAdmin } from "./supabase-admin.js";
import { ocrBytesToText, structureWithMistral } from "../ocr-purchase.js";


const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SR_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
// v8.92 — L'API Receiving (lister/télécharger les PJ) exige une clé Resend
// "Full Access" ; la clé d'envoi est souvent restreinte ("send only"). On
// utilise une clé dédiée si fournie, sinon on retombe sur RESEND_API_KEY.
const RESEND_RECEIVING_KEY = process.env.RESEND_RECEIVING_KEY || process.env.RESEND_API_KEY;
const WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET;

function json(res, code, obj) { res.status(code).json(obj); }
const toCents = (v) => Math.round((parseFloat(v) || 0) * 100);

async function readRawBody(req) {
  const bufs = [];
  for await (const chunk of req) bufs.push(chunk);
  return Buffer.concat(bufs).toString("utf8");
}

// Vérification de signature Svix (format des webhooks Resend).
// signedContent = "{svix-id}.{svix-timestamp}.{body}" ; HMAC-SHA256(secret) en base64 ;
// l'en-tête svix-signature liste "v1,<sig>" séparés par des espaces.
function verifySvix(secret, headers, rawBody) {
  try {
    const id = headers["svix-id"];
    const ts = headers["svix-timestamp"];
    const sigHeader = headers["svix-signature"];
    if (!id || !ts || !sigHeader || !secret) return false;
    const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const signedContent = `${id}.${ts}.${rawBody}`;
    const expected = crypto.createHmac("sha256", secretBytes).update(signedContent).digest("base64");
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

// Upload d'une pièce jointe dans le bucket des achats (pour l'aperçu ultérieur).
async function uploadToStorage(companyId, filename, bytes, mime) {
  const safe = String(filename || "piece").replace(/[^\w.-]+/g, "_");
  const path = `${companyId}/inbox_${Date.now()}_${safe}`;
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/purchases-attach/${path}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + SR_KEY,
      apikey: SR_KEY,
      "Content-Type": mime || "application/octet-stream",
      "x-upsert": "true"
    },
    body: bytes
  });
  if (!r.ok) {
    console.error("[inbox] upload storage échoué", r.status, (await r.text().catch(() => "")).slice(0, 200));
    return null;
  }
  return path;
}

export async function handleInboxWebhook(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const rawBody = await readRawBody(req);

  // 1) Sécurité : vérifier la signature Resend (si le secret est configuré).
  if (WEBHOOK_SECRET && !verifySvix(WEBHOOK_SECRET, req.headers, rawBody)) {
    console.warn("[inbox] signature webhook invalide");
    return json(res, 401, { error: "Signature invalide" });
  }

  let event;
  try { event = JSON.parse(rawBody); } catch { return json(res, 400, { error: "JSON invalide" }); }

  // On acquitte (200) tout event non pertinent pour éviter les retries inutiles.
  if (!event || event.type !== "email.received" || !event.data) {
    return json(res, 200, { ok: true, ignored: true });
  }

  const data = event.data;
  const emailId = data.email_id;
  const recipients = []
    .concat(data.to || [], data.received_for || [])
    .map((s) => String(s).toLowerCase().trim())
    .filter(Boolean);
  const sender = data.from || null;
  const subject = data.subject || null;

  // 2) Retrouver la company via l'alias inbox. On matche sur la PARTIE LOCALE
  //    (avant le @), pas sur le domaine : l'alias stocké peut être
  //    @inbox.iobill.fr alors que l'email arrive sur le domaine réellement
  //    configuré dans Resend (ex. inbox.iobill.online). Ça découple le domaine
  //    de réception du domaine historique des alias.
  let company = null;
  for (const rcpt of recipients) {
    const localPart = String(rcpt).split("@")[0].trim();
    if (!localPart) continue;
    const rows = await sbAdmin.select("companies", {
      filter: `inbox_alias=like.${localPart}@*`,
      select: "id,inbox_enabled,inbox_alias",
      limit: 1
    });
    if (rows && rows[0]) { company = rows[0]; break; }
  }
  if (!company) {
    console.warn("[inbox] aucune company pour", recipients.join(", "));
    return json(res, 200, { ok: true, no_match: true });
  }
  if (!company.inbox_enabled) {
    return json(res, 200, { ok: true, disabled: true });
  }

  // 3) Récupérer les pièces jointes via l'API Resend Receiving
  //    (le webhook ne contient que les métadonnées ; download_url valable 1 h).
  let attachments = [];
  try {
    const ar = await fetch(`https://api.resend.com/emails/receiving/${emailId}/attachments`, {
      headers: { Authorization: "Bearer " + RESEND_RECEIVING_KEY }
    });
    if (ar.ok) { const aj = await ar.json(); attachments = aj.data || []; }
    else console.error("[inbox] API attachments", ar.status, (await ar.text().catch(() => "")).slice(0, 200));
  } catch (e) { console.error("[inbox] fetch attachments", e.message); }

  // On ne traite que les PDF / images (les factures fournisseurs).
  const usable = attachments.filter((a) => {
    const ct = (a.content_type || "").toLowerCase();
    return ct.includes("pdf") || ct.startsWith("image/");
  });

  let created = 0;
  for (const att of usable) {
    try {
      if (!att.download_url) continue;
      const dl = await fetch(att.download_url);
      if (!dl.ok) continue;
      const bytes = Buffer.from(await dl.arrayBuffer());
      const mime = att.content_type || "application/pdf";

      // Upload (pour pouvoir revoir le document dans Achats).
      const filePath = await uploadToStorage(company.id, att.filename, bytes, mime);

      // OCR + structuration (best-effort : un brouillon est créé même si l'OCR rate).
      let structured = {};
      try {
        const text = await ocrBytesToText(bytes, mime);
        if (text && text.length > 10) structured = await structureWithMistral(text);
      } catch (e) { console.warn("[inbox] OCR échec", e.message); }

      const vatC = toCents(structured.vat_total);
      await sbAdmin.insert("purchases", {
        company_id: company.id,
        vendor_name: structured.vendor_name || (att.filename || "Fournisseur (à compléter)"),
        vendor_siret: structured.vendor_siret || null,
        vendor_vat_number: structured.vendor_vat_number || null,
        number: structured.number || null,
        issue_date: structured.issue_date || new Date().toISOString().slice(0, 10),
        subtotal_ht_cents: toCents(structured.subtotal_ht),
        vat_total_cents: vatC,
        vat_deductible_cents: vatC,     // déductible = total par défaut ; l'abonné ajuste
        total_ttc_cents: toCents(structured.total_ttc),
        category: structured.category || null,
        accounting_code: structured.accounting_code || null,
        status: "draft",
        file_url: filePath,
        file_size: bytes.length,
        file_mime: mime,
        source: "inbox",
        ocr_status: filePath ? "done" : "pending"
      });
      created++;
    } catch (e) {
      console.error("[inbox] traitement PJ échoué", e.message);
    }
  }

  // 4) Journaliser dans inbox_messages (best-effort — n'impacte pas la réponse).
  try {
    await sbAdmin.insert("inbox_messages", {
      company_id: company.id,
      alias: company.inbox_alias || null,
      received_at: new Date().toISOString(),
      sender_email: sender,
      subject,
      attachment_count: usable.length,
      status: created > 0 ? "processed" : "received"
    });
  } catch (e) { console.warn("[inbox] log inbox_messages échoué", e.message); }

  return json(res, 200, { ok: true, created });
}
