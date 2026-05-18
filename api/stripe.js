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
import { notifyAdmin } from "./_lib/monitor.js";
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
    notifyAdmin({
      level: "critical",
      subject: "Stripe endpoint plante",
      details: { error: e?.message, stack: (e?.stack || "").slice(0, 1000) }
    }).catch(() => {});
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

  // ─── Routage : checkout firm ou company ───────────────
  if (body?.plan === "firm" || body?.firm_id) {
    return await handleFirmCheckout(req, res, auth, body);
  }

  // ─── Checkout company classique ───────────────────────
  const plan = body?.plan || "pro_monthly";
  const priceId = plan === "pro_yearly"
    ? process.env.STRIPE_PRICE_PRO_YEARLY
    : process.env.STRIPE_PRICE_PRO_MONTHLY;

  if (!priceId) return json(res, 503, { error: "STRIPE_PRICE_PRO_* not configured" });

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
// FIRM CHECKOUT — cabinet comptable, 49€/mois
// 10 premiers cabinets gratuits via coupon 100% off à vie
// ═══════════════════════════════════════════════════════════
async function handleFirmCheckout(req, res, auth, body) {
  const firmId = body?.firm_id;
  if (!firmId) return json(res, 400, { error: "firm_id requis" });

  // Vérifier que l'user est bien membre du firm
  const firmUser = await sbAdmin.selectOne(
    "firm_users",
    `firm_id=eq.${firmId}&user_id=eq.${auth.user.id}`
  );
  if (!firmUser) return json(res, 403, { error: "Vous n'êtes pas membre de ce cabinet" });

  const firm = await sbAdmin.selectOne("firms", `id=eq.${firmId}`);
  if (!firm) return json(res, 404, { error: "Cabinet introuvable" });

  const priceId = process.env.STRIPE_PRICE_FIRM_MONTHLY;
  if (!priceId) return json(res, 503, { error: "STRIPE_PRICE_FIRM_MONTHLY non configuré" });

  // ─── Créer customer Stripe pour le cabinet ────────────
  let customerId = firm.stripe_customer_id;
  if (!customerId) {
    const customerRes = await stripeCall("/v1/customers", "POST", {
      email: firm.email || auth.user.email,
      "metadata[firm_id]": firmId,
      "metadata[type]": "firm",
      name: firm.legal_name || firm.trade_name || "Cabinet"
    });
    if (!customerRes.ok) return json(res, 500, { error: "Customer creation failed" });
    customerId = customerRes.data.id;
    await sbAdmin.update("firms", "id=eq." + firmId, { stripe_customer_id: customerId });
  }

  // ─── Réclamer une place dans les 10 gratuits ──────────
  // Appel RPC à la fonction claim_firm_free_slot()
  // Retourne le rang (1-10) ou NULL si offre épuisée
  let freeRank = null;
  try {
    const SUPA_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
    const r = await fetch(`${SUPA_URL}/rest/v1/rpc/claim_firm_free_slot`, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ p_firm_id: firmId })
    });
    if (r.ok) freeRank = await r.json(); // null ou number
  } catch (e) {
    console.warn("[stripe firm] claim_firm_free_slot a planté:", e?.message);
  }

  // ─── Construction de la session Stripe ────────────────
  const origin = req.headers.origin
    || req.headers.referer?.split("/").slice(0, 3).join("/")
    || "https://iobill.fr";

  const sessionParams = {
    mode: "subscription",
    customer: customerId,
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: origin + "/firm?checkout=success",
    cancel_url: origin + "/firm?checkout=cancel",
    "subscription_data[metadata][firm_id]": firmId,
    "subscription_data[metadata][type]": "firm",
    locale: "fr",
    allow_promotion_codes: "true"
  };

  // Si rang attribué, appliquer le coupon 100% à vie
  if (freeRank !== null && freeRank !== undefined) {
    if (!process.env.STRIPE_COUPON_FIRM_LIFETIME_FREE) {
      console.warn("[stripe firm] STRIPE_COUPON_FIRM_LIFETIME_FREE manquant — le firm sera facturé normalement !");
      notifyAdmin({
        level: "critical",
        subject: "Coupon firm gratuit manquant",
        details: { firm_id: firmId, rank: freeRank, note: "Créer un coupon Stripe 100% off forever et mettre l'ID dans STRIPE_COUPON_FIRM_LIFETIME_FREE" }
      }).catch(() => {});
    } else {
      sessionParams["discounts[0][coupon]"] = process.env.STRIPE_COUPON_FIRM_LIFETIME_FREE;
      sessionParams["subscription_data[metadata][free_rank]"] = String(freeRank);
    }
  }

  const sessionRes = await stripeCall("/v1/checkout/sessions", "POST", sessionParams);
  if (!sessionRes.ok) {
    return json(res, 500, { error: "Firm checkout creation failed", details: sessionRes.data });
  }

  return json(res, 200, {
    url: sessionRes.data.url,
    free_rank: freeRank,  // pour info côté frontend (UI peut féliciter "vous êtes le 3e cabinet à profiter de l'offre")
    pricing: freeRank ? "free_lifetime" : "49_eur_monthly"
  });
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
            // Email bienvenue cabinet
            await sendWelcomeEmail({
              to: session.customer_email || session.customer_details?.email,
              type: "firm",
              freeRank: session.metadata?.free_rank ? parseInt(session.metadata.free_rank, 10) : null
            }).catch(() => {});
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
            // Email bienvenue Pro
            await sendWelcomeEmail({
              to: session.customer_email || session.customer_details?.email,
              type: "pro"
            }).catch(() => {});
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

