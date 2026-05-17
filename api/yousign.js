// ═══════════════════════════════════════════════════════════
// IO BILL — YOUSIGN (signature electronique eIDAS)
// ═══════════════════════════════════════════════════════════
// Cette fonction fusionne 2 endpoints en un seul pour rester
// sous la limite Vercel Hobby (12 fonctions max) :
//
//   Mode CREATE  (declenchement signature) :
//     POST /api/yousign
//     Header Authorization: Bearer <user_token>
//     Body : { quote_id: "..." }
//
//   Mode WEBHOOK (callback Yousign) :
//     POST /api/yousign?webhook=1
//     Header : pas d'Authorization user (Yousign appelle directement)
//     Body : payload event Yousign
//
// La distinction se fait sur :
//   - presence du query param "?webhook=1"
//   - OU presence d'un header x-yousign-signature-256
//   - OU absence d'Authorization user
//
// Doc : https://developers.yousign.com/docs
// ═══════════════════════════════════════════════════════════

import { authenticate, json, sbAdmin } from "./_lib/supabase-admin.js";
import { buildDocumentPdf } from "./_lib/pdf-builder.js";

const YOUSIGN_BASE = "https://api.yousign.app/v3";
const YOUSIGN_WEBHOOK_SECRET = process.env.YOUSIGN_WEBHOOK_SECRET;

export const config = {
  api: { bodyParser: { sizeLimit: "1mb" } }
};

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  // ─── Routage : webhook vs create ───
  // Webhook si : ?webhook=1 OU header Yousign present OU pas d'Authorization
  const isWebhook =
    req.query?.webhook === "1" ||
    !!req.headers["x-yousign-signature-256"] ||
    !req.headers.authorization;

  if (isWebhook) {
    return handleWebhook(req, res);
  }

  return handleCreate(req, res);
}

// ═══════════════════════════════════════════════════════════
// MODE 1 : CREATE (declenche une demande de signature)
// ═══════════════════════════════════════════════════════════
async function handleCreate(req, res) {
  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { company } = auth;

  if (!process.env.YOUSIGN_API_KEY) {
    return json(res, 503, { error: "YOUSIGN_API_KEY not configured" });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const { quote_id } = body || {};
  if (!quote_id) return json(res, 400, { error: "quote_id required" });

  // 1) Charger le devis et ses lignes
  const quote = await sbAdmin.selectOne("quotes", `id=eq.${quote_id}&company_id=eq.${company.id}`);
  if (!quote) return json(res, 404, { error: "Quote not found" });

  const cs = quote.client_snapshot || {};
  const signerEmail = cs.email;
  if (!signerEmail) return json(res, 400, { error: "Client email missing in snapshot" });

  const lines = await sbAdmin.select("document_lines", {
    filter: `document_type=eq.quote&document_id=eq.${quote_id}`,
    order: "sort_order.asc"
  });

  // 2) Generer le PDF a la volee
  const pdfDoc = await buildDocumentPdf({
    docType: "quote",
    doc: quote,
    lines: lines || [],
    company
  });
  const pdfBytes = await pdfDoc.save();

  // 3) Creer la signature_request
  const sr = await ysFetch("/signature_requests", "POST", {
    name: `Devis ${quote.number}`,
    delivery_mode: "email",
    timezone: "Europe/Paris"
  });
  if (!sr.ok || !sr.data?.id) {
    return json(res, 502, { error: "Yousign: cannot create signature request", detail: sr.data });
  }
  const srId = sr.data.id;

  // 4) Upload du PDF (multipart)
  const fd = new FormData();
  fd.append("file", new Blob([pdfBytes], { type: "application/pdf" }), `devis-${quote.number}.pdf`);
  fd.append("nature", "signable_document");

  const docUp = await fetch(`${YOUSIGN_BASE}/signature_requests/${srId}/documents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.YOUSIGN_API_KEY}` },
    body: fd
  });
  const docData = await docUp.json().catch(() => null);
  if (!docUp.ok || !docData?.id) {
    return json(res, 502, { error: "Yousign: document upload failed", detail: docData });
  }

  // 5) Ajouter le signataire avec un champ signature
  const firstName = cs.first_name || (cs.contact_person || "").split(" ")[0] || "Client";
  const lastName = cs.last_name
    || (cs.contact_person || "").split(" ").slice(1).join(" ")
    || cs.legal_name
    || "—";

  const signer = await ysFetch(`/signature_requests/${srId}/signers`, "POST", {
    info: {
      first_name: firstName,
      last_name: lastName,
      email: signerEmail,
      locale: "fr"
    },
    signature_level: "electronic_signature",
    signature_authentication_mode: "no_otp",
    fields: [{
      type: "signature",
      document_id: docData.id,
      page: 1,
      x: 380, y: 90, width: 180, height: 60
    }]
  });
  if (!signer.ok || !signer.data?.id) {
    return json(res, 502, { error: "Yousign: cannot add signer", detail: signer.data });
  }

  // 6) Activer la procedure (envoie le mail au signataire)
  const activated = await ysFetch(`/signature_requests/${srId}/activate`, "POST", {});
  if (!activated.ok) {
    return json(res, 502, { error: "Yousign: cannot activate", detail: activated.data });
  }

  // 7) Mettre a jour le devis
  await sbAdmin.update("quotes", `id=eq.${quote_id}`, {
    signature_provider: "yousign",
    signature_ref: srId,
    status: "sent"
  });

  return json(res, 200, {
    ok: true,
    signature_request_id: srId,
    status: activated.data?.status,
    signer_url: signer.data?.signature_link || null
  });
}

