// IO BILL - Gestion des cles API (cote frontend admin)
// GET  /api/api-keys                -> liste
// POST /api/api-keys                -> create (renvoie la cle EN CLAIR une seule fois)
// DELETE /api/api-keys?id=xxx       -> revoke

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";
import { generateApiKey } from "./_lib/api-auth.js";

export default async function handler(req, res) {
  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { user, company } = auth;

  if (req.method === "GET") {
    const list = await sbAdmin.select("api_keys", {
      filter: `company_id=eq.${company.id}`,
      select: "id,key_prefix,name,scopes,created_at,last_used_at,last_used_ip,revoked_at,rate_limit_per_minute",
      order: "created_at.desc"
    });
    return json(res, 200, { keys: list || [] });
  }

  if (req.method === "POST") {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

    const { name, scopes = ["read"], rate_limit = 60 } = body || {};
    if (!name?.trim()) return json(res, 400, { error: "name required" });

    // Verifier scopes
    const validScopes = ["read", "write", "admin"];
    const cleanScopes = (Array.isArray(scopes) ? scopes : [scopes])
      .filter((s) => validScopes.includes(s));
    if (cleanScopes.length === 0) return json(res, 400, { error: "At least one valid scope required" });

    const { fullKey, hash, displayPrefix } = generateApiKey();

    const created = await sbAdmin.insert("api_keys", {
      company_id: company.id,
      key_hash: hash,
      key_prefix: displayPrefix,
      name: name.trim().slice(0, 80),
      scopes: cleanScopes,
      created_by: user.id,
      rate_limit_per_minute: Math.min(Number(rate_limit) || 60, 1000)
    });

    if (!created || !created[0]) return json(res, 500, { error: "Insert failed" });

    // Renvoyer la cle EN CLAIR une seule fois (l'utilisateur doit la copier maintenant)
    return json(res, 201, {
      key: fullKey,
      id: created[0].id,
      name: created[0].name,
      scopes: created[0].scopes,
      warning: "Cette clé n'est affichée qu'une seule fois. Stockez-la maintenant en lieu sûr."
    });
  }

  if (req.method === "DELETE") {
    const id = req.query?.id || req.url?.match(/[?&]id=([^&]+)/)?.[1];
    if (!id) return json(res, 400, { error: "id required" });

    const updated = await sbAdmin.update(
      "api_keys",
      `id=eq.${id}&company_id=eq.${company.id}`,
      { revoked_at: new Date().toISOString() }
    );
    if (!updated || updated.length === 0) return json(res, 404, { error: "Key not found" });
    return json(res, 200, { ok: true });
  }

  return json(res, 405, { error: "Method not allowed" });
}
