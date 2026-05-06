// IO BILL - Bridge by BPCE (PSD2 / DSP2)
// Initie une session de connexion bancaire
// Doc: https://docs.bridgeapi.io/

import { authenticate, json, sbAdmin } from "./_lib/supabase-admin.js";

const BRIDGE_BASE = "https://api.bridgeapi.io/v3";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });

  if (!process.env.BRIDGE_CLIENT_ID || !process.env.BRIDGE_CLIENT_SECRET) {
    return json(res, 503, { error: "Bridge credentials not configured" });
  }

  // 1. Cree (ou retrouve) un Bridge user lie a notre company
  let bridgeUuid = auth.company.bridge_user_uuid;
  if (!bridgeUuid) {
    const userRes = await bridgeCall("/aggregation/users", "POST", {
      external_user_id: auth.company.id
    });
    if (!userRes.ok) return json(res, 500, { error: "Bridge user creation failed", details: userRes.data });
    bridgeUuid = userRes.data.uuid;
    await sbAdmin.update("companies", "id=eq." + auth.company.id, { bridge_user_uuid: bridgeUuid });
  }

  // 2. Genere un token Bridge pour ce user
  const tokenRes = await bridgeCall("/aggregation/authorization/token", "POST", {
    user_uuid: bridgeUuid
  });
  if (!tokenRes.ok) return json(res, 500, { error: "Bridge token failed" });

  // 3. Cree une session de connexion (Bridge Connect)
  const origin = req.headers.origin || "https://iobill.fr";
  const sessionRes = await fetch(BRIDGE_BASE + "/aggregation/connect-sessions", {
    method: "POST",
    headers: {
      "Client-Id": process.env.BRIDGE_CLIENT_ID,
      "Client-Secret": process.env.BRIDGE_CLIENT_SECRET,
      "Bridge-Version": "2025-01-15",
      Authorization: "Bearer " + tokenRes.data.access_token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      user_email: auth.user.email,
      callback_url: origin + "/banking?bridge=callback"
    })
  });
  if (!sessionRes.ok) return json(res, 500, { error: "Connect session failed" });
  const sessionData = await sessionRes.json();

  return json(res, 200, { connect_url: sessionData.url });
}

async function bridgeCall(path, method, body) {
  const r = await fetch(BRIDGE_BASE + path, {
    method,
    headers: {
      "Client-Id": process.env.BRIDGE_CLIENT_ID,
      "Client-Secret": process.env.BRIDGE_CLIENT_SECRET,
      "Bridge-Version": "2025-01-15",
      "Content-Type": "application/json"
    },
    body: method !== "GET" ? JSON.stringify(body || {}) : undefined
  });
  return { ok: r.ok, data: await r.json().catch(() => null) };
}
