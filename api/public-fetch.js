// IO BILL - Consultation publique d'un document via token (devis, facture, portail).
// Pas d'authentification requise — verification du token uniquement.

import { sbAdmin, json } from "./_lib/supabase-admin.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  // Token via query string OU body
  const token =
    (req.query && req.query.token) ||
    (req.body && (typeof req.body === "string" ? safeParse(req.body)?.token : req.body.token));

  if (!token) return json(res, 400, { error: "Token required" });

  // Consommer le token (incremente use_count, verifie expiration/revocation)
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || null;
  const consumed = await sbAdmin.rpc("consume_public_token", { p_token: token, p_ip: ip });
  if (!consumed || !consumed[0]) {
    return json(res, 404, { error: "Token invalid, expired or revoked" });
  }
  const { company_id, scope, resource_id } = consumed[0];

  // Charger les infos de la societe (pour branding)
  const company = await sbAdmin.selectOne(
    "companies",
    `id=eq.${company_id}`,
    "id,legal_name,trade_name,email,phone,siret,vat_number,address_line1,address_line2,postal_code,city,country,logo_url,brand_color,modules"
  );

  if (scope === "quote") {
    const [quote, lines] = await Promise.all([
      sbAdmin.selectOne("quotes", `id=eq.${resource_id}`),
      sbAdmin.select("document_lines", {
        filter: `document_type=eq.quote&document_id=eq.${resource_id}`,
        order: "sort_order.asc"
      })
    ]);
    if (!quote) return json(res, 404, { error: "Quote not found" });
    return json(res, 200, { scope: "quote", company, document: quote, lines: lines || [] });
  }

  if (scope === "invoice") {
    const [invoice, lines] = await Promise.all([
      sbAdmin.selectOne("invoices", `id=eq.${resource_id}`),
      sbAdmin.select("document_lines", {
        filter: `document_type=eq.invoice&document_id=eq.${resource_id}`,
        order: "sort_order.asc"
      })
    ]);
    if (!invoice) return json(res, 404, { error: "Invoice not found" });
    return json(res, 200, { scope: "invoice", company, document: invoice, lines: lines || [] });
  }

  if (scope === "portal") {
    // Charger le client + ses factures
    const [client, invoices, quotes] = await Promise.all([
      sbAdmin.selectOne(
        "clients",
        `id=eq.${resource_id}`,
        "id,client_type,legal_name,first_name,last_name,email,contact_person"
      ),
      sbAdmin.select("invoices", {
        filter: `client_id=eq.${resource_id}&status=in.(issued,sent,partial,paid,overdue)`,
        order: "issue_date.desc",
        select: "id,number,issue_date,due_date,total_ttc_cents,paid_cents,status,pdf_url,facturx_pdf_url,stripe_payment_link_url"
      }),
      sbAdmin.select("quotes", {
        filter: `client_id=eq.${resource_id}&status=in.(sent,signed,refused,converted)`,
        order: "issue_date.desc",
        select: "id,number,issue_date,expires_at,total_ttc_cents,status,pdf_url"
      })
    ]);
    if (!client) return json(res, 404, { error: "Client not found" });
    return json(res, 200, {
      scope: "portal",
      company,
      client,
      invoices: invoices || [],
      quotes: quotes || []
    });
  }

  return json(res, 400, { error: "Unknown scope" });
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
