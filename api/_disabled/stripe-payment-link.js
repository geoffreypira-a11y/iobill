// IO BILL - Genere un Stripe Payment Link pour une facture client
import { authenticate, json, sbAdmin } from "./_lib/supabase-admin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const invoiceId = body?.invoice_id;
  if (!invoiceId) return json(res, 400, { error: "invoice_id required" });

  const inv = await sbAdmin.selectOne("invoices", "id=eq." + invoiceId);
  if (!inv) return json(res, 404, { error: "Invoice not found" });
  if (inv.company_id !== auth.company.id) return json(res, 403, { error: "Forbidden" });

  const remaining = (inv.total_ttc_cents || 0) - (inv.paid_cents || 0);
  if (remaining <= 0) return json(res, 400, { error: "Invoice already paid" });

  // 1. Crée un produit ad hoc pour ce paiement
  const productRes = await stripeCall("/v1/products", "POST", {
    name: "Facture " + inv.number + " - " + (inv.client_snapshot?.legal_name || ""),
    metadata: { invoice_id: invoiceId }
  });
  if (!productRes.ok) return json(res, 500, { error: "Product creation failed" });

  // 2. Crée un prix
  const priceRes = await stripeCall("/v1/prices", "POST", {
    unit_amount: remaining,
    currency: (inv.currency || "EUR").toLowerCase(),
    product: productRes.data.id
  });
  if (!priceRes.ok) return json(res, 500, { error: "Price creation failed" });

  // 3. Crée le payment link
  const linkRes = await stripeCall("/v1/payment_links", "POST", {
    "line_items[0][price]": priceRes.data.id,
    "line_items[0][quantity]": "1",
    "metadata[invoice_id]": invoiceId,
    "metadata[company_id]": auth.company.id
  });
  if (!linkRes.ok) return json(res, 500, { error: "Payment link creation failed" });

  await sbAdmin.update("invoices", "id=eq." + invoiceId, {
    stripe_payment_link_url: linkRes.data.url
  });

  return json(res, 200, { url: linkRes.data.url, id: linkRes.data.id });
}

async function stripeCall(path, method, body) {
  const flat = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === "object" && v !== null) {
      for (const [k2, v2] of Object.entries(v)) flat[k + "[" + k2 + "]"] = v2;
    } else {
      flat[k] = v;
    }
  }
  const r = await fetch("https://api.stripe.com" + path, {
    method,
    headers: {
      Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams(flat).toString()
  });
  return { ok: r.ok, data: await r.json() };
}
