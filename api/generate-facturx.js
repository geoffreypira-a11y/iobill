// IO BILL - Generation Factur-X (PDF/A-3 + XML CII embarque)
// Profil cible : BASIC WL — Reference : Factur-X 1.0.07 (FNFE-MPE)

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";
import { AFRelationship } from "pdf-lib";
import { buildDocumentPdf, uploadToStorage, signedUrl } from "./_lib/pdf-builder.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { company } = auth;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const invoiceId = body?.invoice_id;
  const issueMode = body?.issue === true || body?.mode === "issue";
  const preview = body?.preview === true;
  const transmitPdp = body?.transmit_pdp === true || body?.mode === "transmit_pdp";
  if (!invoiceId) return json(res, 400, { error: "invoice_id required" });

  const inv = await sbAdmin.selectOne("invoices", `id=eq.${invoiceId}&company_id=eq.${company.id}`);
  if (!inv) return json(res, 404, { error: "Invoice not found" });

  // ═══════════════════════════════════════════════════════════
  // MODE : TRANSMISSION PDP (administration fiscale)
  // ═══════════════════════════════════════════════════════════
  if (transmitPdp) {
    // 1) La facture doit etre emise
    if (!["issued", "sent", "partial", "paid", "overdue"].includes(inv.status)) {
      return json(res, 400, {
        error: "La facture doit etre emise avant d'etre transmise. Cliquez d'abord sur 🔒 Emettre."
      });
    }
    // 2) Verifier qu'une PDP est configuree
    if (!company.pdp_provider) {
      return json(res, 400, {
        error: "Aucune PDP configuree. Allez dans Parametres → 🏛️ PDP pour configurer votre Plateforme de Dematerialisation Partenaire."
      });
    }
    if (!company.pdp_api_key_encrypted && company.pdp_provider !== "ppf_test") {
      return json(res, 400, {
        error: "Cle API PDP manquante. Allez dans Parametres → 🏛️ PDP pour la configurer."
      });
    }
    // 3) Verifier qu'elle n'a pas deja ete transmise
    if (inv.pdp_transmitted_at) {
      return json(res, 400, {
        error: "Facture deja transmise le " + new Date(inv.pdp_transmitted_at).toLocaleDateString("fr-FR") + " (provider: " + (inv.pdp_provider || "?") + ", ID: " + (inv.pdp_transmission_id || "?") + ")"
      });
    }
    // 4) Transmission selon le provider
    try {
      const transmissionResult = await transmitToPdp({
        provider: company.pdp_provider,
        accountId: company.pdp_account_id,
        apiKey: company.pdp_api_key_encrypted,
        invoice: inv,
        company
      });
      // 5) Marquer la facture comme transmise
      await sbAdmin.update("invoices", `id=eq.${invoiceId}`, {
        pdp_provider: company.pdp_provider,
        pdp_transmission_id: transmissionResult.transmission_id,
        pdp_transmitted_at: new Date().toISOString(),
        facturx_status: "transmitted"
      });
      return json(res, 200, {
        ok: true,
        transmission_id: transmissionResult.transmission_id,
        provider: company.pdp_provider,
        message: transmissionResult.message || "Facture transmise a l'administration"
      });
    } catch (e) {
      return json(res, 500, {
        error: "Echec de transmission : " + (e.message || "erreur inconnue") + ". Verifiez votre configuration PDP."
      });
    }
  }

  // ═══════════════════════════════════════════════════════════

  // Mode "issue" : on emet la facture (passe en status=issued) en bypass RLS,
  // puis on continue avec la generation du PDF Factur-X.
  if (issueMode) {
    // Tolerance : si deja emise on continue (idempotent), sinon on bloque les statuts finaux
    if (["paid", "canceled"].includes(inv.status)) {
      return json(res, 400, { error: "Cette facture ne peut plus etre emise (statut: " + inv.status + ")" });
    }
    // Si elle est en draft, on l'emet maintenant
    if (inv.status === "draft") {
      const updated = await sbAdmin.update("invoices", `id=eq.${invoiceId}`, {
        status: "issued",
        issued_at: new Date().toISOString()
      });
      if (!updated || !updated[0]) {
        return json(res, 500, { error: "Echec de l'emission : verifiez les policies RLS sur invoices" });
      }
      Object.assign(inv, updated[0]);
    }
    // Sinon (issued/sent/partial/overdue) : on continue, c'est idempotent
  }

  // Mode preview : on autorise la generation meme sur un brouillon
  if (!preview && !issueMode && !["issued", "sent", "partial", "paid", "overdue"].includes(inv.status)) {
    return json(res, 400, { error: "Invoice must be issued before generating Factur-X" });
  }

  const lines = await sbAdmin.select("document_lines", {
    filter: `document_type=eq.invoice&document_id=eq.${invoiceId}`,
    order: "sort_order.asc"
  });

  // 1) XML CII Factur-X
  const xml = buildFacturxXml({ invoice: inv, lines: lines || [], company });

  // 2) PDF (builder partage) + embed XML
  const pdfDoc = await buildDocumentPdf({
    docType: "invoice",
    doc: inv,
    lines: lines || [],
    company
  });

  const xmlBytes = new TextEncoder().encode(xml);
  await pdfDoc.attach(xmlBytes, "factur-x.xml", {
    mimeType: "application/xml",
    description: "Facture electronique Factur-X",
    creationDate: new Date(),
    modificationDate: new Date(),
    afRelationship: AFRelationship.Alternative
  });

  const pdfBytes = await pdfDoc.save();

  // 3) Upload + URLs signees
  const pdfPath = `${company.id}/${inv.number}.pdf`;
  const xmlPath = `${company.id}/${inv.number}.xml`;
  if (!(await uploadToStorage("invoices-pdf", pdfPath, pdfBytes, "application/pdf"))) {
    return json(res, 500, { error: "Storage upload failed (pdf)" });
  }
  if (!(await uploadToStorage("invoices-pdf", xmlPath, xmlBytes, "application/xml"))) {
    return json(res, 500, { error: "Storage upload failed (xml)" });
  }
  const pdfSigned = await signedUrl("invoices-pdf", pdfPath, 3600);
  const xmlSigned = await signedUrl("invoices-pdf", xmlPath, 3600);

  await sbAdmin.update("invoices", `id=eq.${invoiceId}`, {
    facturx_status: "generated",
    facturx_pdf_url: pdfSigned,
    facturx_xml_url: xmlSigned,
    pdf_url: pdfSigned
  });

  return json(res, 200, {
    ok: true,
    pdf_url: pdfSigned,
    xml_url: xmlSigned,
    pdf_size: pdfBytes.length
  });
}

