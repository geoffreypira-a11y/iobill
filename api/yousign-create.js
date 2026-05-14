// IO BILL - Yousign : signature electronique eIDAS
// Doc : https://developers.yousign.com/docs
// Workflow : 1) generer le PDF du devis, 2) creer signature_request,
// 3) uploader le PDF, 4) ajouter le signataire, 5) activer la procedure.

import { authenticate, json, sbAdmin } from "./_lib/supabase-admin.js";
import { buildDocumentPdf } from "./_lib/pdf-builder.js";

const YOUSIGN_BASE = "https://api.yousign.app/v3";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

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
