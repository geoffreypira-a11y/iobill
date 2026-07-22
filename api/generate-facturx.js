// IO BILL - Generation Factur-X (PDF/A-3 + XML CII embarque)
// Profil cible : BASIC WL — Reference : Factur-X 1.0.07 (FNFE-MPE)
// v8.14 : support des avoirs (credit_notes) en plus des factures (invoices)

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";
import { AFRelationship } from "pdf-lib";
import { buildDocumentPdf, uploadToStorage, signedUrl } from "./_lib/pdf-builder.js";
import { notifyAdmin } from "./_lib/monitor.js";

// Mapping document_type → config table/colonnes
const DOC_CONFIG = {
  invoice: {
    table: "invoices",
    lineType: "invoice",
    typeCode: "380",          // Factur-X : 380 = Commercial invoice
    profile: "urn:factur-x.eu:1p0:basicwl",
    storageBucket: "invoices-pdf",
    fxStatusColumn: "facturx_status",
    fxPdfColumn: "facturx_pdf_url",
    fxXmlColumn: "facturx_xml_url",
    pdfColumn: "pdf_url",
    label: "Facture",
    issuedStatuses: ["issued", "sent", "partial", "paid", "overdue"]
  },
  credit_note: {
    table: "credit_notes",
    lineType: "credit_note",
    typeCode: "381",          // Factur-X : 381 = Credit note
    profile: "urn:factur-x.eu:1p0:basicwl",
    storageBucket: "invoices-pdf", // même bucket — différencié par préfixe nom
    fxStatusColumn: "facturx_status",
    fxPdfColumn: "facturx_pdf_url",
    fxXmlColumn: "facturx_xml_url",
    pdfColumn: "pdf_url",
    label: "Avoir",
    issuedStatuses: ["issued"]
  }
};

export default async function handler(req, res) {
  try {
    return await handleRequest(req, res);
  } catch (e) {
    // Catch global pour éviter les 500 HTML Vercel : on retourne toujours du JSON
    console.error("[generate-facturx] UNCAUGHT", e?.stack || e?.message || e);
    notifyAdmin({
      level: "critical",
      subject: "generate-facturx plante",
      details: { error: e?.message, stack: (e?.stack || "").slice(0, 1000) }
    }).catch(() => {});
    return json(res, 500, {
      error: "Erreur serveur : " + (e?.message || "inconnue"),
      stack_top: (e?.stack || "").split("\n").slice(0, 3).join(" | ")
    });
  }
}

