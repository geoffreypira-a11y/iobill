// IO BILL - Webhook PDP : reception des statuts de transmission
// La PDP envoie des notifications quand le destinataire a reçu/lu/payé/refusé la facture.
//
// Format attendu (commun a la plupart des PDP) :
// {
//   "transmission_id": "abc-123",
//   "reference": "PDP-REF-XYZ",
//   "ppf_reference": "PPF-REF-XYZ",
//   "status": "received" | "read" | "accepted" | "rejected" | "paid",
//   "recipient_status": "..." (optionnel),
//   "occurred_at": "2026-01-15T10:00:00Z"
// }

import { sbAdmin, json } from "./_lib/supabase-admin.js";

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  // Le secret peut etre verifie via header (depend de chaque PDP)
  // Ici, on accepte tous les POST en V1 — durcir avec HMAC en V1.2

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const { transmission_id, reference, ppf_reference, status, recipient_status, occurred_at } = body || {};
  if (!status) return json(res, 400, { error: "status required" });

  // Trouver la transmission par reference (PDP) ou ppf_reference
  let trx = null;
  if (transmission_id) {
    trx = await sbAdmin.selectOne("pdp_transmissions", `id=eq.${transmission_id}`);
  }
  if (!trx && reference) {
    trx = await sbAdmin.selectOne("pdp_transmissions", `pdp_reference=eq.${encodeURIComponent(reference)}`);
  }
  if (!trx && ppf_reference) {
    trx = await sbAdmin.selectOne("pdp_transmissions", `ppf_reference=eq.${encodeURIComponent(ppf_reference)}`);
  }

  if (!trx) {
    return json(res, 200, { ok: true, ignored: "transmission not found", reference });
  }

  // Mapping des statuts
  const statusMap = {
    submitted: "submitted",
    received: "accepted",
    read: "accepted",
    accepted: "accepted",
    rejected: "rejected",
    paid: "accepted"  // le paiement est trace separement, on garde "accepted" cote transmission
  };
  const newStatus = statusMap[status] || status;

  await sbAdmin.update("pdp_transmissions", `id=eq.${trx.id}`, {
    status: newStatus,
    recipient_status: recipient_status || status,
    accepted_at: ["accepted", "received", "read"].includes(status) ? (occurred_at || new Date().toISOString()) : trx.accepted_at,
    response_data: { ...(trx.response_data || {}), last_event: { status, occurred_at, recipient_status } }
  });

  // Si "paid" via PDP, on peut creer un payment cote IO BILL (mais en V1, on prefere
  // que l'utilisateur saisisse manuellement le paiement pour eviter les doublons avec Stripe).
  // TODO V1.2 : auto-payment depuis PDP

  return json(res, 200, { ok: true, transmission_id: trx.id, applied_status: newStatus });
}
