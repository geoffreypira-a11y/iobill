// IO BILL - Generation PDF d'un avoir

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";
import { buildDocumentPdf, uploadToStorage, signedUrl } from "./_lib/pdf-builder.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { company } = auth;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const creditNoteId = body?.credit_note_id;
  if (!creditNoteId) return json(res, 400, { error: "credit_note_id required" });

  const cn = await sbAdmin.selectOne("credit_notes", `id=eq.${creditNoteId}&company_id=eq.${company.id}`);
  if (!cn) return json(res, 404, { error: "Credit note not found" });
  if (cn.status !== "issued") return json(res, 400, { error: "Credit note must be issued first" });

  const lines = await sbAdmin.select("document_lines", {
    filter: `document_type=eq.credit_note&document_id=eq.${creditNoteId}`,
    order: "sort_order.asc"
  });

  const pdfDoc = await buildDocumentPdf({
    docType: "credit_note",
    doc: cn,
    lines: lines || [],
    company
  });
  const pdfBytes = await pdfDoc.save();

  const filePath = `${company.id}/avoir-${cn.number}.pdf`;
  const uploaded = await uploadToStorage("invoices-pdf", filePath, pdfBytes, "application/pdf");
  if (!uploaded) return json(res, 500, { error: "Storage upload failed" });

  const url = await signedUrl("invoices-pdf", filePath, 3600);

  await sbAdmin.update("credit_notes", `id=eq.${creditNoteId}`, { pdf_url: url });

  return json(res, 200, { ok: true, pdf_url: url, pdf_size: pdfBytes.length });
}
