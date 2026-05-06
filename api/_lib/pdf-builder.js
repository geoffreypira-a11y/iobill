// IO BILL - Generation PDF partagee (devis + factures + avoirs)
// pdf-lib uniquement, pas d'autre dependance.

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const COLORS = {
  gold: rgb(0.83, 0.66, 0.26),
  dark: rgb(0.04, 0.05, 0.06),
  grey: rgb(0.42, 0.42, 0.48),
  lineGrey: rgb(0.85, 0.85, 0.88),
  green: rgb(0.24, 0.81, 0.48),
  orange: rgb(0.90, 0.59, 0.24)
};

/**
 * Genere le PDF d'un document (devis, facture, avoir).
 * @param {object} opts
 * @param {"quote" | "invoice" | "credit_note"} opts.docType
 * @param {object} opts.doc       Le document (devis | facture | avoir)
 * @param {array}  opts.lines     Les lignes du document
 * @param {object} opts.company   La societe (pour fallback si snapshot manquant)
 * @returns {Promise<Uint8Array>} Les bytes du PDF
 */
export async function buildDocumentPdf({ docType, doc, lines, company }) {
  const pdfDoc = await PDFDocument.create();
  const labels = {
    quote: { title: "DEVIS", filename: "Devis", verb: "Émis" },
    invoice: { title: "FACTURE", filename: "Facture", verb: "Émise" },
    credit_note: { title: "AVOIR", filename: "Avoir", verb: "Émis" }
  };
  const L = labels[docType] || labels.invoice;

  pdfDoc.setTitle(`${L.filename} ${doc.number}`);
  pdfDoc.setAuthor(company.legal_name || "");
  pdfDoc.setCreator("IO BILL — OWL'S INDUSTRY");
  pdfDoc.setProducer("IO BILL");
  pdfDoc.setCreationDate(new Date());

  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const { width, height } = page.getSize();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let y = height - 50;

  // ─── En-tete : marque + numero ───
  page.drawText("IO", { x: 40, y, size: 26, font: fontBold, color: COLORS.gold });
  page.drawText("BILL", { x: 70, y, size: 26, font: fontBold, color: COLORS.dark });
  page.drawText("OWL'S INDUSTRY", { x: 40, y: y - 14, size: 7, font, color: COLORS.grey });

  page.drawText(L.title, { x: width - 180, y, size: 22, font: fontBold, color: COLORS.dark });
  page.drawText(doc.number, { x: width - 180, y: y - 22, size: 13, font, color: COLORS.gold });
  page.drawText(`${L.verb} le ${formatDateFR(doc.issue_date)}`, { x: width - 180, y: y - 38, size: 9, font, color: COLORS.grey });

  if (docType === "quote" && doc.expires_at) {
    page.drawText(`Valable jusqu'au ${formatDateFR(doc.expires_at)}`, { x: width - 180, y: y - 50, size: 9, font, color: COLORS.grey });
  }
  if (docType === "invoice" && doc.due_date) {
    page.drawText(`Échéance ${formatDateFR(doc.due_date)}`, { x: width - 180, y: y - 50, size: 9, font, color: COLORS.grey });
  }
  if (docType === "credit_note" && doc.invoice_id) {
    page.drawText(`Réf. facture (id court)`, { x: width - 180, y: y - 50, size: 9, font, color: COLORS.grey });
  }

  y -= 90;

  // ─── Bloc emetteur ───
  const cs = doc.client_snapshot || {};
  const co = doc.company_snapshot || company;

  page.drawText("ÉMETTEUR", { x: 40, y, size: 8, font: fontBold, color: COLORS.grey });
  let yy = y - 14;
  page.drawText(co.legal_name || "", { x: 40, y: yy, size: 11, font: fontBold, color: COLORS.dark });
  yy -= 14;
  if (co.address_line1) { page.drawText(co.address_line1, { x: 40, y: yy, size: 9, font, color: COLORS.dark }); yy -= 12; }
  if (co.address_line2) { page.drawText(co.address_line2, { x: 40, y: yy, size: 9, font, color: COLORS.dark }); yy -= 12; }
  if (co.postal_code || co.city) { page.drawText(`${co.postal_code || ""} ${co.city || ""}`, { x: 40, y: yy, size: 9, font, color: COLORS.dark }); yy -= 12; }
  if (co.country) { page.drawText(co.country, { x: 40, y: yy, size: 9, font, color: COLORS.dark }); yy -= 12; }
  if (co.email) { page.drawText(co.email, { x: 40, y: yy, size: 9, font, color: COLORS.grey }); yy -= 12; }
  if (co.siret) { page.drawText(`SIRET ${co.siret}`, { x: 40, y: yy, size: 8, font, color: COLORS.grey }); yy -= 11; }
  if (co.vat_number) { page.drawText(`TVA ${co.vat_number}`, { x: 40, y: yy, size: 8, font, color: COLORS.grey }); yy -= 11; }

  // ─── Bloc destinataire (cote droit) ───
  let yc = height - 140;
  page.drawText("DESTINATAIRE", { x: 320, y: yc, size: 8, font: fontBold, color: COLORS.grey });
  yc -= 14;
  const clientName = cs.legal_name || `${cs.first_name || ""} ${cs.last_name || ""}`.trim() || "Client";
  page.drawText(clientName, { x: 320, y: yc, size: 11, font: fontBold, color: COLORS.dark });
  yc -= 14;
  if (cs.contact_person) { page.drawText(cs.contact_person, { x: 320, y: yc, size: 9, font, color: COLORS.dark }); yc -= 12; }
  if (cs.address_line1) { page.drawText(cs.address_line1, { x: 320, y: yc, size: 9, font, color: COLORS.dark }); yc -= 12; }
  if (cs.address_line2) { page.drawText(cs.address_line2, { x: 320, y: yc, size: 9, font, color: COLORS.dark }); yc -= 12; }
  if (cs.postal_code || cs.city) { page.drawText(`${cs.postal_code || ""} ${cs.city || ""}`, { x: 320, y: yc, size: 9, font, color: COLORS.dark }); yc -= 12; }
  if (cs.country) { page.drawText(cs.country, { x: 320, y: yc, size: 9, font, color: COLORS.dark }); yc -= 12; }
  if (cs.siret) { page.drawText(`SIRET ${cs.siret}`, { x: 320, y: yc, size: 8, font, color: COLORS.grey }); yc -= 11; }
  if (cs.vat_number) { page.drawText(`TVA ${cs.vat_number}`, { x: 320, y: yc, size: 8, font, color: COLORS.grey }); yc -= 11; }

  y = Math.min(yy, yc) - 18;

  // ─── Tableau des lignes ───
  page.drawRectangle({ x: 40, y: y - 4, width: width - 80, height: 18, color: rgb(0.96, 0.95, 0.92) });
  page.drawText("Désignation", { x: 44, y: y + 2, size: 8, font: fontBold, color: COLORS.grey });
  drawRight(page, "Qté", 325, y + 2, 8, fontBold, COLORS.grey);
  page.drawText("Unité", { x: 332, y: y + 2, size: 8, font: fontBold, color: COLORS.grey });
  drawRight(page, "P.U. HT", 425, y + 2, 8, fontBold, COLORS.grey);
  drawRight(page, "TVA", 465, y + 2, 8, fontBold, COLORS.grey);
  drawRight(page, "Total HT", 555, y + 2, 8, fontBold, COLORS.grey);
  y -= 22;

  for (const l of (lines || [])) {
    const desc = (l.description || "").slice(0, 65);
    const ht = (Number(l.line_ht_cents) / 100).toFixed(2);
    const pu = (Number(l.unit_price_ht_cents) / 100).toFixed(2);
    page.drawText(desc, { x: 44, y, size: 9, font, color: COLORS.dark });
    drawRight(page, String(Number(l.quantity).toFixed(2)).replace(/\.00$/, ""), 325, y, 9, font, COLORS.dark);
    page.drawText(l.unit || "u", { x: 332, y, size: 9, font, color: COLORS.dark });
    drawRight(page, pu + " €", 425, y, 9, font, COLORS.dark);
    drawRight(page, Number(l.vat_rate).toFixed(0) + "%", 465, y, 9, font, COLORS.dark);
    drawRight(page, ht + " €", 555, y, 9, font, COLORS.dark);
    y -= 16;
    page.drawLine({ start: { x: 40, y: y + 2 }, end: { x: width - 40, y: y + 2 }, thickness: 0.3, color: COLORS.lineGrey });
  }

  y -= 12;

  // ─── Totaux ───
  const totalsX = width - 220;
  page.drawText("Total HT", { x: totalsX, y, size: 9, font, color: COLORS.grey });
  drawRight(page, formatEUR(doc.subtotal_ht_cents), width - 40, y, 9, font, COLORS.dark);
  y -= 14;

  for (const v of (doc.vat_breakdown || [])) {
    page.drawText(`TVA ${Number(v.rate).toFixed(0)}%`, { x: totalsX, y, size: 9, font, color: COLORS.grey });
    drawRight(page, formatEUR(v.vat_cents), width - 40, y, 9, font, COLORS.dark);
    y -= 14;
  }
  if (!doc.vat_breakdown || doc.vat_breakdown.length === 0) {
    page.drawText("TVA", { x: totalsX, y, size: 9, font, color: COLORS.grey });
    drawRight(page, formatEUR(doc.vat_total_cents), width - 40, y, 9, font, COLORS.dark);
    y -= 14;
  }
  y -= 4;
  page.drawLine({ start: { x: totalsX, y: y + 6 }, end: { x: width - 40, y: y + 6 }, thickness: 1, color: COLORS.gold });
  const totalLabel = docType === "credit_note" ? "Total à déduire" : "Total TTC";
  page.drawText(totalLabel, { x: totalsX, y, size: 12, font: fontBold, color: COLORS.gold });
  const totalValue = (docType === "credit_note" ? "− " : "") + formatEUR(doc.total_ttc_cents);
  drawRight(page, totalValue, width - 40, y, 12, fontBold, COLORS.gold);
  y -= 24;

  // Reste a payer (factures uniquement)
  if (docType === "invoice" && (doc.paid_cents || 0) > 0) {
    page.drawText("Déjà encaissé", { x: totalsX, y, size: 9, font, color: COLORS.green });
    drawRight(page, "− " + formatEUR(doc.paid_cents), width - 40, y, 9, font, COLORS.green);
    y -= 14;
    page.drawText("Reste à régler", { x: totalsX, y, size: 10, font: fontBold, color: COLORS.dark });
    drawRight(page, formatEUR(doc.total_ttc_cents - doc.paid_cents), width - 40, y, 10, fontBold, COLORS.dark);
    y -= 18;
  }

  // ─── Notes / Conditions ───
  if (doc.notes) {
    page.drawText("NOTES", { x: 40, y, size: 8, font: fontBold, color: COLORS.grey });
    y -= 12;
    drawWrapped(page, doc.notes, 40, y, width - 80, font, 9, COLORS.dark);
    y -= 12 * Math.max(2, Math.ceil((doc.notes.length || 0) / 90));
  }

  if (doc.terms) {
    page.drawText("CONDITIONS", { x: 40, y, size: 8, font: fontBold, color: COLORS.grey });
    y -= 12;
    drawWrapped(page, doc.terms, 40, y, width - 80, font, 9, COLORS.dark);
  }

  // ─── Mentions legales bas de page ───
  let foot = 80;
  // Priorite : doc.vat_legal_mention (defini selon vat_category : franchise, intracom, export...)
  // Sinon fallback selon company.vat_regime
  if (doc.vat_legal_mention) {
    foot = drawWrapped(page, doc.vat_legal_mention, 40, foot, width - 80, font, 8, COLORS.grey, 11) - 6;
  } else if (company.vat_regime === "franchise") {
    page.drawText("TVA non applicable, art. 293 B du CGI.", { x: 40, y: foot, size: 8, font, color: COLORS.grey });
    foot -= 11;
  }
  if (docType === "invoice") {
    page.drawText("En cas de retard de paiement, indemnité forfaitaire de 40 € pour frais de recouvrement (art. L441-10 du code de commerce).", {
      x: 40, y: foot, size: 7, font, color: COLORS.grey
    });
    foot -= 10;
  }
  if (docType === "credit_note" && doc.reason) {
    page.drawText(`Motif : ${doc.reason}`.slice(0, 120), { x: 40, y: foot, size: 8, font, color: COLORS.grey });
    foot -= 10;
  }
  if (doc.content_hash) {
    page.drawText(`Hash de chaîne : ${(doc.content_hash || "").slice(0, 32)}…`, {
      x: 40, y: foot, size: 6, font, color: COLORS.grey
    });
  }

  return pdfDoc;
}

// ──────────────────────────────────────────────────────────────
// HELPERS PDF
// ──────────────────────────────────────────────────────────────
export function drawRight(page, text, xRight, y, size, font, color) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: xRight - w, y, size, font, color });
}

export function drawWrapped(page, text, x, y, maxWidth, font, size, color, lineHeight = 12) {
  const words = String(text || "").split(/\s+/);
  let line = "";
  let currentY = y;
  for (const w of words) {
    const test = line ? line + " " + w : w;
    const width = font.widthOfTextAtSize(test, size);
    if (width > maxWidth && line) {
      page.drawText(line, { x, y: currentY, size, font, color });
      line = w;
      currentY -= lineHeight;
    } else {
      line = test;
    }
  }
  if (line) page.drawText(line, { x, y: currentY, size, font, color });
  return currentY;
}

export function formatEUR(cents) {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format((cents || 0) / 100);
}

export function formatDateFR(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("fr-FR");
}

// ──────────────────────────────────────────────────────────────
// STORAGE HELPERS
// ──────────────────────────────────────────────────────────────
export async function uploadToStorage(bucket, path, bytes, mime) {
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

export async function signedUrl(bucket, path, expiresIn = 3600) {
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
