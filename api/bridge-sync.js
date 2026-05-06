// IO BILL - Bridge sync + lettrage automatique
import { authenticate, json, sbAdmin } from "./_lib/supabase-admin.js";

const BRIDGE_BASE = "https://api.bridgeapi.io/v3";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });

  if (!process.env.BRIDGE_CLIENT_ID) {
    return json(res, 503, { error: "Bridge not configured" });
  }

  if (!auth.company.bridge_user_uuid) {
    return json(res, 400, { error: "No Bridge user. Connect a bank first." });
  }

  // 1. Token utilisateur
  const tokenRes = await fetch(BRIDGE_BASE + "/aggregation/authorization/token", {
    method: "POST",
    headers: bridgeHeaders(),
    body: JSON.stringify({ user_uuid: auth.company.bridge_user_uuid })
  });
  if (!tokenRes.ok) return json(res, 500, { error: "Bridge token failed" });
  const { access_token } = await tokenRes.json();

  // 2. Liste les comptes
  const accRes = await fetch(BRIDGE_BASE + "/aggregation/accounts", {
    headers: { ...bridgeHeaders(), Authorization: "Bearer " + access_token }
  });
  if (!accRes.ok) return json(res, 500, { error: "Accounts fetch failed" });
  const { resources: accounts = [] } = await accRes.json();

  // 3. Pour chaque compte, on enregistre la connexion + on tire les transactions
  let imported = 0;
  for (const acc of accounts) {
    // Upsert connection
    await sbAdmin.insert("bank_connections", {
      company_id: auth.company.id,
      provider: "bridge",
      external_id: String(acc.id),
      bank_name: acc.bank_name || acc.name,
      iban_last4: acc.iban?.slice(-4) || null,
      status: "active",
      last_sync_at: new Date().toISOString()
    }).catch(() => {});

    // Transactions des 90 derniers jours
    const txRes = await fetch(
      BRIDGE_BASE + "/aggregation/transactions?account_id=" + acc.id + "&limit=200",
      { headers: { ...bridgeHeaders(), Authorization: "Bearer " + access_token } }
    );
    if (!txRes.ok) continue;
    const { resources: txs = [] } = await txRes.json();

    for (const tx of txs) {
      const externalId = "bridge_" + tx.id;
      const exists = await sbAdmin.selectOne(
        "bank_transactions",
        "company_id=eq." + auth.company.id + "&external_id=eq." + externalId
      );
      if (exists) continue;

      const amountCents = Math.round((tx.amount || 0) * 100);
      // Auto-match : recherche d'une facture avec montant exact
      let matchedInvoiceId = null;
      let matchConfidence = null;
      let matchStatus = "unmatched";

      if (amountCents > 0) {
        const candidates = await sbAdmin.select("invoices", {
          filter:
            "company_id=eq." + auth.company.id +
            "&status=in.(issued,sent,partial,overdue)" +
            "&total_ttc_cents=eq." + amountCents,
          limit: 5
        });
        if (candidates && candidates.length === 1) {
          matchedInvoiceId = candidates[0].id;
          matchConfidence = 1.0;
          matchStatus = "suggested";
        } else if (candidates && candidates.length > 1) {
          matchStatus = "suggested";
        }
      }

      await sbAdmin.insert("bank_transactions", {
        company_id: auth.company.id,
        external_id: externalId,
        amount_cents: amountCents,
        currency: tx.currency_code || "EUR",
        description: tx.clean_description || tx.description,
        counterparty: tx.counterparty_name,
        transaction_date: tx.date,
        match_status: matchStatus,
        matched_invoice_id: matchedInvoiceId,
        match_confidence: matchConfidence
      });
      imported++;
    }
  }

  return json(res, 200, { imported, accounts: accounts.length });
}

function bridgeHeaders() {
  return {
    "Client-Id": process.env.BRIDGE_CLIENT_ID,
    "Client-Secret": process.env.BRIDGE_CLIENT_SECRET,
    "Bridge-Version": "2025-01-15",
    "Content-Type": "application/json"
  };
}
