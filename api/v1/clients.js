// IO BILL - API publique v1 : Clients
// GET /api/v1/clients         -> liste
// POST /api/v1/clients        -> create

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
      const offset = Number(req.query?.offset) || 0;

      const list = await sbAdmin.select("clients", {
        filter: `company_id=eq.${authResult.company.id}`,
        order: "created_at.desc",
        limit
      });
      return json(res, 200, {
        data: (list || []).slice(offset, offset + limit).map(serializeClient),
        meta: { count: (list || []).length, limit, offset }
      });
    }

    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

      // Validation minimale
      const { type = "company", legal_name, email } = body || {};
      if (!legal_name && type === "company") return json(res, 400, { error: "legal_name required for type=company" });
      if (!body.last_name && type === "individual") return json(res, 400, { error: "last_name required for type=individual" });

      const payload = {
        company_id: authResult.company.id,
        type,
        statut: body.statut || "active",
        legal_name: legal_name || null,
        first_name: body.first_name || null,
        last_name: body.last_name || null,
        email: email || null,
        phone: body.phone || null,
        siret: body.siret || null,
        vat_number: body.vat_number || null,
        address_line1: body.address_line1 || null,
        postal_code: body.postal_code || null,
        city: body.city || null,
        country: body.country || "FR",
        payment_terms_days: body.payment_terms_days || 30
      };

      const created = await sbAdmin.insert("clients", payload);
      if (!created || !created[0]) return json(res, 500, { error: "Insert failed" });
      return json(res, 201, { data: serializeClient(created[0]) });
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

// Serialize : on n'expose pas tous les champs DB (notamment company_id)
function serializeClient(c) {
  return {
    id: c.id,
    type: c.type,
    statut: c.statut,
    legal_name: c.legal_name,
    first_name: c.first_name,
    last_name: c.last_name,
    email: c.email,
    phone: c.phone,
    siret: c.siret,
    vat_number: c.vat_number,
    address_line1: c.address_line1,
    postal_code: c.postal_code,
    city: c.city,
    country: c.country,
    payment_terms_days: c.payment_terms_days,
    created_at: c.created_at
  };
}
