// IO BILL — api/stripe.js
//
// Fusion de stripe-checkout + stripe-webhook en un seul endpoint
// pour économiser un slot de fonction Vercel (Hobby limite à 12).
//
// ROUTAGE :
//   - Si le header `stripe-signature` est présent → traité comme webhook
//     (Stripe l'envoie automatiquement sur tous ses webhooks signés)
//   - Sinon → traité comme demande de checkout par un utilisateur authentifié
//
// IMPORTANT : `bodyParser: false` est conservé au niveau Vercel parce
// que le webhook a besoin du rawBody pour vérifier la signature HMAC.
// Le checkout parse manuellement le JSON, ce qui marche aussi très bien.
//
// ⚠ ACTION REQUISE après déploiement :
//   Dans Stripe Dashboard → Developers → Webhooks → endpoint existant :
//   remplacer l'URL "https://app.iobill.online/api/stripe-webhook"
//   par "https://app.iobill.online/api/stripe"
//   Sans cela, les webhooks tomberont en 404 et les abonnements
//   ne se synchroniseront plus.

import { sbAdmin, authenticate, json } from "./_lib/supabase-admin.js";
import crypto from "crypto";

export const config = {
  api: { bodyParser: false }
};

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    // Lire le body brut une fois (utile pour les deux modes)
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    const rawBody = Buffer.concat(buffers).toString("utf8");

    // ─── ROUTAGE : webhook si signature Stripe présente ────
    const stripeSig = req.headers["stripe-signature"];
    if (stripeSig) {
      return await handleWebhook(req, res, rawBody, stripeSig);
    }

    // ─── Sinon : checkout (utilisateur authentifié) ───────
    return await handleCheckout(req, res, rawBody);
  } catch (e) {
    console.error("[stripe] UNCAUGHT", e?.stack || e?.message);
    return json(res, 500, { error: "Erreur serveur : " + (e?.message || "inconnue") });
  }
}

// ═══════════════════════════════════════════════════════════
// CHECKOUT — créer une session Stripe Checkout pour s'abonner
// ═══════════════════════════════════════════════════════════
async function handleCheckout(req, res, rawBody) {
  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });

  if (!process.env.STRIPE_SECRET_KEY) {
    return json(res, 503, { error: "STRIPE_SECRET_KEY not configured" });
  }

  let body = {};
  if (rawBody) {
    try { body = JSON.parse(rawBody); } catch { body = {}; }
  }

  const plan = body?.plan || "pro_monthly";
  const priceId = plan === "pro_yearly"
    ? process.env.STRIPE_PRICE_PRO_YEARLY
    : process.env.STRIPE_PRICE_PRO_MONTHLY;

  if (!priceId) return json(res, 503, { error: "STRIPE_PRICE_PRO_* not configured" });

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
    await sbAdmin.update("companies", "id=eq." + auth.company.id, {
      stripe_customer_id: customerId
    });
  }

  const origin = req.headers.origin
    || req.headers.referer?.split("/").slice(0, 3).join("/")
    || "https://iobill.fr";

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