async function handleRequest(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  // v8.37 — Mode INTERNAL : appel server-to-server depuis public.js external
  // après push_invoice / update_invoice_status. Authentifié par secret partagé.
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const isInternal = body?.internal === true;
  let company;

  if (isInternal) {
    const provided = req.headers["x-internal-secret"] || req.headers["X-Internal-Secret"];
    const expected = process.env.IOBILL_INTERNAL_GEN_SECRET
                  || process.env.IOBILL_EXTERNAL_SECRET;
    if (!expected || !provided || provided !== expected) {
      return json(res, 401, { error: "Invalid internal secret" });
    }
    // En mode internal, on récupère la company via le document directement
    const documentType = body?.document_type || (body?.invoice_id ? "invoice" : null);
    if (!documentType || !DOC_CONFIG[documentType]) {
      return json(res, 400, { error: "document_type invalide" });
    }
    const documentId = body?.document_id || body?.invoice_id;
    if (!documentId) return json(res, 400, { error: "document_id requis" });
    const docPre = await sbAdmin.selectOne(DOC_CONFIG[documentType].table, `id=eq.${documentId}`);
    if (!docPre) return json(res, 404, { error: "Document introuvable" });
    company = await sbAdmin.selectOne("companies", `id=eq.${docPre.company_id}`);
    if (!company) return json(res, 404, { error: "Company introuvable" });
  } else {
    // Mode normal : auth user
    const auth = await authenticate(req);
    if (auth.error) return json(res, auth.status, { error: auth.error });
    company = auth.company;
  }

  // Routage du document_type
  // Rétro-compat : invoice_id seul → document_type = "invoice"
  const documentType = body?.document_type || (body?.invoice_id ? "invoice" : null);
  if (!documentType || !DOC_CONFIG[documentType]) {
    return json(res, 400, { error: "document_type invalide (attendu: invoice | credit_note)" });
  }
  const cfg = DOC_CONFIG[documentType];

  const documentId = body?.document_id || body?.invoice_id;
  if (!documentId) return json(res, 400, { error: "document_id (ou invoice_id) requis" });

  const issueMode = body?.issue === true || body?.mode === "issue";
  const preview = body?.preview === true;
  const transmitPdp = body?.transmit_pdp === true || body?.mode === "transmit_pdp";

  const doc = await sbAdmin.selectOne(cfg.table, `id=eq.${documentId}&company_id=eq.${company.id}`);
  if (!doc) return json(res, 404, { error: `${cfg.label} introuvable` });

  // ═══════════════════════════════════════════════════════════
  // MODE : TRANSMISSION PDP (administration fiscale)
  // ⚠️ v8.47.1 — Chemin legacy neutralisé. La transmission passe
  // désormais par l'adapter Plateforme Agréée réel :
  //     POST /api/admin  { action: "pa_send", payload: { invoice_id } }
  // qui utilise pdp_transmission_id sur la vraie PA.
  // Laisser ce code actif écrivait des ID factices "PPF-TEST-..."
  // qui bloquaient ensuite la vraie transmission (déjà transmise).
  // ═══════════════════════════════════════════════════════════
  if (transmitPdp) {
    return json(res, 410, {
      error: "Le chemin de transmission PDP historique est désactivé. Utilisez le bouton « Transmettre » sur la facture qui appelle la Plateforme Agréée configurée par l'admin."
    });
  }

  // ═══════════════════════════════════════════════════════════
  // MODE : ISSUE — passage en "issued" (factures uniquement,
  // les avoirs sont émis via UPDATE direct côté front)
  // ═══════════════════════════════════════════════════════════
  if (issueMode && documentType === "invoice") {
    if (["paid", "canceled"].includes(doc.status)) {
      return json(res, 400, { error: "Cette facture ne peut plus être émise (statut: " + doc.status + ")" });
    }
    if (doc.status === "draft") {
      try {
        const updated = await sbAdmin.update("invoices", `id=eq.${documentId}`, {
          status: "issued",
          issued_at: new Date().toISOString()
        });
        if (!updated || !updated[0]) {
          return json(res, 500, {
            error: "Échec de l'émission. Si vous n'avez pas exécuté la migration v8.10, allez dans Supabase SQL Editor et lancez le contenu de migration_v8_10_fix_hash_chain.sql"
          });
        }
        Object.assign(doc, updated[0]);
      } catch (e) {
        return json(res, 500, { error: "Erreur SQL émission : " + (e.message || "inconnue") });
      }
    }
  }

  // Mode preview : on autorise la génération même sur un brouillon
  if (!preview && !issueMode && !cfg.issuedStatuses.includes(doc.status)) {
    return json(res, 400, { error: `${cfg.label} doit être émis avant de générer le Factur-X` });
  }

  // ═══════════════════════════════════════════════════════════
  // FAST-PATH PREVIEW : si le document est émis (donc immuable
  // par chaîne de hashs) ET qu'un PDF est déjà stocké, on resigne
  // simplement l'URL existante au lieu de tout regénérer.
  // Gain : ~3-5s → ~300ms.
  // ═══════════════════════════════════════════════════════════
  if (preview && !issueMode && cfg.issuedStatuses.includes(doc.status) && doc[cfg.fxPdfColumn]) {
    // Le PDF existe déjà. On a besoin du path pour resigner.
    // doc[cfg.fxPdfColumn] est une URL signée déjà : on en extrait le path.
    const filePrefix = documentType === "credit_note" ? "avoir-" : "";
    const pdfPath = `${company.id}/${filePrefix}${doc.number}.pdf`;
    const xmlPath = `${company.id}/${filePrefix}${doc.number}.xml`;
    const pdfSigned = await signedUrl(cfg.storageBucket, pdfPath, 3600);
    if (pdfSigned) {
      const xmlSigned = await signedUrl(cfg.storageBucket, xmlPath, 3600);
      console.log(`[generate-facturx] FAST-PATH preview pour ${doc.number}`);
      return json(res, 200, {
        ok: true,
        pdf_url: pdfSigned,
        xml_url: xmlSigned,
        cached: true
      });
    }
    // Si la signature échoue (fichier supprimé ?), on retombe sur la
    // régénération normale ci-dessous, ce qui le recréera.
    console.log(`[generate-facturx] FAST-PATH miss pour ${doc.number}, régénération`);
  }

  const lines = await sbAdmin.select("document_lines", {
    filter: `document_type=eq.${cfg.lineType}&document_id=eq.${documentId}`,
    order: "sort_order.asc"
  });

  console.log(`[generate-facturx] doc=${documentType}/${documentId} lines=${(lines || []).length} status=${doc.status}`);

  // 1) XML CII Factur-X
  let xml;
  try {
    xml = buildFacturxXml({ doc, lines: lines || [], company, cfg });
    // v8.48.22 — Log les blocs TVA pour diagnostiquer BR-CO-17.
    const vatBlocks = xml.match(/<ram:ApplicableTradeTax>[\s\S]*?<\/ram:ApplicableTradeTax>/g) || [];
    console.log("[generate-facturx] ApplicableTradeTax count=" + vatBlocks.length);
    vatBlocks.forEach((b, i) => console.log("[generate-facturx] block[" + i + "] " + b.replace(/\s+/g, " ")));
    // Log le breakdown source et les lignes
    console.log("[generate-facturx] doc.vat_breakdown=" + JSON.stringify(doc.vat_breakdown));
    console.log("[generate-facturx] doc.vat_total_cents=" + doc.vat_total_cents + " subtotal_ht=" + doc.subtotal_ht_cents);
    console.log("[generate-facturx] lines=" + JSON.stringify((lines || []).map(l => ({
      total_ht_cents: l.total_ht_cents, vat_rate: l.vat_rate
    }))));
  } catch (e) {
    throw new Error("buildFacturxXml: " + (e?.message || "?"));
  }

  // 2) PDF (builder partagé) + embed XML
  let pdfDoc;
  try {
    pdfDoc = await buildDocumentPdf({
      docType: documentType,
      doc,
      lines: lines || [],
      company
    });
  } catch (e) {
    throw new Error("buildDocumentPdf: " + (e?.message || "?"));
  }

  const xmlBytes = new TextEncoder().encode(xml);
  try {
    await pdfDoc.attach(xmlBytes, "factur-x.xml", {
      mimeType: "application/xml",
      description: documentType === "credit_note" ? "Avoir électronique Factur-X" : "Facture électronique Factur-X",
      creationDate: new Date(),
      modificationDate: new Date(),
      afRelationship: AFRelationship.Alternative
    });
  } catch (e) {
    throw new Error("pdfDoc.attach: " + (e?.message || "?"));
  }

  let pdfBytes;
  try {
    pdfBytes = await pdfDoc.save();
  } catch (e) {
    throw new Error("pdfDoc.save: " + (e?.message || "?"));
  }

  // 3) Upload + URLs signées
  // Prefix "avoir-" pour différencier des factures dans le bucket commun
  const filePrefix = documentType === "credit_note" ? "avoir-" : "";
  const pdfPath = `${company.id}/${filePrefix}${doc.number}.pdf`;
  const xmlPath = `${company.id}/${filePrefix}${doc.number}.xml`;
  const uploadedPdf = await uploadToStorage(cfg.storageBucket, pdfPath, pdfBytes, "application/pdf");
  if (!uploadedPdf) {
    return json(res, 500, { error: `Storage upload failed (pdf) — bucket=${cfg.storageBucket} path=${pdfPath}` });
  }
  const uploadedXml = await uploadToStorage(cfg.storageBucket, xmlPath, xmlBytes, "application/xml");
  if (!uploadedXml) {
    return json(res, 500, { error: `Storage upload failed (xml) — bucket=${cfg.storageBucket} path=${xmlPath}` });
  }
  const pdfSigned = await signedUrl(cfg.storageBucket, pdfPath, 3600);
  const xmlSigned = await signedUrl(cfg.storageBucket, xmlPath, 3600);

  console.log(`[generate-facturx] OK pdf_size=${pdfBytes.length} signed=${!!pdfSigned}`);

  const updatePayload = {
    [cfg.fxStatusColumn]: "generated",
    [cfg.fxPdfColumn]: pdfSigned,
    [cfg.fxXmlColumn]: xmlSigned,
    [cfg.pdfColumn]: pdfSigned
  };
  await sbAdmin.update(cfg.table, `id=eq.${documentId}`, updatePayload);

  return json(res, 200, {
    ok: true,
    pdf_url: pdfSigned,
    xml_url: xmlSigned,
    pdf_size: pdfBytes.length
  });
}

