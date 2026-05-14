// IO BILL - Enregistrer un abonnement Web Push pour le user

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { user, company } = auth;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const { endpoint, p256dh, auth: authKey, user_agent } = body || {};
  if (!endpoint || !p256dh || !authKey) {
    return json(res, 400, { error: "Missing endpoint/p256dh/auth" });
  }

  // Upsert : si meme endpoint pour le meme user, on remplace
  const existing = await sbAdmin.selectOne(
    "push_subscriptions",
    `user_id=eq.${user.id}&endpoint=eq.${encodeURIComponent(endpoint)}`
  );

  if (existing) {
    await sbAdmin.update("push_subscriptions", `id=eq.${existing.id}`, {
      p256dh_key: p256dh,
      auth_key: authKey,
      user_agent: user_agent || null,
      company_id: company?.id || null,
      last_used_at: new Date().toISOString()
    });
    return json(res, 200, { ok: true, subscription_id: existing.id, updated: true });
  }

  const created = await sbAdmin.insert("push_subscriptions", {
    user_id: user.id,
    company_id: company?.id || null,
    endpoint,
    p256dh_key: p256dh,
    auth_key: authKey,
    user_agent: user_agent || null
  });

  if (!created || !created[0]) return json(res, 500, { error: "Insert failed" });

  return json(res, 200, { ok: true, subscription_id: created[0].id });
}
