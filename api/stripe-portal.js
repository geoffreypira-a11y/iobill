// IO BILL - Stripe Customer Portal
import { authenticate, json } from "./_lib/supabase-admin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });

  if (!auth.company.stripe_customer_id) {
    return json(res, 400, { error: "No Stripe customer linked" });
  }

  const origin = req.headers.origin || "https://iobill.fr";

  const r = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      customer: auth.company.stripe_customer_id,
      return_url: origin + "/settings"
    }).toString()
  });

  if (!r.ok) return json(res, 500, { error: "Portal creation failed" });
  const data = await r.json();
  return json(res, 200, { url: data.url });
}
