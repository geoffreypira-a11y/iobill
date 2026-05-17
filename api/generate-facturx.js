// IO BILL - Generation Factur-X (PDF/A-3 + XML CII embarque)
// Profil cible : BASIC WL — Reference : Factur-X 1.0.07 (FNFE-MPE)
// v8.14 : support des avoirs (credit_notes) en plus des factures (invoices)

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";
import { AFRelationship } from "pdf-lib";
import { buildDocumentPdf, uploadToStorage, signedUrl } from "./_lib/pdf-builder.js";

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
    return json(res, 500, {
      error: "Erreur serveur : " + (e?.message || "inconnue"),
      stack_top: (e?.stack || "").split("\n").slice(0, 3).join(" | ")
    });
  }
}

async function handleRequest(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { company } = auth;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

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
  // ═══════════════════════════════════════════════════════════
  if (transmitPdp) {
    if (!cfg.issuedStatuses.includes(doc.status)) {
      return json(res, 400, {
        error: `Le document doit être émis avant d'être transmis. Cliquez d'abord sur 🔒 Émettre.`
      });
    }
    if (!company.pdp_provider) {
      return json(res, 400, {
        error: "Aucune PDP configurée. Allez dans Paramètres → 🏛️ PDP pour configurer votre Plateforme de Dématérialisation Partenaire."
      });
    }
    if (!company.pdp_api_key_encrypted && company.pdp_provider !== "ppf_test") {
      return json(res, 400, {
        error: "Clé API PDP manquante. Allez dans Paramètres → 🏛️ PDP pour la configurer."
      });
    }
    if (doc.pdp_transmitted_at) {
      return json(res, 400, {
        error: `${cfg.label} déjà transmis le ` + new Date(doc.pdp_transmitted_at).toLocaleDateString("fr-FR") + " (provider: " + (doc.pdp_provider || "?") + ", ID: " + (doc.pdp_transmission_id || "?") + ")"
      });
    }
    try {
      const transmissionResult = await transmitToPdp({
        provider: company.pdp_provider,
        accountId: company.pdp_account_id,
        apiKey: company.pdp_api_key_encrypted,
        doc,
        docType: documentType,
        company
      });
      const updatePayload = {
        pdp_provider: company.pdp_provider,
        pdp_transmission_id: transmissionResult.transmission_id,
        pdp_transmitted_at: new Date().toISOString(),
        facturx_status: "transmitted"
      };
      await sbAdmin.update(cfg.table, `id=eq.${documentId}`, updatePayload);
      return json(res, 200, {
        ok: true,
        transmission_id: transmissionResult.transmission_id,
        provider: company.pdp_provider,
        message: transmissionResult.message || `${cfg.label} transmis à l'administration`
      });
    } catch (e) {
      return json(res, 500, {
        error: "Échec de transmission : " + (e.message || "erreur inconnue") + ". Vérifiez votre configuration PDP."
      });
    }
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
  const breakdown = doc.vat_breakdown || [];
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
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>${supplierName}</ram:Name>
        ${co.siret ? `<ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">${x(co.siret)}</ram:ID></ram:SpecifiedLegalOrganization>` : ""}
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
        ${cs.siret ? `<ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">${x(cs.siret)}</ram:ID></ram:SpecifiedLegalOrganization>` : ""}
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
