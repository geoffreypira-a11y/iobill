// IO BILL — src/lib/e-invoice-xml.js
// ════════════════════════════════════════════════════════════════════
// Lecture d'une facture électronique au format XML.
//
// Une facture reçue par la Plateforme Agréée n'est pas toujours un PDF :
// un fournisseur qui émet en Peppol (cas d'OVH) transmet un XML seul,
// CII (UN/CEFACT — le socle de Factur-X) ou UBL 2.1. Ce module en extrait
// de quoi l'afficher comme une facture. Le XML reste la pièce qui fait foi.
//
// Aucune dépendance au navigateur hormis DOMParser, ce qui rend le module
// testable en Node en injectant une implémentation DOM.
// ════════════════════════════════════════════════════════════════════

/* ─── Navigation XML par nom local (les préfixes ram:/cbc: varient) ─── */
const local = (n) => n.localName || String(n.nodeName).split(":").pop();
// On passe par childNodes plutôt que children : l'implémentation DOM
// minimale n'expose pas toujours children, et on veut pouvoir tester hors
// navigateur.
const kids = (node, name) =>
  node
    ? Array.from(node.childNodes || []).filter(
        (c) => c.nodeType === 1 && local(c) === name
      )
    : [];
const kid = (node, name) => kids(node, name)[0] || null;
const dig = (node, ...names) => names.reduce((n, name) => kid(n, name), node);
const txt = (node) => (node && node.textContent ? node.textContent.trim() : "");
const digTxt = (node, ...names) => txt(dig(node, ...names));

/* ─── Formatage ─── */
export function eur(v, currency = "EUR") {
  const n = parseFloat(String(v).replace(",", "."));
  if (!isFinite(n)) return "—";
  try {
    return n.toLocaleString("fr-FR", { style: "currency", currency });
  } catch {
    return n.toFixed(2) + " " + currency;
  }
}
export function num(v) {
  const n = parseFloat(String(v).replace(",", "."));
  return isFinite(n) ? n.toLocaleString("fr-FR", { maximumFractionDigits: 4 }) : "—";
}
/** CII format 102 = AAAAMMJJ ; UBL = AAAA-MM-JJ. */
export function dateFr(v) {
  if (!v) return "";
  const s = String(v).trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
  return s;
}

/* ─── CII (UN/CEFACT) — Factur-X, profils MINIMUM à EXTENDED ─── */
function parseCII(root) {
  const exch = dig(root, "ExchangedDocument");
  const tx = dig(root, "SupplyChainTradeTransaction");
  const agreement = dig(tx, "ApplicableHeaderTradeAgreement");
  const settlement = dig(tx, "ApplicableHeaderTradeSettlement");
  const sums = dig(settlement, "SpecifiedTradeSettlementHeaderMonetarySummation");

  const party = (p) => {
    if (!p) return null;
    const addr = kid(p, "PostalTradeAddress");
    const vat = kids(p, "SpecifiedTaxRegistration")
      .map((r) => digTxt(r, "ID"))
      .filter(Boolean);
    return {
      name: digTxt(p, "Name"),
      lines: [
        digTxt(addr, "LineOne"),
        digTxt(addr, "LineTwo"),
        [digTxt(addr, "PostcodeCode"), digTxt(addr, "CityName")].filter(Boolean).join(" "),
        digTxt(addr, "CountryID")
      ].filter(Boolean),
      vat: vat.join(" · ")
    };
  };

  const lines = kids(tx, "IncludedSupplyChainTradeLineItem").map((li) => {
    const prod = kid(li, "SpecifiedTradeProduct");
    const agr = kid(li, "SpecifiedLineTradeAgreement");
    const del = kid(li, "SpecifiedLineTradeDelivery");
    const set = kid(li, "SpecifiedLineTradeSettlement");
    const qtyNode = kid(del, "BilledQuantity");
    return {
      label: digTxt(prod, "Name") || digTxt(li, "AssociatedDocumentLineDocument", "LineID"),
      description: digTxt(prod, "Description"),
      qty: txt(qtyNode),
      unit: qtyNode ? qtyNode.getAttribute("unitCode") || "" : "",
      unitPrice:
        digTxt(agr, "NetPriceProductTradePrice", "ChargeAmount") ||
        digTxt(agr, "GrossPriceProductTradePrice", "ChargeAmount"),
      vatRate: digTxt(set, "ApplicableTradeTax", "RateApplicablePercent"),
      total: digTxt(set, "SpecifiedTradeSettlementLineMonetarySummation", "LineTotalAmount")
    };
  });

  const taxes = kids(settlement, "ApplicableTradeTax").map((t) => ({
    rate: digTxt(t, "RateApplicablePercent"),
    base: digTxt(t, "BasisAmount"),
    amount: digTxt(t, "CalculatedAmount"),
    category: digTxt(t, "CategoryCode"),
    exemption: digTxt(t, "ExemptionReason")
  }));

  const accounts = kids(settlement, "SpecifiedTradeSettlementPaymentMeans").map((m) =>
    digTxt(m, "PayeePartyCreditorFinancialAccount", "IBANID")
  ).filter(Boolean);

  return {
    flavour: "CII (Factur-X / UN-CEFACT)",
    number: digTxt(exch, "ID"),
    typeCode: digTxt(exch, "TypeCode"),
    issueDate: digTxt(exch, "IssueDateTime", "DateTimeString"),
    dueDate: digTxt(settlement, "SpecifiedTradePaymentTerms", "DueDateDateTime", "DateTimeString"),
    currency: digTxt(settlement, "InvoiceCurrencyCode") || "EUR",
    seller: party(dig(agreement, "SellerTradeParty")),
    buyer: party(dig(agreement, "BuyerTradeParty")),
    reference: digTxt(agreement, "BuyerReference"),
    orderRef: digTxt(agreement, "BuyerOrderReferencedDocument", "IssuerAssignedID"),
    paymentTerms: digTxt(settlement, "SpecifiedTradePaymentTerms", "Description"),
    accounts,
    lines,
    taxes,
    totals: {
      ht: digTxt(sums, "LineTotalAmount"),
      base: digTxt(sums, "TaxBasisTotalAmount"),
      vat: digTxt(sums, "TaxTotalAmount"),
      ttc: digTxt(sums, "GrandTotalAmount"),
      due: digTxt(sums, "DuePayableAmount"),
      paid: digTxt(sums, "TotalPrepaidAmount")
    },
    notes: kids(exch, "IncludedNote").map((n) => digTxt(n, "Content")).filter(Boolean)
  };
}