function buildFacturxXml({ invoice, lines, company }) {
  const cs = invoice.client_snapshot || {};
  const co = invoice.company_snapshot || company;
  const cur = invoice.currency || "EUR";
  const profile = "urn:factur-x.eu:1p0:basicwl";
  const dt = (iso) => (iso || "").replace(/-/g, "").slice(0, 8);
  const x = (s) => String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

  const supplierName = x(co.legal_name);
  const buyerName = x(cs.legal_name || `${cs.first_name || ""} ${cs.last_name || ""}`.trim() || "Client");
  const breakdown = invoice.vat_breakdown || [];
  const vatBlocks = breakdown.map((v) => `
    <ram:ApplicableTradeTax>
      <ram:CalculatedAmount>${(v.vat_cents / 100).toFixed(2)}</ram:CalculatedAmount>
      <ram:TypeCode>VAT</ram:TypeCode>
      <ram:BasisAmount>${(v.base_cents / 100).toFixed(2)}</ram:BasisAmount>
      <ram:CategoryCode>${Number(v.rate) > 0 ? "S" : "E"}</ram:CategoryCode>
      <ram:RateApplicablePercent>${Number(v.rate).toFixed(2)}</ram:RateApplicablePercent>
    </ram:ApplicableTradeTax>`).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>${profile}</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${x(invoice.number)}</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">${dt(invoice.issue_date)}</udt:DateTimeString>
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
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>${cur}</ram:InvoiceCurrencyCode>
      ${vatBlocks}
      ${invoice.due_date ? `<ram:SpecifiedTradePaymentTerms>
        <ram:DueDateDateTime><udt:DateTimeString format="102">${dt(invoice.due_date)}</udt:DateTimeString></ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>` : ""}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${(invoice.subtotal_ht_cents / 100).toFixed(2)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${(invoice.subtotal_ht_cents / 100).toFixed(2)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="${cur}">${(invoice.vat_total_cents / 100).toFixed(2)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${(invoice.total_ttc_cents / 100).toFixed(2)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${((invoice.total_ttc_cents - (invoice.paid_cents || 0)) / 100).toFixed(2)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;
}

// ═══════════════════════════════════════════════════════════
// TRANSMISSION PDP
// Switch selon le provider configure par l'utilisateur.
// Pour la beta : ppf_test fait un faux retour, les vrais providers
// retournent une erreur "non implemente" jusqu'a integration V1.2.
// ═══════════════════════════════════════════════════════════
async function transmitToPdp({ provider, accountId, apiKey, invoice, company }) {
  switch (provider) {
    case "ppf_test":
      // Sandbox DGFiP : simulation pour tests. Retourne un ID factice.
      return {
        transmission_id: "PPF-TEST-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
        message: "Transmission test (PPF sandbox DGFiP) - aucun envoi reel"
      };

    case "iopole":
      // V1.2 : appel API Iopole reel
      // const r = await fetch("https://api.iopole.fr/v1/invoices", {
      //   method: "POST",
      //   headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      //   body: JSON.stringify({ ... })
      // });
      throw new Error("Provider Iopole : integration prevue en V1.2");

    case "generix":
      throw new Error("Provider Generix : integration prevue en V1.2");

    case "cegid":
      throw new Error("Provider Cegid : integration prevue en V1.2");

    default:
      throw new Error("Provider PDP inconnu : " + provider);
  }
}
