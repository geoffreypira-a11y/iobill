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
  if (!invoiceId) return json(res, 400, { error: "invoice_id required" });

  const inv = await sbAdmin.selectOne("invoices", `id=eq.${invoiceId}&company_id=eq.${company.id}`);
  if (!inv) return json(res, 404, { error: "Invoice not found" });
  if (!["issued", "sent", "partial", "paid", "overdue"].includes(inv.status)) {
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
