// IO BILL - Webhook Bridge (sync bancaire automatique)
// Doc : https://docs.bridgeapi.io/docs/webhooks
//
// Configuration cote Bridge :
//   Settings -> Webhooks -> URL = https://<domaine>/api/bridge-webhook
//   Events : account.synced, item.refreshed, item.refresh.completed,
//            item.account.created, item.account.updated, account.refreshed
//
// Securite : Bridge signe le webhook avec un secret partage (HMAC-SHA256).
// Header attendu : "BridgeApi-Signature: v1=<hex_hmac>"

import { sbAdmin, json } from "./_lib/supabase-admin.js";
import { createHmac } from "crypto";

const BRIDGE_API = "https://api.bridgeapi.io/v3";

export const config = {
  api: { bodyParser: false } // raw body necessaire pour la verif HMAC
};

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  // 1) Lire le raw body
  let raw;
  try {
    raw = await readRaw(req);
  } catch {
    return json(res, 400, { error: "Cannot read body" });
  }

  // 2) Verifier la signature
  const signature = req.headers["bridgeapi-signature"];
  const secret = process.env.BRIDGE_WEBHOOK_SECRET;
  if (secret) {
    if (!verifyBridgeSignature(raw, signature, secret)) {
      return json(res, 401, { error: "Invalid signature" });
    }
  }
  // Si pas de secret configure, on accepte sans verif (dev/sandbox)

  let body;
  try { body = JSON.parse(raw); } catch { return json(res, 400, { error: "Invalid JSON" }); }

  const eventType = body.type;
  const content = body.content || {};

  // 3) Stocker l'evenement brut
  const trace = await sbAdmin.insert("bridge_webhook_events", {
    event_type: eventType,
    bridge_user_uuid: content.user_uuid || null,
    bridge_account_id: content.account_id || null,
    bridge_item_id: content.item_id || null,
    payload: body,
    status: "received"
  });
  const eventId = trace?.[0]?.id;

  // 4) Trouver la company associee via bank_connections.bridge_user_uuid
  let company = null;
  if (content.user_uuid) {
    const conn = await sbAdmin.selectOne(
      "bank_connections",
      `bridge_user_uuid=eq.${content.user_uuid}`
    );
    if (conn) {
      company = await sbAdmin.selectOne("companies", `id=eq.${conn.company_id}`);
      // Update timestamp dernier webhook
      await sbAdmin.update("bank_connections", `id=eq.${conn.id}`, {
        last_webhook_at: new Date().toISOString()
      });
    }
  }

  if (!company) {
    if (eventId) {
      await sbAdmin.update("bridge_webhook_events", `id=eq.${eventId}`, {
        status: "ignored",
        error_message: "No company found for bridge_user_uuid"
      });
    }
    return json(res, 200, { ok: true, ignored: true });
  }

  if (eventId) {
    await sbAdmin.update("bridge_webhook_events", `id=eq.${eventId}`, { company_id: company.id });
  }

  // 5) Dispatch selon event_type
  let importedCount = 0;
  try {
    if (["account.synced", "item.refreshed", "item.refresh.completed", "account.refreshed"].includes(eventType)) {
      // Recuperer les transactions recentes depuis Bridge
      importedCount = await syncRecentTransactions(company, content);
    }
    // Les autres types (item.account.created, etc.) : on stocke juste l'event

    if (eventId) {
      await sbAdmin.update("bridge_webhook_events", `id=eq.${eventId}`, {
        status: "processed",
        imported_count: importedCount,
        processed_at: new Date().toISOString()
      });
    }
  } catch (e) {
    if (eventId) {
      await sbAdmin.update("bridge_webhook_events", `id=eq.${eventId}`, {
        status: "failed",
        error_message: e.message?.slice(0, 500)
      });
    }
    return json(res, 500, { error: e.message });
  }

  return json(res, 200, { ok: true, imported: importedCount });
}

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
function readRaw(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function verifyBridgeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader) return false;
  // Format: "v1=<hex>"
  const parts = String(signatureHeader).split(",").map((p) => p.trim());
  const v1 = parts.find((p) => p.startsWith("v1="));
  if (!v1) return false;
  const provided = v1.slice(3);
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  // Constant-time comparison
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

// Recupere les transactions recentes depuis Bridge et les insere
async function syncRecentTransactions(company, content) {
  if (!process.env.BRIDGE_CLIENT_ID || !process.env.BRIDGE_CLIENT_SECRET) return 0;

  // Si on a un access_token stocke pour cet utilisateur Bridge -> l'utiliser
  // Sinon, on n'a rien a faire ici (la sync devra passer par /api/bridge-sync classique)
  const conn = await sbAdmin.selectOne("bank_connections",
    `company_id=eq.${company.id}&bridge_user_uuid=eq.${content.user_uuid}`);
  if (!conn || !conn.bridge_access_token) return 0;

  // Recupere les 100 dernieres transactions (apres last_sync_at)
  const since = conn.last_sync_at
    ? new Date(conn.last_sync_at).toISOString().slice(0, 10)
    : new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);

  const r = await fetch(`${BRIDGE_API}/aggregation/transactions?since=${since}&limit=200`, {
    headers: {
      "Bridge-Version": "2025-01-15",
      "Client-Id": process.env.BRIDGE_CLIENT_ID,
      "Client-Secret": process.env.BRIDGE_CLIENT_SECRET,
      Authorization: `Bearer ${conn.bridge_access_token}`
    }
  });
  if (!r.ok) return 0;
  const data = await r.json();
  const txs = data.resources || [];

  let imported = 0;
  for (const tx of txs) {
    // Verifier si la transaction existe deja
    const existing = await sbAdmin.selectOne(
      "bank_transactions",
      `company_id=eq.${company.id}&provider_ref=eq.${tx.id}`
    );
    if (existing) continue;

    await sbAdmin.insert("bank_transactions", {
      company_id: company.id,
      bank_connection_id: conn.id,
      provider: "bridge",
      provider_ref: String(tx.id),
      transaction_date: tx.date,
      label: tx.clean_description || tx.description || "Transaction",
      amount_cents: Math.round(Number(tx.amount) * 100),
      currency: tx.currency_code || "EUR",
      category: tx.category_id ? String(tx.category_id) : null,
      raw_data: tx
    });
    imported++;
  }

  // Update last_sync_at
  await sbAdmin.update("bank_connections", `id=eq.${conn.id}`, {
    last_sync_at: new Date().toISOString()
  });

  return imported;
}
