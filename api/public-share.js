// IO BILL - Genere un token public pour partager un devis, une facture ou
// un portail client sans authentification.

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { company, user } = auth;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const { scope, resource_id, recipient_email, expires_in_days = 90 } = body || {};
  if (!["quote", "invoice", "portal"].includes(scope)) {
    return json(res, 400, { error: "Invalid scope" });
  }
  if (!resource_id) return json(res, 400, { error: "resource_id required" });

  // Verifier que la resource appartient bien a la company
  if (scope === "quote") {
    const q = await sbAdmin.selectOne("quotes", `id=eq.${resource_id}&company_id=eq.${company.id}`);
    if (!q) return json(res, 404, { error: "Quote not found" });
  } else if (scope === "invoice") {
    const i = await sbAdmin.selectOne("invoices", `id=eq.${resource_id}&company_id=eq.${company.id}`);
    if (!i) return json(res, 404, { error: "Invoice not found" });
  } else if (scope === "portal") {
    const c = await sbAdmin.selectOne("clients", `id=eq.${resource_id}&company_id=eq.${company.id}`);
    if (!c) return json(res, 404, { error: "Client not found" });
  }

  // Generer token URL-safe
  const token = generateToken(32);
  const expiresAt = expires_in_days
    ? new Date(Date.now() + expires_in_days * 86400000).toISOString()
    : null;

  const created = await sbAdmin.insert("public_tokens", {
    token,
    company_id: company.id,
    scope,
    resource_id,
    recipient_email: recipient_email || null,
    expires_at: expiresAt,
    created_by: user.id
  });

  if (!created || !created[0]) {
    return json(res, 500, { error: "Token creation failed" });
  }

  // URL publique a partager
  const baseUrl = req.headers["x-forwarded-host"]
    ? `https://${req.headers["x-forwarded-host"]}`
    : (process.env.PUBLIC_BASE_URL || "");
  const path = scope === "portal" ? `/p/portal/${token}` : `/p/${scope}/${token}`;

  return json(res, 200, {
    ok: true,
    token,
    public_url: baseUrl + path,
    expires_at: expiresAt
  });
}

function generateToken(length) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  const arr = new Uint8Array(length);
  globalThis.crypto?.getRandomValues?.(arr);
  for (let i = 0; i < length; i++) {
    out += chars[arr[i] % chars.length];
  }
  return out;
}
