// IO BILL - Confirmer ou rejeter une suggestion de matching bancaire
// Si accepted -> creer un payment (si invoice) et marquer la transaction matched.

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { user, company } = auth;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const { suggestion_id, action } = body || {}; // action: "accept" | "reject"
  if (!suggestion_id || !["accept", "reject"].includes(action)) {
    return json(res, 400, { error: "Invalid suggestion_id or action" });
  }

  const sugg = await sbAdmin.selectOne(
    "bank_match_suggestions",
    `id=eq.${suggestion_id}&company_id=eq.${company.id}`
  );
  if (!sugg) return json(res, 404, { error: "Suggestion not found" });
  if (sugg.status !== "pending") return json(res, 400, { error: "Already reviewed" });

  if (action === "reject") {
    await sbAdmin.update("bank_match_suggestions", `id=eq.${suggestion_id}`, {
      status: "rejected",
      reviewed_at: new Date().toISOString(),
      reviewed_by: user.id
    });
    return json(res, 200, { ok: true });
  }

  // accept
  const tx = await sbAdmin.selectOne("bank_transactions", `id=eq.${sugg.bank_transaction_id}`);
  if (!tx) return json(res, 404, { error: "Bank transaction not found" });

  if (sugg.match_type === "invoice") {
    const inv = await sbAdmin.selectOne("invoices", `id=eq.${sugg.match_id}`);
    if (!inv) return json(res, 404, { error: "Invoice not found" });

    // Creer un payment
    const amount = Math.abs(tx.amount_cents);
    await sbAdmin.insert("payments", {
      company_id: company.id,
      invoice_id: inv.id,
      amount_cents: amount,
      method: "bank_transfer",
      paid_at: tx.transaction_date,
      bank_transaction_id: tx.id,
      match_method: "ai_assisted",
      match_confidence: sugg.confidence_score
    });

    // Mettre a jour le statut facture
    const newPaid = (inv.paid_cents || 0) + amount;
    await sbAdmin.update("invoices", `id=eq.${inv.id}`, {
      paid_cents: newPaid,
      status: newPaid >= inv.total_ttc_cents ? "paid" : "partial"
    });
  }

  // Marquer la transaction matched
  const updateTx = sugg.match_type === "invoice"
    ? { matched_invoice_id: sugg.match_id, matched_at: new Date().toISOString(), matched_by: user.id }
    : { matched_purchase_id: sugg.match_id, matched_at: new Date().toISOString(), matched_by: user.id };

  await sbAdmin.update("bank_transactions", `id=eq.${tx.id}`, updateTx);

  // Marquer la suggestion accepted
  await sbAdmin.update("bank_match_suggestions", `id=eq.${suggestion_id}`, {
    status: "accepted",
    reviewed_at: new Date().toISOString(),
    reviewed_by: user.id
  });

  return json(res, 200, { ok: true, type: sugg.match_type, id: sugg.match_id });
}
