// IO BILL - Webhook Yousign (callback de signature)
// Configurer dans le dashboard Yousign : webhook URL = https://<votre-domaine>/api/yousign-webhook
// Documentation : https://developers.yousign.com/docs/webhooks

import { sbAdmin, json } from "./_lib/supabase-admin.js";

const YOUSIGN_WEBHOOK_SECRET = process.env.YOUSIGN_WEBHOOK_SECRET;

export const config = {
  api: { bodyParser: { sizeLimit: "1mb" } }
};

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

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
      // donc on ne change rien ici
      break;
    default:
      return json(res, 200, { ok: true, ignored: "event " + event });
  }

  if (Object.keys(updates).length > 0) {
    await sbAdmin.update("quotes", `id=eq.${quote.id}`, updates);
  }

  return json(res, 200, { ok: true, quote_id: quote.id, applied: updates });
}
