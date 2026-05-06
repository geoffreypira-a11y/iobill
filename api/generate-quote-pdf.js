// IO BILL - Generation PDF d'un devis
// Utilise par Yousign et le portail public.

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";
import { buildDocumentPdf, uploadToStorage, signedUrl } from "./_lib/pdf-builder.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { company } = auth;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const quoteId = body?.quote_id;
  if (!quoteId) return json(res, 400, { error: "quote_id required" });

  // Charger le devis et ses lignes
  const quote = await sbAdmin.selectOne("quotes", `id=eq.${quoteId}&company_id=eq.${company.id}`);
  if (!quote) return json(res, 404, { error: "Quote not found" });

  const lines = await sbAdmin.select("document_lines", {
    filter: `document_type=eq.quote&document_id=eq.${quoteId}`,
    order: "sort_order.asc"
  });

  // Construire le PDF
  const pdfDoc = await buildDocumentPdf({
    docType: "quote",
    doc: quote,
    lines: lines || [],
    company
  });
  const pdfBytes = await pdfDoc.save();

  // Upload Storage (bucket "quotes-pdf" — a creer dans Supabase, sinon "invoices-pdf" est aussi acceptable)
  const filePath = `${company.id}/devis-${quote.number}.pdf`;
  const uploaded = await uploadToStorage("invoices-pdf", filePath, pdfBytes, "application/pdf");
  if (!uploaded) return json(res, 500, { error: "Storage upload failed" });

  const url = await signedUrl("invoices-pdf", filePath, 3600);

  // Mettre a jour le devis
  await sbAdmin.update("quotes", `id=eq.${quoteId}`, { pdf_url: url });

  return json(res, 200, { ok: true, pdf_url: url, pdf_size: pdfBytes.length });
}