// ═══════════════════════════════════════════════════════════
// EMAIL DE BIENVENUE
// ═══════════════════════════════════════════════════════════
async function sendWelcomeEmail({ to, type, freeRank }) {
  if (!to || !process.env.RESEND_API_KEY) return;

  const isFirm = type === "firm";
  const subject = isFirm
    ? (freeRank
        ? `🎉 Bienvenue sur IO BILL — Vous êtes le ${freeRank}e cabinet à profiter de l'offre de lancement`
        : "🎉 Bienvenue sur IO BILL — Plan Cabinet activé")
    : "🎉 Bienvenue sur IO BILL Pro";

  const lines = isFirm
    ? [
        freeRank
          ? `Félicitations, vous êtes le <strong>${freeRank}e cabinet</strong> à rejoindre IO BILL ! Votre abonnement Cabinet est <strong>gratuit à vie</strong> dans le cadre de notre offre de lancement (10 premiers cabinets).`
          : "Votre abonnement Cabinet est désormais actif (49 € HT/mois).",
        "<h3>Premiers pas</h3>",
        "<ol><li>Configurez votre cabinet dans <strong>Mon cabinet</strong>",
        "<li>Invitez vos collaborateurs",
        "<li>Ajoutez vos sociétés clientes",
        "<li>Consultez le tableau de bord cabinet pour piloter tout votre portefeuille</li></ol>",
        "<p>Toutes les fonctionnalités Pro (Factur-X 2026/2027, hash chain DGFiP, signature électronique, OCR factures fournisseur) sont incluses pour vous et vos sociétés clientes.</p>"
      ]
    : [
        "Votre abonnement IO BILL Pro est désormais actif. Vous avez accès à toutes les fonctionnalités.",
        "<h3>Premiers pas</h3>",
        "<ol><li>Complétez votre <strong>profil société</strong> (Paramètres → Profil) — n'oubliez pas votre IBAN si vous facturez par virement",
        "<li>Ajoutez vos <strong>premiers clients</strong>",
        "<li>Créez votre <strong>première facture</strong> Factur-X conforme",
        "<li>Activez le <strong>Mode avancé</strong> dans Paramètres → Modules pour accéder à l'audit, l'API développeur, etc.</li></ol>",
        "<p><strong>Besoin d'aide ?</strong> Cliquez sur votre profil en bas à gauche puis <em>« Signaler un problème »</em> pour ouvrir un ticket.</p>"
      ];

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1d22;">
  <table style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">
    <tr><td style="background:#1a1d22;padding:24px;text-align:center;">
      <div style="font-size:28px;color:#d4a843;font-weight:700;letter-spacing:1px;">IO BILL</div>
      <div style="font-size:11px;color:#888;margin-top:4px;letter-spacing:2px;text-transform:uppercase;">${isFirm ? "Plan Cabinet" : "Plan Pro"}</div>
    </td></tr>
    <tr><td style="padding:30px;">
      <h2 style="margin:0 0 16px 0;">${isFirm ? "Bienvenue sur IO BILL Cabinet !" : "Bienvenue sur IO BILL Pro !"}</h2>
      ${lines.join("\n")}
      <div style="margin-top:24px;text-align:center;">
        <a href="https://app.iobill.online" style="display:inline-block;background:#d4a843;color:#1a1d22;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">
          Accéder à IO BILL →
        </a>
      </div>
    </td></tr>
    <tr><td style="background:#f9f9fa;padding:16px 30px;font-size:11px;color:#888;text-align:center;">
      OWL'S INDUSTRY · IO BILL · Facturation Factur-X 2026/2027 conforme<br>
      Vous avez reçu cet email parce que vous venez de souscrire à un abonnement.
    </td></tr>
  </table>
</body></html>`;

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: `IO BILL <${process.env.RESEND_FROM || "noreply@iobill.online"}>`,
        to: [to],
        subject,
        html
      })
    });
    if (!r.ok) {
      console.warn("[welcome email] Resend non-ok:", r.status);
    }
  } catch (e) {
    console.warn("[welcome email] failed:", e?.message);
  }
}