/* ─── UBL 2.1 (Peppol BIS Billing 3.0) ─── */
function parseUBL(root) {
  const party = (wrapper) => {
    const p = kid(wrapper, "Party");
    if (!p) return null;
    const addr = kid(p, "PostalAddress");
    const vat = kids(p, "PartyTaxScheme").map((s) => digTxt(s, "CompanyID")).filter(Boolean);
    return {
      name:
        digTxt(p, "PartyLegalEntity", "RegistrationName") ||
        digTxt(p, "PartyName", "Name"),
      lines: [
        digTxt(addr, "StreetName"),
        digTxt(addr, "AdditionalStreetName"),
        [digTxt(addr, "PostalZone"), digTxt(addr, "CityName")].filter(Boolean).join(" "),
        digTxt(addr, "Country", "IdentificationCode")
      ].filter(Boolean),
      vat: vat.join(" · ")
    };
  };

  const lineNodes = [...kids(root, "InvoiceLine"), ...kids(root, "CreditNoteLine")];
  const lines = lineNodes.map((li) => {
    const item = kid(li, "Item");
    const price = kid(li, "Price");
    const qtyNode = kid(li, "InvoicedQuantity") || kid(li, "CreditedQuantity");
    return {
      label: digTxt(item, "Name"),
      description: digTxt(item, "Description"),
      qty: txt(qtyNode),
      unit: qtyNode ? qtyNode.getAttribute("unitCode") || "" : "",
      unitPrice: digTxt(price, "PriceAmount"),
      vatRate: digTxt(item, "ClassifiedTaxCategory", "Percent"),
      total: digTxt(li, "LineExtensionAmount")
    };
  });

  const taxes = kids(root, "TaxTotal").flatMap((tt) =>
    kids(tt, "TaxSubtotal").map((s) => ({
      rate: digTxt(s, "TaxCategory", "Percent"),
      base: digTxt(s, "TaxableAmount"),
      amount: digTxt(s, "TaxAmount"),
      category: digTxt(s, "TaxCategory", "ID"),
      exemption: digTxt(s, "TaxCategory", "TaxExemptionReason")
    }))
  );

  const totalNode = kid(root, "LegalMonetaryTotal");
  const accounts = kids(root, "PaymentMeans")
    .map((m) => digTxt(m, "PayeeFinancialAccount", "ID"))
    .filter(Boolean);

  return {
    flavour: "UBL 2.1 (Peppol BIS)",
    number: digTxt(root, "ID"),
    typeCode: digTxt(root, "InvoiceTypeCode") || digTxt(root, "CreditNoteTypeCode"),
    issueDate: digTxt(root, "IssueDate"),
    dueDate: digTxt(root, "DueDate"),
    currency: digTxt(root, "DocumentCurrencyCode") || "EUR",
    seller: party(kid(root, "AccountingSupplierParty")),
    buyer: party(kid(root, "AccountingCustomerParty")),
    reference: digTxt(root, "BuyerReference"),
    orderRef: digTxt(root, "OrderReference", "ID"),
    paymentTerms: digTxt(root, "PaymentTerms", "Note"),
    accounts,
    lines,
    taxes,
    totals: {
      ht: digTxt(totalNode, "LineExtensionAmount"),
      base: digTxt(totalNode, "TaxExclusiveAmount"),
      vat: kids(root, "TaxTotal").map((tt) => digTxt(tt, "TaxAmount"))[0] || "",
      ttc: digTxt(totalNode, "TaxInclusiveAmount"),
      due: digTxt(totalNode, "PayableAmount"),
      paid: digTxt(totalNode, "PrepaidAmount")
    },
    notes: kids(root, "Note").map(txt).filter(Boolean)
  };
}

export function parseEInvoiceXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("XML illisible");
  const root = doc.documentElement;
  if (!root) throw new Error("XML vide");
  const name = local(root);
  if (name === "CrossIndustryInvoice") return parseCII(root);
  if (name === "Invoice" || name === "CreditNote") return parseUBL(root);
  throw new Error("Format non reconnu : " + name);
}
