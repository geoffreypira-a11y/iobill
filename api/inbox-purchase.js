// IO BILL - Inbox email pour OCR achats
// Cloudflare Email Routing forwarde les emails entrants vers ce endpoint via
// un Email Worker. Format attendu (POST JSON) :
//
// {
//   "to": "achats-3f7a91@inbox.iobill.fr",
//   "from": "facturation@fournisseur.com",
//   "subject": "Votre facture du 12/05",
//   "attachments": [
//     { "filename": "facture.pdf", "content_b64": "...", "mime": "application/pdf" }
//   ]
// }
//
// Securite : header X-IO-INBOX-SECRET (variable INBOX_SECRET partagee avec Cloudflare)

import { sbAdmin, json } from "./_lib/supabase-admin.js";

const INBOX_SECRET = process.env.INBOX_SECRET;

export const config = {
  api: { bodyParser: { sizeLimit: "25mb" } } // emails avec PJ peuvent etre volumineux
};

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  // Verification du secret
  const sent = req.headers["x-io-inbox-secret"] || req.headers["X-IO-INBOX-SECRET"];
  if (!INBOX_SECRET || sent !== INBOX_SECRET) {
    return json(res, 401, { error: "Invalid or missing inbox secret" });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const { to, from, subject, attachments } = body || {};
  if (!to) return json(res, 400, { error: "Missing 'to' field" });

  // 1) Trouver la company correspondant a l'alias
  const alias = String(to).toLowerCase().trim();
  const company = await sbAdmin.selectOne("companies", `inbox_alias=eq.${alias}`);
  if (!company) {
    // On log meme les emails refuses pour debug (sans company_id)
    await sbAdmin.insert("inbox_messages", {
      alias,
      sender_email: from || null,
      subject: subject || null,
      attachment_count: (attachments || []).length,
      status: "rejected",
      error_message: "No company found for alias"
    });
    return json(res, 404, { error: "Unknown inbox alias" });
  }

  if (!company.inbox_enabled) {
    await sbAdmin.insert("inbox_messages", {
      company_id: company.id,
      alias,
      sender_email: from || null,
      subject: subject || null,
      attachment_count: (attachments || []).length,
      status: "rejected",
      error_message: "Inbox disabled for this company"
    });
    return json(res, 403, { error: "Inbox disabled for this company" });
  }

  // 2) Logguer le message
  const msgInsert = await sbAdmin.insert("inbox_messages", {
    company_id: company.id,
    alias,
    sender_email: from || null,
    subject: subject || null,
    attachment_count: (attachments || []).length,
    status: "received",
    raw_size_bytes: estimateSize(body)
  });
  const msgId = msgInsert?.[0]?.id;

  // 3) Pour chaque attachement PDF/image, declencher OCR + creer un purchase
  const purchaseIds = [];
  let processedCount = 0;
  let errorCount = 0;

  for (const att of (attachments || [])) {
    if (!att?.content_b64) continue;
    const mime = att.mime || "application/octet-stream";
    if (!isOcrable(mime)) continue;

    try {
      // Upload l'attachement dans le bucket purchases-attach
      const filename = `${company.id}/inbox/${msgId || Date.now()}-${sanitizeFilename(att.filename || "facture.pdf")}`;
      const bytes = Buffer.from(att.content_b64, "base64");
      const ok = await uploadAttachment("purchases-attach", filename, bytes, mime);
      if (!ok) { errorCount++; continue; }

      const fileUrl = await signedAttachmentUrl("purchases-attach", filename, 3600);

      // Appeler l'OCR Mistral en interne
      const ocrResult = await runOcr({ url: fileUrl, mime });

      // Creer un purchase en draft avec les donnees OCR
      const purchase = {
        company_id: company.id,
        status: "draft",
        ocr_status: ocrResult ? "extracted" : "failed",
        ocr_data: ocrResult || null,
        supplier_name: ocrResult?.supplier?.name || from || "À identifier",
        supplier_siret: ocrResult?.supplier?.siret || null,
        supplier_vat_number: ocrResult?.supplier?.vat_number || null,
        issue_date: ocrResult?.issue_date || null,
        document_number: ocrResult?.document_number || subject || null,
        subtotal_ht_cents: ocrResult?.subtotal_ht_cents || 0,
        vat_total_cents: ocrResult?.vat_total_cents || 0,
        total_ttc_cents: ocrResult?.total_ttc_cents || 0,
        attachment_url: fileUrl,
        attachment_path: filename,
        source: "inbox_email",
        notes: `Reçu par email de ${from || "expéditeur inconnu"}\nSujet: ${subject || "—"}`
      };

      const created = await sbAdmin.insert("purchases", purchase);
      if (created?.[0]?.id) {
        purchaseIds.push(created[0].id);
        processedCount++;
      } else {
        errorCount++;
      }
    } catch (e) {
      errorCount++;
    }
  }

  // 4) Mettre a jour le message inbox
  if (msgId) {
    await sbAdmin.update("inbox_messages", `id=eq.${msgId}`, {
      status: errorCount > 0 && processedCount === 0 ? "failed" : "processed",
      purchase_ids: purchaseIds,
      error_message: errorCount > 0 ? `${errorCount} attachment(s) failed to process` : null
    });
  }

  return json(res, 200, {
    ok: true,
    message_id: msgId,
    processed: processedCount,
    errors: errorCount,
    purchase_ids: purchaseIds
  });
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
function isOcrable(mime) {
  return [
    "application/pdf",
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp"
  ].includes(String(mime).toLowerCase());
}

function sanitizeFilename(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

function estimateSize(body) {
  try { return JSON.stringify(body).length; } catch { return 0; }
}

async function uploadAttachment(bucket, path, bytes, mime) {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const r = await fetch(`${url}/storage/v1/object/${bucket}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      "x-upsert": "true",
      "Content-Type": mime
    },
    body: bytes
  });
  return r.ok;
}

async function signedAttachmentUrl(bucket, path, expiresIn) {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const r = await fetch(`${url}/storage/v1/object/sign/${bucket}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ expiresIn })
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.signedURL ? `${url}/storage/v1${j.signedURL}` : null;
}

// Mistral OCR direct (pas de re-call /api/ocr-purchase pour ne pas creer de boucle)
async function runOcr({ url, mime }) {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) return null;

  const prompt = `Tu es un OCR de factures francaises. Extrais et retourne UNIQUEMENT un JSON valide avec :
{
  "supplier": { "name": "string", "siret": "14 chiffres ou null", "vat_number": "FR... ou null" },
  "document_number": "string ou null",
  "issue_date": "YYYY-MM-DD ou null",
  "subtotal_ht_cents": entier en centimes,
  "vat_total_cents": entier en centimes,
  "total_ttc_cents": entier en centimes,
  "vat_breakdown": [{"rate": 20, "base_cents": ..., "vat_cents": ...}]
}
Aucun texte hors JSON.`;

  try {
    const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "pixtral-12b-2409",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: url }
          ]
        }],
        response_format: { type: "json_object" },
        max_tokens: 800
      })
    });
    if (!r.ok) return null;
    const j = await r.json();
    const content = j.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content);
  } catch {
    return null;
  }
}
