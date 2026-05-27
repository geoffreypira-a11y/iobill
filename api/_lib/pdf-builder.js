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

  // ═══════════════════════════════════════════════════════════
  // SANITIZATION AUTOMATIQUE : tous les drawText passent par
  // winAnsiSafe() pour éviter les crashs sur les caractères
  // Unicode non supportés par WinAnsi (StandardFonts).
  // Sources de problèmes typiques : Intl.NumberFormat (U+202F),
  // texte saisi par l'utilisateur (emojis, guillemets typographiques,
  // tirets cadratin, etc.).
  // ═══════════════════════════════════════════════════════════
  const _origDrawText = page.drawText.bind(page);
  page.drawText = (text, opts) => _origDrawText(winAnsiSafe(text), opts);
  const _origWidthOfTextAtSize = font.widthOfTextAtSize.bind(font);
  font.widthOfTextAtSize = (text, size) => _origWidthOfTextAtSize(winAnsiSafe(text), size);
  const _origBoldWidthOfTextAtSize = fontBold.widthOfTextAtSize.bind(fontBold);
  fontBold.widthOfTextAtSize = (text, size) => _origBoldWidthOfTextAtSize(winAnsiSafe(text), size);

  // ═══════════════════════════════════════════════════════════
  // COULEUR D'ACCENTUATION : brand_color de la company
  // L'utilisateur peut la personnaliser dans les parametres.
  // Si non defini, utilise le gold IO BILL par defaut.
  // ═══════════════════════════════════════════════════════════
  const brandRgb = hexToRgb(company?.brand_color || "#d4a843") || COLORS.gold;

  let y = height - 50;

  // ═══════════════════════════════════════════════════════════
  // BANDEAU GOLD HORIZONTAL EN HAUT (pattern IOcar print-doc-bar)
  // ═══════════════════════════════════════════════════════════
  page.drawRectangle({
    x: 40, y: height - 12, width: width - 80, height: 4,
    color: brandRgb
  });

  // ═══════════════════════════════════════════════════════════
  // HEADER (.pdoc-head) : LOGO/NOM gauche + TYPE/REF/CLIENT droite
  // ═══════════════════════════════════════════════════════════
  const co0 = doc.company_snapshot || company || {};
  const cs0 = doc.client_snapshot || {};
  const issuerName = co0.legal_name || "Émetteur";

  // ─── PARTIE GAUCHE : Logo (si dispo) ou nom en grand ───
  let leftBlockY = y;
  let leftBlockBottom = y;

  // 1) Tenter d'embarquer le logo
  let logoEmbedded = false;
  if (company?.logo_url) {
    try {
      const logoBytes = await fetchLogoBytes(company.logo_url);
      if (logoBytes) {
        const isPng = logoBytes[0] === 0x89 && logoBytes[1] === 0x50;
        const isJpg = logoBytes[0] === 0xff && logoBytes[1] === 0xd8;
        let embedded = null;
        if (isPng) embedded = await pdfDoc.embedPng(logoBytes);
        else if (isJpg) embedded = await pdfDoc.embedJpg(logoBytes);
        if (embedded) {
          // Logo max 200x60 (pattern IOcar)
          const maxW = 200, maxH = 60;
          const ratio = Math.min(maxW / embedded.width, maxH / embedded.height);
          const drawW = embedded.width * ratio;
          const drawH = embedded.height * ratio;
          page.drawImage(embedded, {
            x: 40,
            y: y - drawH,
            width: drawW,
            height: drawH
          });
          leftBlockBottom = y - drawH - 8;
          logoEmbedded = true;
        }
      }
    } catch (e) {
      console.warn("[pdf-builder] Logo embed failed:", e?.message);
    }
  }

  // 2) Fallback : nom en GRAND (pattern .pdoc-logo = 26px bold letter-spacing:3px)
  if (!logoEmbedded) {
    const displayName = issuerName.length > 24 ? issuerName.slice(0, 22) + "…" : issuerName;
    page.drawText(displayName.toUpperCase(), {
      x: 40, y: y - 18, size: 22, font: fontBold, color: COLORS.dark
    });
    leftBlockBottom = y - 30;
  }

  // ─── Coordonnees emetteur sous logo/nom (petit gris) ───
  // (pattern IOcar : adresse, tel, email, SIRET, TVA en 10pt gris)
  let yLeft = leftBlockBottom - 4;
  if (co0.address_line1) {
    page.drawText(co0.address_line1.slice(0, 60), { x: 40, y: yLeft, size: 9, font, color: COLORS.grey });
    yLeft -= 11;
  }
  if (co0.address_line2) {
    page.drawText(co0.address_line2.slice(0, 60), { x: 40, y: yLeft, size: 9, font, color: COLORS.grey });
    yLeft -= 11;
  }
  if (co0.postal_code || co0.city) {
    page.drawText(`${co0.postal_code || ""} ${co0.city || ""}`.trim().slice(0, 60), { x: 40, y: yLeft, size: 9, font, color: COLORS.grey });
    yLeft -= 11;
  }
  // Ligne contact : Tel + Email
  const contactParts = [];
  if (co0.phone) contactParts.push(`Tél : ${co0.phone}`);
  if (co0.email) contactParts.push(co0.email);
  if (contactParts.length > 0) {
    page.drawText(contactParts.join(" · ").slice(0, 70), { x: 40, y: yLeft, size: 9, font, color: COLORS.grey });
    yLeft -= 11;
  }
  // Ligne legale : SIRET + TVA
  const legalParts = [];
  if (co0.siret) legalParts.push(`SIRET : ${co0.siret}`);
  if (co0.vat_number) legalParts.push(`TVA : ${co0.vat_number}`);
  if (legalParts.length > 0) {
    page.drawText(legalParts.join(" · ").slice(0, 70), { x: 40, y: yLeft, size: 9, font, color: COLORS.grey });
    yLeft -= 11;
  }

  // ─── PARTIE DROITE : Type document + Ref + CLIENT ───
  // Type document en GROS GOLD (pattern .pdoc-type)
  const typeWidth = fontBold.widthOfTextAtSize(L.title, 20);
  page.drawText(L.title, { x: width - 40 - typeWidth, y: y - 4, size: 20, font: fontBold, color: brandRgb });

  // Numéro
  const refText = `N° ${doc.number}`;
  const refWidth = font.widthOfTextAtSize(refText, 11);
  page.drawText(refText, { x: width - 40 - refWidth, y: y - 22, size: 11, font: fontBold, color: COLORS.dark });

  // Date
  const dateText = `Date : ${formatDateFR(doc.issue_date)}`;
  const dateWidth = font.widthOfTextAtSize(dateText, 9);
  page.drawText(dateText, { x: width - 40 - dateWidth, y: y - 38, size: 9, font, color: COLORS.grey });

  // Date supplémentaire selon type
  let extraDateY = y - 50;
  if (docType === "quote" && doc.expires_at) {
    const txt = `Valable jusqu'au : ${formatDateFR(doc.expires_at)}`;
    const w = font.widthOfTextAtSize(txt, 9);
    page.drawText(txt, { x: width - 40 - w, y: extraDateY, size: 9, font, color: COLORS.grey });
    extraDateY -= 12;
  }
  if (docType === "invoice" && doc.due_date) {
    const txt = `Échéance : ${formatDateFR(doc.due_date)}`;
    const w = font.widthOfTextAtSize(txt, 9);
    page.drawText(txt, { x: width - 40 - w, y: extraDateY, size: 9, font, color: COLORS.grey });
    extraDateY -= 12;
  }

  // ─── BLOC CLIENT à droite, sous une ligne grise (pattern IOcar) ───
  let clientBlockTop = extraDateY - 10;
  // Ligne separatrice grise
  page.drawLine({
    start: { x: width - 240, y: clientBlockTop + 2 },
    end: { x: width - 40, y: clientBlockTop + 2 },
    thickness: 0.5,
    color: COLORS.lineGrey
  });
  clientBlockTop -= 10;

  // Label "CLIENT" en petit gris majuscule (pattern .pdoc-plabel)
  const clientLabel = "CLIENT";
  const clientLabelWidth = fontBold.widthOfTextAtSize(clientLabel, 8);
  page.drawText(clientLabel, {
    x: width - 40 - clientLabelWidth, y: clientBlockTop,
    size: 8, font: fontBold, color: COLORS.grey
  });
  clientBlockTop -= 14;

  // Nom client en gras (pattern .pdoc-pname)
  const clientName = cs0.legal_name || `${cs0.first_name || ""} ${cs0.last_name || ""}`.trim() || "Client";
  const clientNameDisplay = clientName.length > 32 ? clientName.slice(0, 30) + "…" : clientName;
  const clientNameWidth = fontBold.widthOfTextAtSize(clientNameDisplay, 12);
  page.drawText(clientNameDisplay, {
    x: width - 40 - clientNameWidth, y: clientBlockTop,
    size: 12, font: fontBold, color: COLORS.dark
  });
  clientBlockTop -= 14;

  // Infos client (pattern .pdoc-pinfo) en petit gris
  function drawRightLine(text, yy, size = 9, color = COLORS.grey) {
    if (!text) return yy;
    const trimmed = String(text).slice(0, 50);
    const w = font.widthOfTextAtSize(trimmed, size);
    page.drawText(trimmed, { x: width - 40 - w, y: yy, size, font, color });
    return yy - 11;
  }
  if (cs0.contact_person) clientBlockTop = drawRightLine(cs0.contact_person, clientBlockTop);
  if (cs0.address_line1) clientBlockTop = drawRightLine(cs0.address_line1, clientBlockTop);
  if (cs0.address_line2) clientBlockTop = drawRightLine(cs0.address_line2, clientBlockTop);
  if (cs0.postal_code || cs0.city) clientBlockTop = drawRightLine(`${cs0.postal_code || ""} ${cs0.city || ""}`.trim(), clientBlockTop);
  if (cs0.country) clientBlockTop = drawRightLine(cs0.country, clientBlockTop);
  if (cs0.email) clientBlockTop = drawRightLine(cs0.email, clientBlockTop);
  if (cs0.phone) clientBlockTop = drawRightLine(cs0.phone, clientBlockTop);

  // y = en dessous du bloc le plus bas (entre coordonnees emetteur et client) + divider
  y = Math.min(yLeft, clientBlockTop) - 14;

  // ─── Divider horizontal (pattern .pdoc-divider) ───
  page.drawLine({
    start: { x: 40, y: y + 4 },
    end: { x: width - 40, y: y + 4 },
    thickness: 0.5,
    color: COLORS.lineGrey
  });
  y -= 14;

  // alias pour compatibilite avec code suivant
  const cs = cs0;
  const co = co0;

  // ═══════════════════════════════════════════════════════════
  // v8.38 — MODE GARAGE : bloc véhicule encadré
  //
  // Affiché uniquement si business_mode='garage' ET vehicle_meta présent.
  // Pattern visuel inspiré de la facture IOCAR : encadré gold, label gris
  // discret en haut, infos sur 2 colonnes. Reste compatible Factur-X car
  // c'est juste de l'affichage PDF (pas dans l'XML).
  // ═══════════════════════════════════════════════════════════
  if (doc.business_mode === "garage" && doc.vehicle_meta && typeof doc.vehicle_meta === "object") {
    const vm = doc.vehicle_meta;
    const vehLabel = [vm.marque, vm.modele, vm.finition].filter(Boolean).join(" ");
    if (vehLabel || vm.plate) {
      // Hauteur du bloc : 50px de base + 14 par ligne d'info (2 colonnes)
      const blockH = 56;
      const blockW = width - 80;
      const blockY = y - blockH + 14;

      // Encadré gold subtil
      page.drawRectangle({
        x: 40, y: blockY,
        width: blockW, height: blockH,
        borderColor: brandRgb,
        borderWidth: 0.8,
        color: rgb(0.99, 0.97, 0.92), // gold très léger
        opacity: 1
      });

      // Label en haut à gauche
      page.drawRectangle({
        x: 44, y: y + 8,
        width: 72, height: 12,
        color: brandRgb
      });
      page.drawText("VÉHICULE", { x: 52, y: y + 11, size: 8, font: fontBold, color: rgb(1, 1, 1) });

      // Ligne 1 : marque / modèle / finition + plaque encadrée à droite
      const titleY = y - 8;
      page.drawText(vehLabel || "Véhicule", { x: 50, y: titleY, size: 11, font: fontBold, color: COLORS.dark });

      if (vm.plate) {
        // Plaque comme un mini-encadré noir gold (style plaque française)
        const plateText = String(vm.plate).toUpperCase();
        const plateW = fontBold.widthOfTextAtSize(plateText, 10) + 16;
        page.drawRectangle({
          x: width - 40 - plateW - 4,
          y: titleY - 4,
          width: plateW,
          height: 16,
          color: COLORS.dark,
          borderColor: brandRgb,
          borderWidth: 0.5
        });
        page.drawText(plateText, {
          x: width - 40 - plateW + 4,
          y: titleY,
          size: 10, font: fontBold,
          color: brandRgb
        });
      }

      // Ligne 2 + 3 : infos sur 2 colonnes (gauche / droite)
      const infosLeft = [];
      const infosRight = [];
      if (vm.kilometrage) infosLeft.push(`Kilométrage : ${Number(vm.kilometrage).toLocaleString("fr-FR")} km`);
      if (vm.annee) infosLeft.push(`Année : ${vm.annee}`);
      if (vm.carburant) infosLeft.push(`Carburant : ${vm.carburant}`);
      if (vm.vin) infosRight.push(`VIN : ${vm.vin}`);
      if (vm.genre) infosRight.push(`Genre : ${vm.genre}`);

      let infoY = titleY - 14;
      const maxInfoLines = Math.max(infosLeft.length, infosRight.length);
      for (let i = 0; i < maxInfoLines; i++) {
        if (infosLeft[i]) page.drawText(infosLeft[i], { x: 50, y: infoY, size: 8, font, color: COLORS.grey });
        if (infosRight[i]) page.drawText(infosRight[i], { x: width / 2, y: infoY, size: 8, font, color: COLORS.grey });
        infoY -= 11;
      }

      y = blockY - 10; // espace après le bloc
    }
  }

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
  y -= 8;
  // Ligne gold AU-DESSUS du texte Total TTC (pas à travers)
  page.drawLine({ start: { x: totalsX, y: y + 16 }, end: { x: width - 40, y: y + 16 }, thickness: 1, color: brandRgb });
  const totalLabel = docType === "credit_note" ? "Total à déduire" : "Total TTC";
  page.drawText(totalLabel, { x: totalsX, y, size: 12, font: fontBold, color: brandRgb });
  // Note : on utilise le hyphen-minus (U+002D) au lieu du minus sign (U+2212)
  // car StandardFonts.Helvetica utilise l'encoding WinAnsi qui ne supporte pas U+2212.
  const totalValue = (docType === "credit_note" ? "- " : "") + formatEUR(doc.total_ttc_cents);
  drawRight(page, totalValue, width - 40, y, 12, fontBold, brandRgb);
  y -= 24;

  // Reste a payer (factures uniquement)
  if (docType === "invoice" && (doc.paid_cents || 0) > 0) {
    page.drawText("Déjà encaissé", { x: totalsX, y, size: 9, font, color: COLORS.green });
    drawRight(page, "- " + formatEUR(doc.paid_cents), width - 40, y, 9, font, COLORS.green);
    y -= 14;
    page.drawText("Reste à régler", { x: totalsX, y, size: 10, font: fontBold, color: COLORS.dark });
    drawRight(page, formatEUR(doc.total_ttc_cents - doc.paid_cents), width - 40, y, 10, fontBold, COLORS.dark);
    y -= 18;
  }

  // ─── Bloc IBAN (factures, paiement par virement) ───
  // Conditions d'affichage :
  //   • Type = facture (pas devis/avoir)
  //   • Toggle show_payment_iban !== false (NULL ou TRUE → afficher)
  //   • IBAN renseigné
  //   • Facture pas encore intégralement payée ni annulée
  const coIban = doc.company_snapshot || company || {};
  const ibanToggle = doc.show_payment_iban !== false;
  const hasIban = docType === "invoice"
    && ibanToggle
    && coIban.iban
    && doc.status !== "paid"
    && doc.status !== "canceled";
  if (hasIban) {
    // Calcul des lignes effectivement à dessiner
    const infoLines = [];
    if (coIban.bank_name) infoLines.push(coIban.bank_name);
    infoLines.push(`IBAN : ${coIban.iban}`);
    if (coIban.bic) infoLines.push(`BIC : ${coIban.bic}`);

    // Dimensions
    const bx = 40, bw = 280;
    const padX = 12, padTop = 12, padBottom = 14;
    const titleSize = 9;
    const lineSize = 8.5;
    const titleGap = 10;       // espace après le titre
    const lineHeight = 12;     // entre lignes infos
    const bh = padTop + titleSize + titleGap + (infoLines.length * lineHeight) + padBottom - lineHeight;
    // Bord supérieur de l'encadré aligné au début des totaux
    const boxTop = y + 12;     // léger overhang au-dessus de y pour aérer
    const boxBottom = boxTop - bh;

    // 1) Fond légèrement teinté gold (un peu plus visible qu'avant)
    page.drawRectangle({
      x: bx, y: boxBottom, width: bw, height: bh,
      color: rgb(brandRgb.red, brandRgb.green, brandRgb.blue),
      opacity: 0.06
    });
    // 2) Bordure gold fine
    page.drawRectangle({
      x: bx, y: boxBottom, width: bw, height: bh,
      borderColor: brandRgb, borderWidth: 0.8,
      color: rgb(1, 1, 1), opacity: 0  // pas de fill, juste la bordure
    });
    // 3) Barre verticale gold accent à gauche (touche pro)
    page.drawRectangle({
      x: bx, y: boxBottom, width: 3, height: bh,
      color: brandRgb
    });

    // 4) Titre
    let iy = boxTop - padTop - titleSize + 2;
    page.drawText("Paiement par virement bancaire", {
      x: bx + padX, y: iy, size: titleSize, font: fontBold, color: brandRgb
    });
    // Ligne fine de séparation sous le titre
    iy -= 5;
    page.drawLine({
      start: { x: bx + padX, y: iy },
      end: { x: bx + bw - padX, y: iy },
      thickness: 0.3, color: brandRgb, opacity: 0.4
    });

    // 5) Lignes infos
    iy -= titleGap;
    for (const line of infoLines) {
      page.drawText(line, {
        x: bx + padX, y: iy, size: lineSize, font, color: COLORS.dark
      });
      iy -= lineHeight;
    }
    // On ne touche pas à `y` (l'encadré est à gauche, les totaux à droite)
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

  // ═══════════════════════════════════════════════════════════
  // v8.39 — MODE GARAGE : mentions métier
  //
  // Affiché si business_mode='garage'. Base = company.business_mentions
  // (mentions globales saisies dans Paramètres > Mentions garage côté
  // IOCAR). On les surcharge avec doc.business_mentions si présent
  // (overrides par-facture : durée garantie variable, date de cession).
  // Format : un bloc par mention avec label discret (garantie, cession, conditions).
  // ═══════════════════════════════════════════════════════════
  if (doc.business_mode === "garage") {
    const globalMentions = (company.business_mentions && typeof company.business_mentions === "object")
      ? company.business_mentions : {};
    const orderOverrides = (doc.business_mentions && typeof doc.business_mentions === "object")
      ? doc.business_mentions : {};

    // Construction de la mention garantie finale :
    //   - Si l'order force "sans garantie" (override total), on l'utilise
    //   - Sinon : mention globale + suffix durée si fourni par l'order
    let mentionGarantie = null;
    if (orderOverrides.garantie_override) {
      mentionGarantie = String(orderOverrides.garantie_override);
    } else if (globalMentions.garantie) {
      mentionGarantie = String(globalMentions.garantie);
      if (orderOverrides.garantie_duree) {
        mentionGarantie = `Durée applicable à cette facture : ${orderOverrides.garantie_duree}. ` + mentionGarantie;
      }
    }

    // Mention conditions : globale seulement
    const mentionConditions = globalMentions.conditions_vente
      ? String(globalMentions.conditions_vente) : null;

    // Mention cession : globale + date spécifique de l'order si fournie
    let mentionCession = null;
    if (globalMentions.cession) {
      mentionCession = String(globalMentions.cession);
      if (orderOverrides.cession_date) {
        mentionCession = `Cession effectuée le ${orderOverrides.cession_date}` +
          (orderOverrides.cession_heure ? ` à ${orderOverrides.cession_heure}` : '') +
          `. ` + mentionCession;
      }
    } else if (orderOverrides.cession_date) {
      // Pas de mention globale, mais date de cession sur l'order → mention minimale
      mentionCession = `Cession effectuée le ${orderOverrides.cession_date}` +
        (orderOverrides.cession_heure ? ` à ${orderOverrides.cession_heure}` : '') + `.`;
    }

    const blocs = [];
    if (mentionGarantie) blocs.push({ label: "GARANTIE", text: mentionGarantie });
    if (mentionConditions) blocs.push({ label: "CONDITIONS DE VENTE", text: mentionConditions });
    if (mentionCession) blocs.push({ label: "CESSION", text: mentionCession });

    if (blocs.length > 0) {
      y -= 8;
      for (const b of blocs) {
        page.drawText(b.label, { x: 40, y, size: 7, font: fontBold, color: brandRgb });
        y -= 10;
        const consumedLines = Math.max(1, Math.ceil((b.text.length || 0) / 110));
        drawWrapped(page, b.text, 40, y, width - 80, font, 8, COLORS.dark, 10);
        y -= 10 * consumedLines + 4;
      }
    }
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
  } else if (company.vat_regime === "margin_297a" || doc.vat_regime === "margin_297a") {
    // v8.39 — Mention TVA marge (régime spécifique aux véhicules d'occasion, brocanteurs, etc.)
    foot = drawWrapped(
      page,
      "Régime de la TVA sur la marge bénéficiaire — art. 297 A du CGI. La TVA n'est pas déductible pour l'acquéreur.",
      40, foot, width - 80, font, 8, COLORS.grey, 11
    ) - 6;
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
  // Intl.NumberFormat en fr-FR sur Node 20+ utilise U+202F (NARROW NO-BREAK SPACE)
  // entre les milliers, qui n'est PAS supporté par WinAnsi (l'encoding des
  // StandardFonts de pdf-lib). Idem pour autres séparateurs invisibles.
  // On sanitize la sortie pour éviter les crashs PDF.
  return winAnsiSafe(
    new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format((cents || 0) / 100)
  );
}

export function formatDateFR(iso) {
  if (!iso) return "—";
  return winAnsiSafe(new Date(iso).toLocaleDateString("fr-FR"));
}

// ──────────────────────────────────────────────────────────────
// WINANSI SANITIZER
// Remplace les caractères Unicode non supportés par WinAnsi (CP1252)
// par leur équivalent ASCII le plus proche, ou les retire.
// Évite les crashs `WinAnsi cannot encode "X"` de pdf-lib.
// ──────────────────────────────────────────────────────────────
export function winAnsiSafe(s) {
  if (s == null) return "";
  return String(s)
    // Espaces fines / insécables non-WinAnsi → espace normal
    .replace(/[\u2009\u200A\u200B\u202F]/g, " ")
    // U+00A0 (non-break space) EST dans WinAnsi mais visuellement bizarre → espace normal
    .replace(/\u00A0/g, " ")
    // Tirets typographiques non-WinAnsi → hyphen-minus
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    // Guillemets typographiques → ASCII
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    // Puces → astérisque
    .replace(/[\u2022\u2023\u25E6]/g, "*")
    // Tous les autres caractères Unicode > 255 NON listés au-dessus :
    // on retire pour être safe (sauf ceux explicitement mappés ailleurs).
    .replace(/[\u0100-\u20AB\u20AD-\uFFFF]/g, "");
  // Note : U+20AC (€) est PRÉSERVÉ car il est dans WinAnsi à 0x80.
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

// Convertit "#d4a843" en rgb(0.83, 0.66, 0.26) pour pdf-lib
function hexToRgb(hex) {
  if (!hex || typeof hex !== "string") return null;
  const clean = hex.replace("#", "").trim();
  if (clean.length !== 6) return null;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return rgb(r / 255, g / 255, b / 255);
}
