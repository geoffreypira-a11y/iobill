// IO BILL - API publique v1 : Factures
// GET /api/v1/invoices            -> liste
// POST /api/v1/invoices           -> create (mode brouillon par défaut)
// POST /api/v1/invoices?issue=1   -> create + emettre directement

import { authenticateApiKey, logApiRequest } from "../_lib/api-auth.js";
import { sbAdmin, json } from "../_lib/supabase-admin.js";

export default async function handler(req, res) {
  const start = Date.now();
  let authResult = null;

  try {
    const requiredScope = req.method === "GET" ? "read" : "write";
    authResult = await authenticateApiKey(req, requiredScope);
    if (authResult.error) {
      const status = authResult.status || 401;
      if (authResult.retryAfter) res.setHeader("Retry-After", authResult.retryAfter);
      return json(res, status, { error: authResult.error });
    }
    setRateLimitHeaders(res, authResult);

    if (req.method === "GET") {
      const limit = Math.min(Number(req.query?.limit) || 50, 200);
      const filterStatus = req.query?.status;
      let filter = `company_id=eq.${authResult.company.id}`;
      if (filterStatus) filter += `&status=eq.${filterStatus}`;

      const list = await sbAdmin.select("invoices", {
        filter,
        order: "created_at.desc",
        limit
      });
      return json(res, 200, {
        data: (list || []).map(serializeInvoice),
        meta: { count: (list || []).length, limit }
      });
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

      const { client_id, lines, due_date, notes, terms, currency = "EUR", vat_category = "standard" } = body || {};
      if (!client_id) return json(res, 400, { error: "client_id required" });
      if (!Array.isArray(lines) || lines.length === 0) return json(res, 400, { error: "lines (non-empty array) required" });

      // Charger client
      const client = await sbAdmin.selectOne(
        "clients",
        `id=eq.${client_id}&company_id=eq.${authResult.company.id}`
      );
      if (!client) return json(res, 404, { error: "client_id not found in your company" });

      // Calcul totaux
      let subtotalHT = 0, vatTotal = 0;
      const vatBreakdown = {};
      const linesPayload = lines.map((l, idx) => {
        const qty = Number(l.quantity || 1);
        const puHT = Math.round(Number(l.unit_price_ht || 0) * 100); // accepte input en euros
        const vatRate = Number(l.vat_rate ?? 20);
        const discount = Number(l.discount_pct || 0);
        const lineHT = Math.round(qty * puHT * (1 - discount / 100));
        const lineVat = Math.round(lineHT * (vatRate / 100));
        const lineTTC = lineHT + lineVat;

        subtotalHT += lineHT;
        vatTotal += lineVat;
        vatBreakdown[vatRate] = (vatBreakdown[vatRate] || 0) + lineVat;

        return {
          company_id: authResult.company.id,
          document_type: "invoice",
          sort_order: idx,
          description: String(l.description || "").slice(0, 500),
          quantity: qty,
          unit: l.unit || null,
          unit_price_ht_cents: puHT,
          vat_rate: vatRate,
          discount_pct: discount,
          line_ht_cents: lineHT,
          line_vat_cents: lineVat,
          line_ttc_cents: lineTTC
        };
      });

      const totalTTC = subtotalHT + vatTotal;
      const issueDate = body.issue_date || new Date().toISOString().slice(0, 10);
      const computedDueDate = due_date || (() => {
        const d = new Date(issueDate);
        d.setDate(d.getDate() + (client.payment_terms_days || 30));
        return d.toISOString().slice(0, 10);
      })();

      // Allouer le numero
      const number = await sbAdmin.rpc("allocate_document_number", {
        p_company_id: authResult.company.id,
        p_doc_type: "invoice"
      });

      // Determiner le statut : draft par defaut, issued si ?issue=1
      const issueDirectly = req.query?.issue === "1" || body.issue === true;
      const status = issueDirectly ? "issued" : "draft";

      // Snapshots
      const clientSnapshot = {
        legal_name: client.legal_name,
        first_name: client.first_name,
        last_name: client.last_name,
        email: client.email,
        siret: client.siret,
        vat_number: client.vat_number,
        address_line1: client.address_line1,
        postal_code: client.postal_code,
        city: client.city,
        country: client.country
      };
      const companySnapshot = {
        legal_name: authResult.company.legal_name,
        siret: authResult.company.siret,
        vat_number: authResult.company.vat_number,
        address_line1: authResult.company.address_line1,
        postal_code: authResult.company.postal_code,
        city: authResult.company.city
      };

      const created = await sbAdmin.insert("invoices", {
        company_id: authResult.company.id,
        client_id,
        client_snapshot: clientSnapshot,
        company_snapshot: companySnapshot,
        number,
        status,
        issue_date: issueDate,
        due_date: computedDueDate,
        payment_terms_days: client.payment_terms_days || 30,
        subtotal_ht_cents: subtotalHT,
        vat_total_cents: vatTotal,
        total_ttc_cents: totalTTC,
        vat_breakdown: vatBreakdown,
        currency,
        vat_category,
        notes: notes || null,
        terms: terms || null,
        issued_at: issueDirectly ? new Date().toISOString() : null
      });

      if (!created || !created[0]) return json(res, 500, { error: "Invoice creation failed" });
      const inv = created[0];

      // Inserer les lignes
      const linesWithDocId = linesPayload.map((l) => ({ ...l, document_id: inv.id }));
      await sbAdmin.insert("document_lines", linesWithDocId);

      return json(res, 201, { data: serializeInvoice(inv) });
    }

    return json(res, 405, { error: "Method not allowed" });
  } finally {
    const duration = Date.now() - start;
    if (authResult?.key) {
      logApiRequest({
        apiKey: authResult.key,
        company: authResult.company,
        req,
        statusCode: res.statusCode || 200,
        durationMs: duration
      });
    }
  }
}

function setRateLimitHeaders(res, authResult) {
  if (authResult.rateLimitRemaining !== undefined) {
    res.setHeader("X-RateLimit-Remaining", String(authResult.rateLimitRemaining));
    res.setHeader("X-RateLimit-Reset", String(authResult.rateLimitReset));
  }
}

function serializeInvoice(inv) {
  return {
    id: inv.id,
    number: inv.number,
    status: inv.status,
    client_id: inv.client_id,
    issue_date: inv.issue_date,
    due_date: inv.due_date,
    currency: inv.currency,
    subtotal_ht_cents: inv.subtotal_ht_cents,
    vat_total_cents: inv.vat_total_cents,
    total_ttc_cents: inv.total_ttc_cents,
    paid_cents: inv.paid_cents || 0,
    vat_breakdown: inv.vat_breakdown,
    vat_category: inv.vat_category,
    notes: inv.notes,
    terms: inv.terms,
    public_token: inv.public_token,
    pdf_url: inv.pdf_url,
    facturx_xml_url: inv.facturx_xml_url,
    issued_at: inv.issued_at,
    created_at: inv.created_at
  };
}
