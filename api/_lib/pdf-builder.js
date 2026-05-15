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

  // ─── En-tete : LOGO ou NOM EN GRAND (pattern IOcar) ───
  const co0 = doc.company_snapshot || company || {};
  const issuerName = co0.legal_name || "Émetteur";

  // 1) Essayer d'embarquer le logo s'il est defini
  let logoEmbedded = false;
  if (company?.logo_url) {
    try {
      const logoBytes = await fetchLogoBytes(company.logo_url);
      if (logoBytes) {
        // Detection du format depuis les premiers bytes
        const isPng = logoBytes[0] === 0x89 && logoBytes[1] === 0x50;
        const isJpg = logoBytes[0] === 0xff && logoBytes[1] === 0xd8;
        let embedded = null;
        if (isPng) {
          embedded = await pdfDoc.embedPng(logoBytes);
        } else if (isJpg) {
          embedded = await pdfDoc.embedJpg(logoBytes);
        }
        if (embedded) {
          // Calcul de la taille en gardant les proportions (max 160x60)
          const maxW = 160, maxH = 60;
          const ratio = Math.min(maxW / embedded.width, maxH / embedded.height);
          const drawW = embedded.width * ratio;
          const drawH = embedded.height * ratio;
          page.drawImage(embedded, {
            x: 40,
            y: y - drawH + 16,
            width: drawW,
            height: drawH
          });
          logoEmbedded = true;
        }
      }
    } catch (e) {
      console.warn("[pdf-builder] Logo embed failed, fallback to text:", e?.message);
    }
  }

  // 2) Fallback si pas de logo : nom de l'emetteur en grand (pattern IOcar pdoc-logo)
  if (!logoEmbedded) {
    // Tronque si trop long
    const displayName = issuerName.length > 28 ? issuerName.slice(0, 26) + "…" : issuerName;
    page.drawText(displayName.toUpperCase(), {
      x: 40, y: y + 6, size: 20, font: fontBold, color: COLORS.dark
    });
    if (co0.siret) {
      page.drawText(`SIRET ${co0.siret}`, { x: 40, y: y - 10, size: 8, font, color: COLORS.grey });
    }
  }

  // À droite : numéro et type de document
  page.drawText(L.title, { x: width - 180, y: y + 12, size: 22, font: fontBold, color: COLORS.dark });
  page.drawText(doc.number, { x: width - 180, y: y - 10, size: 13, font, color: COLORS.gold });
  page.drawText(`${L.verb} le ${formatDateFR(doc.issue_date)}`, { x: width - 180, y: y - 26, size: 9, font, color: COLORS.grey });

  if (docType === "quote" && doc.expires_at) {
    page.drawText(`Valable jusqu'au ${formatDateFR(doc.expires_at)}`, { x: width - 180, y: y - 38, size: 9, font, color: COLORS.grey });
  }
  if (docType === "invoice" && doc.due_date) {
    page.drawText(`Échéance ${formatDateFR(doc.due_date)}`, { x: width - 180, y: y - 38, size: 9, font, color: COLORS.grey });
  }
  if (docType === "credit_note" && doc.invoice_id) {
    page.drawText(`Réf. facture (id court)`, { x: width - 180, y: y - 38, size: 9, font, color: COLORS.grey });
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
  let foot = 100;
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
    foot -= 10;
  }

  // ─── Bandeau coordonnées de l'émetteur en pied de page ───
  // Ligne séparatrice
  page.drawLine({
    start: { x: 40, y: 50 },
    end: { x: width - 40, y: 50 },
    thickness: 0.5,
    color: COLORS.lineGrey
  });

  // Ligne 1 : nom légal · SIRET · TVA
  const co1 = doc.company_snapshot || company || {};
  const line1Parts = [];
  if (co1.legal_name) line1Parts.push(co1.legal_name);
  if (co1.siret) line1Parts.push(`SIRET ${co1.siret}`);
  if (co1.vat_number) line1Parts.push(`TVA ${co1.vat_number}`);
  if (line1Parts.length > 0) {
    page.drawText(line1Parts.join(" · "), {
      x: 40, y: 38, size: 7, font: fontBold, color: COLORS.dark
    });
  }

  // Ligne 2 : adresse · email · téléphone
  const line2Parts = [];
  const addrParts = [
    co1.address_line1,
    co1.address_line2,
    [co1.postal_code, co1.city].filter(Boolean).join(" "),
    co1.country
  ].filter(Boolean);
  if (addrParts.length > 0) line2Parts.push(addrParts.join(", "));
  if (co1.email) line2Parts.push(co1.email);
  if (co1.phone) line2Parts.push(co1.phone);
  if (line2Parts.length > 0) {
    page.drawText(line2Parts.join(" · ").slice(0, 130), {
      x: 40, y: 27, size: 7, font, color: COLORS.grey
    });
  }

  // Mention discrete "via IO BILL" à droite
  const viaText = "Document généré via IO BILL";
  const viaWidth = font.widthOfTextAtSize(viaText, 6);
  page.drawText(viaText, {
    x: width - 40 - viaWidth, y: 16, size: 6, font, color: COLORS.grey
  });

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

// ──────────────────────────────────────────────────────────────
// LOGO HELPER : telecharge le logo en bytes depuis Supabase Storage
// Le chemin stocke dans companies.logo_url est de la forme "{company_id}/logo.{ext}"
// On genere une URL signee (service_role bypass RLS) et on telecharge l'image.
// ──────────────────────────────────────────────────────────────
export async function fetchLogoBytes(logoPath) {
  if (!logoPath) return null;
  try {
    const url = await signedUrl("company-logos", logoPath, 60);  // 60s suffit
    if (!url) return null;
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    return new Uint8Array(buf);
  } catch (e) {
    console.warn("[fetchLogoBytes] error:", e?.message);
    return null;
  }
}