// ═══════════════════════════════════════════════════════════
// MODE 2 : WEBHOOK (callback Yousign)
// ═══════════════════════════════════════════════════════════
async function handleWebhook(req, res) {
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  // Verification de signature webhook (recommande Yousign)
  if (YOUSIGN_WEBHOOK_SECRET) {
    const signature = req.headers["x-yousign-signature-256"];
    if (!signature) return json(res, 401, { error: "Missing signature" });
    // TODO: implementer la verification HMAC SHA-256 si besoin de durcir
  }

  const event = body?.event_name || body?.event?.name;
  const sigReqId =
    body?.signature_request?.id ||
    body?.data?.signature_request?.id ||
    body?.event?.subject?.id;

  if (!sigReqId) {
    return json(res, 200, { ok: true, ignored: "no signature_request id" });
  }

  // Retrouver le devis associe
  const quote = await sbAdmin.selectOne("quotes", `signature_ref=eq.${sigReqId}`);
  if (!quote) {
    return json(res, 200, { ok: true, ignored: "quote not found for ref " + sigReqId });
  }

  let updates = {};

  switch (event) {
    case "signature_request.activated":
      updates.status = "sent";
      break;
    case "signer.done":
    case "signature_request.done":
      updates.status = "signed";
      updates.signed_at = new Date().toISOString();
      // Stocker IP du signataire si dispo (eIDAS)
      const ip = body?.signer?.ip_address || body?.data?.signer?.ip_address;
      if (ip) updates.signed_ip = ip;
      break;
    case "signer.declined":
    case "signature_request.declined":
      updates.status = "refused";
      updates.refused_at = new Date().toISOString();
      break;
    case "signature_request.expired":
      // Le statut "expired" est calcule cote frontend a partir de expires_at
      break;
    default:
      return json(res, 200, { ok: true, ignored: "event " + event });
  }

  if (Object.keys(updates).length > 0) {
    await sbAdmin.update("quotes", `id=eq.${quote.id}`, updates);
  }

  return json(res, 200, { ok: true, quote_id: quote.id, applied: updates });
}

// ─── Helper Yousign ─────────────────────────────────────
async function ysFetch(path, method, body) {
  const r = await fetch(`${YOUSIGN_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.YOUSIGN_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: body && method !== "GET" ? JSON.stringify(body) : undefined
  });
  return { ok: r.ok, data: await r.json().catch(() => null) };
}
