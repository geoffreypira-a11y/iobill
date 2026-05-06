// IO BILL - Checkout Stripe pour le plan Cabinet (19,90€/mois ou 199€/an)
// Cree une session Stripe Checkout liee a un firm_id (passe en metadata).
// Le webhook stripe-webhook met a jour firms.stripe_sub_id apres paiement.

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";

const STRIPE_API = "https://api.stripe.com/v1";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { user } = auth;

  if (!process.env.STRIPE_SECRET_KEY) return json(res, 503, { error: "Stripe not configured" });

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const { firm_id, period = "monthly" } = body || {};
  if (!firm_id) return json(res, 400, { error: "firm_id required" });

  // Verifier que le user est partner du firm
  const fu = await sbAdmin.selectOne(
    "firm_users",
    `firm_id=eq.${firm_id}&user_id=eq.${user.id}&role=eq.partner`
  );
  if (!fu) return json(res, 403, { error: "Only partners can subscribe to firm plan" });

  const firm = await sbAdmin.selectOne("firms", `id=eq.${firm_id}`);
  if (!firm) return json(res, 404, { error: "Firm not found" });

  if (firm.stripe_sub_status === "active") {
    return json(res, 400, { error: "Firm already has an active subscription" });
  }

  // Choix du price
  const priceId = period === "yearly"
    ? process.env.STRIPE_PRICE_ID_FIRM_YEARLY
    : process.env.STRIPE_PRICE_ID_FIRM_MONTHLY;

  if (!priceId) return json(res, 503, { error: `Stripe price ${period} not configured (STRIPE_PRICE_ID_FIRM_${period.toUpperCase()})` });

  // URL de retour
  const baseUrl = process.env.PUBLIC_BASE_URL ||
    (req.headers["x-forwarded-host"] ? `https://${req.headers["x-forwarded-host"]}` : "");
  const successUrl = `${baseUrl}/firm?checkout=success`;
  const cancelUrl = `${baseUrl}/firm?checkout=canceled`;

  // Creer ou recuperer le customer Stripe
  let customerId = firm.stripe_customer_id;
  if (!customerId) {
    const cust = await stripeForm("/customers", {
      email: firm.email || user.email,
      name: firm.legal_name,
      "metadata[firm_id]": firm_id,
      "metadata[type]": "firm"
    });
    if (!cust.id) return json(res, 502, { error: "Stripe customer creation failed", detail: cust });
    customerId = cust.id;
    await sbAdmin.update("firms", `id=eq.${firm_id}`, { stripe_customer_id: customerId });
  }

  // Creer la session checkout
  const session = await stripeForm("/checkout/sessions", {
    "customer": customerId,
    "mode": "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    "success_url": successUrl,
    "cancel_url": cancelUrl,
    "metadata[firm_id]": firm_id,
    "metadata[type]": "firm",
    "subscription_data[metadata][firm_id]": firm_id,
    "subscription_data[metadata][type]": "firm",
    "allow_promotion_codes": "true",
    "billing_address_collection": "required",
    "tax_id_collection[enabled]": "true"
  });

  if (!session.id) return json(res, 502, { error: "Stripe session creation failed", detail: session });

  return json(res, 200, { ok: true, checkout_url: session.url, session_id: session.id });
}

async function stripeForm(path, params) {
  const body = new URLSearchParams(params).toString();
  const r = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  return await r.json();
}
