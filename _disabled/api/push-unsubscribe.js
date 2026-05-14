// IO BILL - Desabonnement Web Push

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { user } = auth;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const { endpoint } = body || {};
  if (!endpoint) return json(res, 400, { error: "endpoint required" });

  await sbAdmin.delete(
    "push_subscriptions",
    `user_id=eq.${user.id}&endpoint=eq.${encodeURIComponent(endpoint)}`
  );

  return json(res, 200, { ok: true });
}