// ─────────────────────────────────────────────────────────────
// XML CII : commun factures/avoirs, différencié par TypeCode
// (380 = facture, 381 = avoir)
// ─────────────────────────────────────────────────────────────
function buildFacturxXml({ doc, lines, company, cfg }) {
  const cs = doc.client_snapshot || {};
  const co = doc.company_snapshot || company;
  const cur = doc.currency || "EUR";
  const dt = (iso) => (iso || "").replace(/-/g, "").slice(0, 8);
  const x = (s) => String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

  const supplierName = x(co.legal_name);
  const buyerName = x(cs.legal_name || `${cs.first_name || ""} ${cs.last_name || ""}`.trim() || "Client");
  // v8.48.21 — Fix BR-CO-14 : reconstruit vat_breakdown depuis les lignes
  // si vide, sinon Σ(TVA par catégorie) ≠ TVA totale et la validation échoue.
  // v8.48.23 — Fix BR-CO-17 : les vraies colonnes de document_lines sont
  // line_ht_cents et line_vat_cents (pas total_ht_cents). Sans ça, la
  // base restait à 0 et le calcul base × rate ne matchait pas la TVA.
  let breakdown = doc.vat_breakdown || [];
  if (!Array.isArray(breakdown) || breakdown.length === 0) {
    const byRate = new Map();
    for (const l of (lines || [])) {
      const rate = Number(l.vat_rate ?? 0);
      // Fallback en cascade sur les noms de colonnes possibles
      const baseC = Number(
        l.line_ht_cents ??
        l.total_ht_cents ??
        (Number(l.unit_price_ht_cents ?? 0) * Number(l.quantity ?? 1)) ??
        0
      );
      const vatC = Number(
        l.line_vat_cents ??
        Math.round(baseC * rate / 100)
      );
      const key = rate.toFixed(2);
      const prev = byRate.get(key) || { rate, base_cents: 0, vat_cents: 0 };
      prev.base_cents += baseC;
      prev.vat_cents += vatC;
      byRate.set(key, prev);
    }
    breakdown = Array.from(byRate.values());
    // Correction d'arrondi cumulatif : force la somme TVA à matcher le total.
    const totalC = Number(doc.vat_total_cents ?? 0);
    const sumC = breakdown.reduce((s, v) => s + v.vat_cents, 0);
    if (breakdown.length > 0 && totalC && sumC !== totalC) {
      breakdown[breakdown.length - 1].vat_cents += (totalC - sumC);
    }
  }
  const vatBlocks = breakdown.map((v) => `
    <ram:ApplicableTradeTax>
      <ram:CalculatedAmount>${(v.vat_cents / 100).toFixed(2)}</ram:CalculatedAmount>
      <ram:TypeCode>VAT</ram:TypeCode>
      <ram:BasisAmount>${(v.base_cents / 100).toFixed(2)}</ram:BasisAmount>
      <ram:CategoryCode>${Number(v.rate) > 0 ? "S" : "E"}</ram:CategoryCode>
      <ram:RateApplicablePercent>${Number(v.rate).toFixed(2)}</ram:RateApplicablePercent>
    </ram:ApplicableTradeTax>`).join("");

  // Pour un avoir : référence à la facture d'origine via BillingReferencedDocument
  let billingRefBlock = "";
  if (cfg.lineType === "credit_note" && doc.invoice_id) {
    // On a déjà fait la requête lines, on n'a pas la facture source ici ;
    // mais on a son numéro via client_snapshot ? Non : on stocke l'id seulement.
    // Astuce : on met l'id pour traçabilité (la facture sera retrouvée côté DGFiP via num).
    billingRefBlock = `<ram:BillingReferencedDocument><ram:IssuerAssignedID>${x(doc.invoice_id)}</ram:IssuerAssignedID></ram:BillingReferencedDocument>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <!-- v8.48.27 — Mode de facturation Chorus Pro requis par BR-FR-08.
         S1 = Service simple (cas standard). Autres valeurs possibles :
         B1/B2/B4/B7/B8/B9 (biens), S1/S2/S3/S4/S5/S6/S7/S8/S9 (services),
         M1/M2/M4/M8/M9 (mixte). -->
    <ram:BusinessProcessSpecifiedDocumentContextParameter>
      <ram:ID>S1</ram:ID>
    </ram:BusinessProcessSpecifiedDocumentContextParameter>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>${cfg.profile}</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${x(doc.number)}</ram:ID>
    <ram:TypeCode>${cfg.typeCode}</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">${dt(doc.issue_date)}</udt:DateTimeString>
    </ram:IssueDateTime>
    <!-- v8.48.24 — Mentions obligatoires FR (BR-FR-05/BT-22) requises par
         SUPER PDP / AFNOR. Sinon la validation lève des warnings bloquants.
         PMT : frais de recouvrement forfaitaires (Art. D. 441-5 Code de commerce)
         PMD : pénalités de retard (Art. L. 441-10 Code de commerce)
         DEP : indemnité forfaitaire d'escompte (Art. L. 441-10) -->
    <ram:IncludedNote>
      <ram:Content>En cas de retard de paiement, une indemnité forfaitaire de 40 € pour frais de recouvrement est due (Art. D. 441-5 du Code de commerce).</ram:Content>
      <ram:SubjectCode>PMT</ram:SubjectCode>
    </ram:IncludedNote>
    <ram:IncludedNote>
      <ram:Content>Tout retard de paiement entraîne l'application de pénalités égales à trois fois le taux d'intérêt légal en vigueur, sans qu'un rappel soit nécessaire (Art. L. 441-10 du Code de commerce).</ram:Content>
      <ram:SubjectCode>PMD</ram:SubjectCode>
    </ram:IncludedNote>
    <ram:IncludedNote>
      <ram:Content>Aucun escompte n'est accordé en cas de paiement anticipé.</ram:Content>
      <ram:SubjectCode>AAB</ram:SubjectCode>
    </ram:IncludedNote>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>${supplierName}</ram:Name>
        ${(() => {
          // v8.48.27 — BR-FR-10 : AFNOR exige SIREN (9 chiffres) avec
          // schemeID="0002" pour le vendeur, même si techniquement 0002=SIRET
          // dans ISO 6523. On extrait toujours les 9 premiers chiffres.
          const raw = String(co.siret || "").replace(/\s/g, "");
          const siren = raw.length === 14 ? raw.slice(0, 9) : (raw.length === 9 ? raw : null);
          if (siren) {
            return `<ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">${x(siren)}</ram:ID></ram:SpecifiedLegalOrganization>`;
          }
          return "";
        })()}
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${x(co.postal_code)}</ram:PostcodeCode>
          <ram:LineOne>${x(co.address_line1)}</ram:LineOne>
          ${co.address_line2 ? `<ram:LineTwo>${x(co.address_line2)}</ram:LineTwo>` : ""}
          <ram:CityName>${x(co.city)}</ram:CityName>
          <ram:CountryID>${x(co.country || "FR")}</ram:CountryID>
        </ram:PostalTradeAddress>
        ${co.vat_number ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${x(co.vat_number)}</ram:ID></ram:SpecifiedTaxRegistration>` : ""}
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>${buyerName}</ram:Name>
        ${(() => {
          // v8.48.27 — Idem BR-FR : SIREN 9 chiffres pour l'acheteur.
          const raw = String(cs.siret || "").replace(/\s/g, "");
          const siren = raw.length === 14 ? raw.slice(0, 9) : (raw.length === 9 ? raw : null);
          if (siren) {
            return `<ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">${x(siren)}</ram:ID></ram:SpecifiedLegalOrganization>`;
          }
          return "";
        })()}
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${x(cs.postal_code)}</ram:PostcodeCode>
          <ram:LineOne>${x(cs.address_line1)}</ram:LineOne>
          ${cs.address_line2 ? `<ram:LineTwo>${x(cs.address_line2)}</ram:LineTwo>` : ""}
          <ram:CityName>${x(cs.city)}</ram:CityName>
          <ram:CountryID>${x(cs.country || "FR")}</ram:CountryID>
        </ram:PostalTradeAddress>
        ${cs.vat_number ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${x(cs.vat_number)}</ram:ID></ram:SpecifiedTaxRegistration>` : ""}
      </ram:BuyerTradeParty>
      ${billingRefBlock}
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>${cur}</ram:InvoiceCurrencyCode>
      ${vatBlocks}
      ${doc.due_date ? `<ram:SpecifiedTradePaymentTerms>
        <ram:DueDateDateTime><udt:DateTimeString format="102">${dt(doc.due_date)}</udt:DateTimeString></ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>` : ""}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${(doc.subtotal_ht_cents / 100).toFixed(2)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${(doc.subtotal_ht_cents / 100).toFixed(2)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="${cur}">${(doc.vat_total_cents / 100).toFixed(2)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${(doc.total_ttc_cents / 100).toFixed(2)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${((doc.total_ttc_cents - (doc.paid_cents || 0)) / 100).toFixed(2)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;
}

// ═══════════════════════════════════════════════════════════
// TRANSMISSION PDP
// ═══════════════════════════════════════════════════════════
async function transmitToPdp({ provider, accountId, apiKey, doc, docType, company }) {
  switch (provider) {
    case "ppf_test":
      return {
        transmission_id: "PPF-TEST-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
        message: "Transmission test (PPF sandbox DGFiP) - aucun envoi réel"
      };
    case "iopole":
      throw new Error("Provider Iopole : intégration prévue en V1.2");
    case "generix":
      throw new Error("Provider Generix : intégration prévue en V1.2");
    case "cegid":
      throw new Error("Provider Cegid : intégration prévue en V1.2");
    default:
      throw new Error("Provider PDP inconnu : " + provider);
  }
}
