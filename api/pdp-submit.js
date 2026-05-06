// IO BILL - Soumission d'une facture a une PDP (Plateforme de Dematerialisation Partenaire)
// Conformite e-invoicing 2026/2027 (article 289 bis du CGI).
//
// Architecture cible :
// - L'utilisateur configure son PDP dans Settings (provider + apiKey)
// - A l'emission d'une facture : appel a /api/pdp-submit
// - Cette route serialise la facture en XML CII (Factur-X reutilise) et l'envoie au PDP
// - La PDP route automatiquement vers le destinataire (PPF ou autre PDP)
// - Webhooks plus tard pour suivre les statuts (received, read, paid, refused)
//
// Providers supportes (extensible) :
//  - iopole     : https://www.iopole.fr/  (FR, certifiee)
//  - generix    : https://www.generix.com/
//  - cegid      : https://www.cegid.com/
//  - sage       : https://www.sage.com/
//  - ppf_test   : Portail Public de Facturation en mode test (DGFiP)

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { company } = auth;

  if (!company.pdp_enabled) {
    return json(res, 403, { error: "PDP module not enabled. Configure your PDP in Settings." });
  }
  if (!company.pdp_provider) {
    return json(res, 400, { error: "No PDP provider configured" });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const { invoice_id } = body || {};
  if (!invoice_id) return json(res, 400, { error: "invoice_id required" });

  // Charger la facture
  const inv = await sbAdmin.selectOne("invoices", `id=eq.${invoice_id}&company_id=eq.${company.id}`);
  if (!inv) return json(res, 404, { error: "Invoice not found" });
  if (!["issued", "sent", "partial", "paid", "overdue"].includes(inv.status)) {
    return json(res, 400, { error: "Invoice must be issued before PDP submission" });
  }
  if (!inv.facturx_xml_url) {
    return json(res, 400, { error: "Factur-X XML must be generated first (call /api/generate-facturx)" });
  }

  // Telecharger le XML stocke dans Supabase
  const xmlRes = await fetch(inv.facturx_xml_url);
  if (!xmlRes.ok) return json(res, 500, { error: "Cannot fetch XML from storage" });
  const xml = await xmlRes.text();

  // Insert log
  const trx = await sbAdmin.insert("pdp_transmissions", {
    company_id: company.id,
    document_type: "invoice",
    document_id: invoice_id,
    provider: company.pdp_provider,
    status: "queued",
    payload_xml: xml.length > 500000 ? null : xml,  // pas la peine de stocker un XML enorme
    submitted_at: new Date().toISOString()
  });
  const trxId = trx?.[0]?.id;

  // Dispatch selon le provider
  let result;
  try {
    switch (company.pdp_provider) {
      case "iopole":
        result = await submitToIopole(xml, inv, company);
        break;
      case "generix":
        result = await submitToGenerix(xml, inv, company);
        break;
      case "cegid":
        result = await submitToCegid(xml, inv, company);
        break;
      case "ppf_test":
        result = await submitToPPFTest(xml, inv, company);
        break;
      default:
        return json(res, 400, { error: `Unknown PDP provider: ${company.pdp_provider}` });
    }
  } catch (e) {
    if (trxId) await sbAdmin.update("pdp_transmissions", `id=eq.${trxId}`, {
      status: "error", error_message: e.message
    });
    return json(res, 500, { error: "PDP submission failed", detail: e.message });
  }

  // Mettre a jour la transmission
  if (trxId) {
    await sbAdmin.update("pdp_transmissions", `id=eq.${trxId}`, {
      status: result.success ? "submitted" : "error",
      pdp_reference: result.reference || null,
      ppf_reference: result.ppf_reference || null,
      response_data: result.data || null,
      error_message: result.error || null,
      accepted_at: result.success ? new Date().toISOString() : null
    });
  }

  if (!result.success) {
    return json(res, 502, { error: result.error || "PDP rejected", detail: result.data });
  }

  return json(res, 200, {
    ok: true,
    transmission_id: trxId,
    provider: company.pdp_provider,
    reference: result.reference,
    ppf_reference: result.ppf_reference
  });
}

// ──────────────────────────────────────────────────────────────
// PROVIDERS — Implementations stub (a completer avec specs reelles)
// ──────────────────────────────────────────────────────────────

// Iopole : leader FR, certifie PDP, doc obtenue avec contrat partenaire
async function submitToIopole(xml, inv, company) {
  const apiKey = company.pdp_api_key_encrypted; // En V1, pas vraiment chiffre — TODO V1.2
  const accountId = company.pdp_account_id;
  if (!apiKey || !accountId) return { success: false, error: "Missing Iopole credentials" };

  const r = await fetch("https://api.iopole.fr/v1/invoices/submit", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/xml",
      "X-Account-Id": accountId,
      "X-Document-Format": "factur-x-cii"
    },
    body: xml
  });

  if (!r.ok) {
    const txt = await r.text();
    return { success: false, error: `Iopole HTTP ${r.status}`, data: txt.slice(0, 500) };
  }

  const data = await r.json().catch(() => null);
  return {
    success: true,
    reference: data?.reference || data?.id || null,
    ppf_reference: data?.ppfReference || null,
    data
  };
}

async function submitToGenerix(xml, inv, company) {
  // Generix utilise generalement SOAP — necessite un wrapper.
  // TODO : implementation via leur sandbox
  return { success: false, error: "Generix integration not yet implemented (V1.2)" };
}

async function submitToCegid(xml, inv, company) {
  // TODO : Cegid Compta API
  return { success: false, error: "Cegid integration not yet implemented (V1.2)" };
}

// Mode test PPF (Portail Public de Facturation - DGFiP)
// La PPF gere uniquement le mode "directionnel" (consultation des factures recues)
// Pour la transmission, il faut passer par une PDP certifiee.
// Ce mode est un STUB pour les tests/dev.
async function submitToPPFTest(xml, inv, company) {
  // Simulation : on accepte tout en sandbox
  await new Promise((r) => setTimeout(r, 500));
  return {
    success: true,
    reference: "PPF-TEST-" + Date.now(),
    ppf_reference: "PPF-TEST-" + inv.number,
    data: { mode: "test", info: "PPF test mode — no real submission" }
  };
}