// ═══════════════════════════════════════════════════════════
// WEBHOOK — réception des événements Stripe
// ═══════════════════════════════════════════════════════════
async function handleWebhook(req, res, rawBody, sig) {
  if (!verifyStripeSignature(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET)) {
    return json(res, 400, { error: "Invalid signature" });
  }

  const event = JSON.parse(rawBody);

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const type = session.metadata?.type;
        // Firm subscription (plan Cabinet)
        if (type === "firm" || session.metadata?.firm_id) {
          const firmId = session.metadata?.firm_id;
          if (firmId) {
            await sbAdmin.update("firms", "id=eq." + firmId, {
              stripe_sub_id: session.subscription,
              stripe_sub_status: "active"
            });
          }
        } else {
          // Company subscription (plan Pro standard)
          const companyId = session.metadata?.company_id
            || (await findCompanyByCustomer(session.customer))?.id;
          if (companyId) {
            await sbAdmin.update("companies", "id=eq." + companyId, {
              stripe_subscription_id: session.subscription,
              sub_status: "active",
              subscribed_at: new Date().toISOString(),
              payment_failed_at: null
            });
          }
          // Paiement d'une facture client via Payment Link
          const invoiceId = session.metadata?.invoice_id;
          if (invoiceId) {
            await markInvoicePaidFromStripe(invoiceId, session);
          }
        }
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object;
        const type = sub.metadata?.type;
        if (type === "firm" || sub.metadata?.firm_id) {
          const firmId = sub.metadata?.firm_id;
          if (firmId) {
            await sbAdmin.update("firms", "id=eq." + firmId, {
              stripe_sub_status: sub.status,
              stripe_sub_id: sub.id
            });
          }
        } else {
          const company = await findCompanyByCustomer(sub.customer);
          if (company) {
            await sbAdmin.update("companies", "id=eq." + company.id, {
              sub_status: sub.status,
              stripe_subscription_id: sub.id
            });
          }
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const type = sub.metadata?.type;
        if (type === "firm" || sub.metadata?.firm_id) {
          const firmId = sub.metadata?.firm_id;
          if (firmId) {
            await sbAdmin.update("firms", "id=eq." + firmId, {
              stripe_sub_status: "canceled",
              stripe_sub_id: null
            });
          }
        } else {
          const company = await findCompanyByCustomer(sub.customer);
          if (company) {
            await sbAdmin.update("companies", "id=eq." + company.id, {
              sub_status: "canceled",
              stripe_subscription_id: null
            });
          }
        }
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object;
        const firm = await findFirmByCustomer(inv.customer);
        if (firm) {
          await sbAdmin.update("firms", "id=eq." + firm.id, { stripe_sub_status: "past_due" });
        } else {
          const company = await findCompanyByCustomer(inv.customer);
          if (company) {
            await sbAdmin.update("companies", "id=eq." + company.id, {
              sub_status: "past_due",
              payment_failed_at: new Date().toISOString()
            });
          }
        }
        break;
      }
      case "payment_intent.succeeded": {
        // Paiement d'une facture client via Stripe Payment Link
        const obj = event.data.object;
        const invoiceId = obj.metadata?.invoice_id;
        if (invoiceId) {
          await markInvoicePaidFromStripe(invoiceId, obj);
        }
        break;
      }
    }
  } catch (e) {
    console.error("Webhook handling error:", e);
  }

  return json(res, 200, { received: true });
}

// ─── Helpers webhook ────────────────────────────────────────
async function findCompanyByCustomer(customerId) {
  if (!customerId) return null;
  return sbAdmin.selectOne("companies", "stripe_customer_id=eq." + customerId);
}

async function findFirmByCustomer(customerId) {
  if (!customerId) return null;
  return sbAdmin.selectOne("firms", "stripe_customer_id=eq." + customerId);
}

async function markInvoicePaidFromStripe(invoiceId, stripeObj) {
  const inv = await sbAdmin.selectOne("invoices", "id=eq." + invoiceId);
  if (!inv) return;
  const amount = stripeObj.amount_total || stripeObj.amount_received || stripeObj.amount;
  if (!amount) return;
  await sbAdmin.insert("payments", {
    company_id: inv.company_id,
    invoice_id: invoiceId,
    amount_cents: amount,
    method: "stripe",
    paid_at: new Date().toISOString().slice(0, 10),
    stripe_charge_id: stripeObj.id,
    match_method: "auto",
    match_confidence: 1.0
  });
  const newPaid = (inv.paid_cents || 0) + amount;
  const fullyPaid = newPaid >= inv.total_ttc_cents;
  await sbAdmin.update("invoices", "id=eq." + invoiceId, {
    paid_cents: newPaid,
    status: fullyPaid ? "paid" : "partial"
  });

  // Notification push aux users de la company
  try {
    const { sendPushToCompany } = await import("./_lib/push-sender.js");
    const cs = inv.client_snapshot || {};
    const clientName = cs.legal_name
      || `${cs.first_name || ""} ${cs.last_name || ""}`.trim()
      || "client";
    const formatted = (amount / 100).toLocaleString("fr-FR", {
      style: "currency", currency: "EUR"
    });
    await sendPushToCompany(inv.company_id, {
      title: fullyPaid ? "🎉 Facture payée intégralement" : "💰 Paiement partiel reçu",
      body: `${formatted} · ${clientName} · facture ${inv.number}`,
      url: `/invoices/${invoiceId}`,
      tag: `invoice-paid-${invoiceId}`,
      requireInteraction: false
    });
  } catch (e) {
    console.warn("[stripe] push send failed:", e?.message);
  }
}

function verifyStripeSignature(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = header.split(",").reduce((acc, p) => {
    const [k, v] = p.split("=");
    acc[k] = v;
    return acc;
  }, {});
  if (!parts.t || !parts.v1) return false;
  const signedPayload = parts.t + "." + payload;
  const expected = crypto.createHmac("sha256", secret).update(signedPayload).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
  } catch {
    return false;
  }
}

// ─── Helper d'appel Stripe API ────────────────────────────
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
