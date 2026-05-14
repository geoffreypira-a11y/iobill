// IO BILL - Stripe Checkout (abonnement Pro)
// 9,90 EUR HT/mois ou 89 EUR/an

import { authenticate, json, sbAdmin } from "./_lib/supabase-admin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });

  if (!process.env.STRIPE_SECRET_KEY) {
    return json(res, 503, { error: "STRIPE_SECRET_KEY not configured" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const plan = body?.plan || "pro_monthly";
  const priceId = plan === "pro_yearly"
    ? process.env.STRIPE_PRICE_PRO_YEARLY
    : process.env.STRIPE_PRICE_PRO_MONTHLY;

  if (!priceId) return json(res, 503, { error: "STRIPE_PRICE_PRO_*  not configured" });

  // Créer ou récupérer le customer Stripe
  let customerId = auth.company.stripe_customer_id;
  if (!customerId) {
    const customerRes = await stripeCall("/v1/customers", "POST", {
      email: auth.user.email,
      "metadata[company_id]": auth.company.id,
      "metadata[user_id]": auth.user.id,
      name: auth.company.legal_name
    });
    if (!customerRes.ok) return json(res, 500, { error: "Customer creation failed" });
    customerId = customerRes.data.id;
    await sbAdmin.update("companies", "id=eq." + auth.company.id, { stripe_customer_id: customerId });
  }

  const origin = req.headers.origin || req.headers.referer?.split("/").slice(0, 3).join("/") || "https://iobill.fr";

  const sessionRes = await stripeCall("/v1/checkout/sessions", "POST", {
    mode: "subscription",
    customer: customerId,
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: origin + "/settings?checkout=success",
    cancel_url: origin + "/settings?checkout=cancel",
    "subscription_data[metadata][company_id]": auth.company.id,
    locale: "fr",
    allow_promotion_codes: "true"
  });

  if (!sessionRes.ok) {
    return json(res, 500, { error: "Checkout creation failed", details: sessionRes.data });
  }

  return json(res, 200, { url: sessionRes.data.url });
}

async function stripeCall(path, method, body) {
  const params = new URLSearchParams(body).toString();
  const r = await fetch("https://api.stripe.com" + path, {
    method,
    headers: {
      Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: method !== "GET" ? params : undefined
  });
  return { ok: r.ok, data: await r.json() };
}
