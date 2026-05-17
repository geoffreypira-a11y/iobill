// IO BILL - Consultation publique d'un document via token (devis, facture, portail).
// Pas d'authentification requise — verification du token uniquement.
// Supporte aussi l'acceptation simple d'un devis (signature lite pour la beta).

import { sbAdmin, json } from "./_lib/supabase-admin.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  // Token via query string OU body
  const body = req.body && (typeof req.body === "string" ? safeParse(req.body) : req.body);
  const token =
    (req.query && req.query.token) ||
    (body && body.token);

  if (!token) return json(res, 400, { error: "Token required" });

  // Action explicite ? (accept_quote, refuse_quote)
  const action = body && body.action;

  // Consommer le token (incremente use_count, verifie expiration/revocation)
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || null;
  const consumed = await sbAdmin.rpc("consume_public_token", { p_token: token, p_ip: ip });
  if (!consumed || !consumed[0]) {
    return json(res, 404, { error: "Token invalid, expired or revoked" });
  }
  const { company_id, scope, resource_id, use_count } = consumed[0];

  // ─── NOTIF : 1ere consultation du document (use_count == 1 apres consume) ───
  // On notifie une seule fois pour eviter le spam.
  // Seulement pour les scopes quote et invoice (pas portal pour pas spammer).
  if (req.method === "GET" && (scope === "quote" || scope === "invoice") && use_count === 1) {
    try {
      const docTable = scope === "quote" ? "quotes" : "invoices";
      const doc = await sbAdmin.selectOne(docTable, `id=eq.${resource_id}`);
      if (doc) {
        const cs = doc.client_snapshot || {};
        const clientName = cs.legal_name ||
          `${cs.first_name || ""} ${cs.last_name || ""}`.trim() ||
          "Le client";
        const label = scope === "quote" ? "devis" : "facture";
        await sbAdmin.rpc("create_notification", {
          p_company_id: company_id,
          p_notif_type: "quote_viewed",
          p_title: `${scope === "quote" ? "Devis" : "Facture"} consulté`,
          p_body: `${clientName} a ouvert le ${label} ${doc.number || ""} pour la première fois`,
          p_url: `/${scope === "quote" ? "quotes" : "invoices"}/${resource_id}`,
          p_severity: "info",
          p_icon: "👁",
          p_metadata: { [`${scope}_id`]: resource_id, number: doc.number, client: clientName, ip }
        }).catch(() => {});
      }
    } catch {}
  }

  // ─── ACTION : Accepter un devis (signature simple, pas de Yousign) ───
  if (action === "accept_quote") {
    if (scope !== "quote") return json(res, 400, { error: "Token n'est pas pour un devis" });
    const quote = await sbAdmin.selectOne("quotes", `id=eq.${resource_id}`);
    if (!quote) return json(res, 404, { error: "Devis introuvable" });
    if (quote.status === "signed") return json(res, 200, { ok: true, already_signed: true });
    if (!["sent", "draft"].includes(quote.status)) {
      return json(res, 400, { error: "Ce devis ne peut plus être accepté (statut : " + quote.status + ")" });
    }
    const signerName = (body.signer_name || "").trim().slice(0, 120);
    if (!signerName) return json(res, 400, { error: "Nom du signataire requis" });
    await sbAdmin.update("quotes", `id=eq.${resource_id}`, {
      status: "signed",
      signed_at: new Date().toISOString(),
      signed_by_name: signerName,
      signed_ip: ip,
      signature_provider: "simple"
    });
    return json(res, 200, { ok: true, accepted: true });
  }

  // ─── ACTION : Refuser un devis ───
  if (action === "refuse_quote") {
    if (scope !== "quote") return json(res, 400, { error: "Token n'est pas pour un devis" });
    const quote = await sbAdmin.selectOne("quotes", `id=eq.${resource_id}`);
    if (!quote) return json(res, 404, { error: "Devis introuvable" });
    if (!["sent", "draft"].includes(quote.status)) {
      return json(res, 400, { error: "Ce devis ne peut plus être refusé (statut : " + quote.status + ")" });
    }
    const reason = (body.refusal_reason || "").trim().slice(0, 500);
    await sbAdmin.update("quotes", `id=eq.${resource_id}`, {
      status: "refused",
      refused_at: new Date().toISOString(),
      refusal_reason: reason
    });
    return json(res, 200, { ok: true, refused: true });
  }

  // ─── CONSULTATION (lecture seule) ───
  // Charger les infos de la societe (pour branding)
  const company = await sbAdmin.selectOne(
    "companies",
    `id=eq.${company_id}`,
    "id,legal_name,trade_name,email,phone,siret,vat_number,address_line1,address_line2,postal_code,city,country,logo_url,brand_color,modules"
  );

  // Generer une URL signee 1h pour le logo (le frontend public n'a pas d'auth)
  if (company && company.logo_url) {
    company.logo_signed_url = await getSignedLogoUrl(company.logo_url, 3600);
  }

  if (scope === "quote") {
    const [quote, lines] = await Promise.all([
      sbAdmin.selectOne("quotes", `id=eq.${resource_id}`),
      sbAdmin.select("document_lines", {
        filter: `document_type=eq.quote&document_id=eq.${resource_id}`,
        order: "sort_order.asc"
      })
    ]);
    if (!quote) return json(res, 404, { error: "Quote not found" });
    return json(res, 200, { scope: "quote", company, document: quote, lines: lines || [] });
  }

  if (scope === "invoice") {
    const [invoice, lines] = await Promise.all([
      sbAdmin.selectOne("invoices", `id=eq.${resource_id}`),
      sbAdmin.select("document_lines", {
        filter: `document_type=eq.invoice&document_id=eq.${resource_id}`,
        order: "sort_order.asc"
      })
    ]);
    if (!invoice) return json(res, 404, { error: "Invoice not found" });
    return json(res, 200, { scope: "invoice", company, document: invoice, lines: lines || [] });
  }

  if (scope === "portal") {
    // Charger le client + ses factures
    const [client, invoices, quotes] = await Promise.all([
      sbAdmin.selectOne(
        "clients",
        `id=eq.${resource_id}`,
        "id,client_type,legal_name,first_name,last_name,email,contact_person"
      ),
      sbAdmin.select("invoices", {
        filter: `client_id=eq.${resource_id}&status=in.(issued,sent,partial,paid,overdue)`,
        order: "issue_date.desc",
        select: "id,number,issue_date,due_date,total_ttc_cents,paid_cents,status,pdf_url,facturx_pdf_url,stripe_payment_link_url"
      }),
      sbAdmin.select("quotes", {
        filter: `client_id=eq.${resource_id}&status=in.(sent,signed,refused,converted)`,
        order: "issue_date.desc",
        select: "id,number,issue_date,expires_at,total_ttc_cents,status,pdf_url"
      })
    ]);
    if (!client) return json(res, 404, { error: "Client not found" });
    return json(res, 200, {
      scope: "portal",
      company,
      client,
      invoices: invoices || [],
      quotes: quotes || []
    });
  }

  return json(res, 400, { error: "Unknown scope" });
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Genere une URL signee pour le logo dans le bucket company-logos
async function getSignedLogoUrl(path, expiresIn = 3600) {
  if (!path) return null;
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  try {
    const r = await fetch(`${url}/storage/v1/object/sign/company-logos/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ expiresIn })
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.signedURL ? `${url}/storage/v1${j.signedURL}` : null;
  } catch (e) {
    return null;
  }
}
