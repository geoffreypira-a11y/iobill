// IO BILL — API publique unifiée (fusion de public-fetch + public-share)
// ═══════════════════════════════════════════════════════════════════════════
// Routage par paramètre `op` :
//   - op=share  → POST authentifié, crée un token public (ex public-share)
//   - op=fetch  → GET / POST non authentifié, consulte ou agit via token
//                 (ex public-fetch : consultation, accept_quote, refuse_quote)
//
// Pour rétro-compatibilité minimale, si `op` est absent on devine :
//   - méthode POST + header Authorization présent → share
//   - sinon → fetch
// ═══════════════════════════════════════════════════════════════════════════

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";

export default async function handler(req, res) {
  // Détermine l'opération
  const op = (req.query && req.query.op) || inferOp(req);

  if (op === "share") return handleShare(req, res);
  if (op === "fetch") return handleFetch(req, res);
  if (op === "external") return handleExternal(req, res);
  return json(res, 400, { error: "Unknown op. Use ?op=share, ?op=fetch or ?op=external" });
}

function inferOp(req) {
  // Si Authorization présent + POST → share. Sinon → fetch.
  const hasAuth = !!(req.headers && req.headers.authorization);
  if (hasAuth && req.method === "POST") return "share";
  return "fetch";
}

// ═══════════════════════════════════════════════════════════════════════════
// SHARE — Crée un token public pour un devis, une facture ou un portail
// ═══════════════════════════════════════════════════════════════════════════
async function handleShare(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { company, user } = auth;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const { scope, resource_id, recipient_email, expires_in_days = 90 } = body || {};
  if (!["quote", "invoice", "portal"].includes(scope)) {
    return json(res, 400, { error: "Invalid scope" });
  }
  if (!resource_id) return json(res, 400, { error: "resource_id required" });

  // Verifier que la resource appartient bien a la company
  if (scope === "quote") {
    const q = await sbAdmin.selectOne("quotes", `id=eq.${resource_id}&company_id=eq.${company.id}`);
    if (!q) return json(res, 404, { error: "Quote not found" });
  } else if (scope === "invoice") {
    const i = await sbAdmin.selectOne("invoices", `id=eq.${resource_id}&company_id=eq.${company.id}`);
    if (!i) return json(res, 404, { error: "Invoice not found" });
  } else if (scope === "portal") {
    const c = await sbAdmin.selectOne("clients", `id=eq.${resource_id}&company_id=eq.${company.id}`);
    if (!c) return json(res, 404, { error: "Client not found" });
  }

  // Generer token URL-safe
  const token = generateToken(32);
  const expiresAt = expires_in_days
    ? new Date(Date.now() + expires_in_days * 86400000).toISOString()
    : null;

  const created = await sbAdmin.insert("public_tokens", {
    token,
    company_id: company.id,
    scope,
    resource_id,
    recipient_email: recipient_email || null,
    expires_at: expiresAt,
    created_by: user.id
  });

  if (!created || !created[0]) {
    return json(res, 500, { error: "Token creation failed" });
  }

  // URL publique a partager
  const baseUrl = req.headers["x-forwarded-host"]
    ? `https://${req.headers["x-forwarded-host"]}`
    : (process.env.PUBLIC_BASE_URL || "");
  const path = scope === "portal" ? `/p/portal/${token}` : `/p/${scope}/${token}`;

  return json(res, 200, {
    ok: true,
    token,
    public_url: baseUrl + path,
    expires_at: expiresAt
  });
}

function generateToken(length) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  const arr = new Uint8Array(length);
  globalThis.crypto?.getRandomValues?.(arr);
  for (let i = 0; i < length; i++) {
    out += chars[arr[i] % chars.length];
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// FETCH — Consultation publique d'un document via token (sans auth)
// Supporte accept_quote / refuse_quote pour signature lite
// ═══════════════════════════════════════════════════════════════════════════
async function handleFetch(req, res) {
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

// ═══════════════════════════════════════════════════════════════════════════
// EXTERNAL — Pont API pour les apps de l'écosystème OWL (IOCAR, IOBTP, ...)
//
// Auth : header X-External-Secret avec la valeur de IOBILL_EXTERNAL_SECRET.
//
// Actions :
//   - link_account   : crée/lie une company IOBILL à un user externe
//                      Accepte optionnellement un `password` pour permettre
//                      au user d'utiliser le même MDP qu'IOCAR.
//   - sync_company   : met à jour les champs de la company depuis l'app source
//                      (les champs envoyés deviennent "managed" → alerte UI
//                      côté IOBILL si l'user les modifie).
//   - push_invoice   : crée une facture IOBILL à partir d'un payload
//                      normalisé venant de l'app source. Idempotent via
//                      (external_source, external_id).
// ═══════════════════════════════════════════════════════════════════════════
async function handleExternal(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const provided = req.headers["x-external-secret"] || req.headers["X-External-Secret"];
  const expected = process.env.IOBILL_EXTERNAL_SECRET;
  if (!expected) {
    console.error("[external] IOBILL_EXTERNAL_SECRET non configuré côté serveur");
    return json(res, 500, { error: "External bridge not configured" });
  }
  if (!provided || provided !== expected) {
    return json(res, 401, { error: "Invalid external secret" });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== "object") return json(res, 400, { error: "Invalid body" });

  const { action } = body;
  if (action === "link_account") return handleLinkAccount(body, res);
  if (action === "sync_company") return handleSyncCompany(body, res);
  if (action === "push_invoice") return handlePushInvoice(body, res);
  if (action === "update_invoice_status") return handleUpdateInvoiceStatus(body, res);
  return json(res, 400, { error: `Unknown external action: ${action}` });
}

// ───────────────────────────────────────────────────────────────────────────
// LINK_ACCOUNT — crée/lie une company IOBILL pour un user externe
//
// Body :
//   source_app   : "iocar" | "iobtp" | ...
//   external_ref : ID dans l'app source (ex. garages.id)
//   email        : email du user
//   password     : (optionnel) MDP en clair, utilisé pour créer le user
//                  IOBILL avec le même MDP qu'IOCAR. Le MDP n'est pas stocké.
//   legal_name, phone, siret, address, ... : infos pour pré-remplir la company
//
// Idempotent : si (source_app, external_ref) existe déjà, retourne l'existant.
// ───────────────────────────────────────────────────────────────────────────
async function handleLinkAccount(body, res) {
  const { source_app, external_ref, email, password, legal_name } = body;

  if (!source_app || typeof source_app !== "string") {
    return json(res, 400, { error: "source_app required" });
  }
  if (!external_ref) return json(res, 400, { error: "external_ref required" });
  if (!email || typeof email !== "string") return json(res, 400, { error: "email required" });
  if (!legal_name || typeof legal_name !== "string") {
    return json(res, 400, { error: "legal_name required" });
  }

  const cleanEmail = email.trim().toLowerCase();
  const companyFields = buildCompanyFieldsFromBody(body);

  try {
    // 1) Déjà lié ?
    const existing = await sbAdmin.selectOne(
      "companies",
      `source_app=eq.${source_app}&external_ref=eq.${encodeURIComponent(external_ref)}`
    );

    if (existing) {
      const tokenRow = await ensureToken(existing.id, source_app);
      // On sync les champs même si le compte existe déjà (idempotent + à jour)
      await applyCompanyUpdate(existing.id, companyFields, /*managed*/ true);
      return json(res, 200, {
        ok: true, created: false,
        company_id: existing.id, user_id: existing.user_id,
        email: existing.email, token: tokenRow.token
      });
    }

    // 2) User existant côté IOBILL ?
    let userId = await findUserByEmail(cleanEmail);

    // 3) Sinon créer (avec password si fourni)
    if (!userId) {
      userId = await createAuthUser(cleanEmail, password || null, { source_app, external_ref });
      if (!userId) {
        return json(res, 500, { error: "Échec création utilisateur IOBILL" });
      }
    } else if (password) {
      // User existant : on ne réécrit PAS son MDP (sinon on casserait un user qui aurait
      // déjà son compte IOBILL). On laisse tel quel.
      console.log(`[external/link] user ${userId} existait déjà, MDP IOCAR ignoré`);
    }

    // 4) Créer la company
    const managedFields = Object.keys(companyFields);
    const insertedRows = await sbAdmin.insert("companies", {
      user_id: userId,
      legal_name,
      email: cleanEmail,
      ...companyFields,
      source_app,
      external_ref: String(external_ref),
      external_managed_fields: managedFields,
      vat_regime: "franchise"
    });
    const newCompany = insertedRows && insertedRows[0];
    if (!newCompany) return json(res, 500, { error: "Échec création company IOBILL" });

    // 5) Token API
    const tokenRow = await ensureToken(newCompany.id, source_app);

    return json(res, 200, {
      ok: true, created: true,
      company_id: newCompany.id, user_id: userId,
      email: cleanEmail, token: tokenRow.token
    });
  } catch (err) {
    console.error("[external/link_account] ERROR:", err);
    return json(res, 500, { error: String(err.message || err) });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// SYNC_COMPANY — met à jour la company depuis l'app source
//
// Body :
//   token        : token API de la company (Authorization-like)
//   ...champs    : les mêmes que link_account
// ───────────────────────────────────────────────────────────────────────────
async function handleSyncCompany(body, res) {
  const company = await resolveCompanyFromToken(body.token);
  if (!company) return json(res, 401, { error: "Invalid token" });

  const fields = buildCompanyFieldsFromBody(body);
  if (Object.keys(fields).length === 0) {
    return json(res, 400, { error: "Aucun champ à synchroniser" });
  }

  const updated = await applyCompanyUpdate(company.id, fields, /*managed*/ true);
  return json(res, 200, { ok: true, company_id: company.id, updated_fields: Object.keys(fields) });
}

// ───────────────────────────────────────────────────────────────────────────
// PUSH_INVOICE — crée une invoice IOBILL à partir d'un payload normalisé
//
// Body :
//   token : token API de la company
//   invoice : {
//     external_id   : ID dans l'app source (idempotence)
//     number, issue_date, due_date?, status?,
//     client: { legal_name?, first_name?, last_name?, email?, phone?,
//               siret?, address_line1?, postal_code?, city?, country? },
//     lines: [ { description, quantity?, unit_price_ht_cents, vat_rate?,
//                discount_pct? }, ... ],
//     totals?: { subtotal_ht_cents, vat_total_cents, total_ttc_cents, paid_cents? },
//     notes?, terms?,
//     vehicle_meta?: { plate, vin, marque, modele, kilometrage, ... },
//     vat_regime?: "standard" | "margin_297a"  (margin = TVA marge art. 297A)
//   }
// ───────────────────────────────────────────────────────────────────────────
async function handlePushInvoice(body, res) {
  const company = await resolveCompanyFromToken(body.token);
  if (!company) return json(res, 401, { error: "Invalid token" });

  const { invoice } = body;
  if (!invoice || typeof invoice !== "object") {
    return json(res, 400, { error: "invoice required" });
  }
  const externalId = invoice.external_id;
  if (!externalId) return json(res, 400, { error: "invoice.external_id required" });
  if (!invoice.number) return json(res, 400, { error: "invoice.number required" });
  if (!Array.isArray(invoice.lines) || invoice.lines.length === 0) {
    return json(res, 400, { error: "invoice.lines (non vide) required" });
  }

  try {
    // 1) Trouver/créer le client
    const clientId = await upsertClient(company.id, invoice.client || {});

    // 2) Idempotence : existe déjà ?
    const existing = await sbAdmin.selectOne(
      "invoices",
      `external_source=eq.${company.source_app}&external_id=eq.${encodeURIComponent(externalId)}`
    );

    // 3) Build payload invoice
    const totals = computeTotalsFromLines(invoice.lines, invoice.totals);
    const companySnapshot = buildCompanySnapshot(company);
    const clientSnapshot = await buildClientSnapshot(clientId, invoice.client || {});

    // v8.37 — Cohérence forcée : si status=paid, paid_cents == total_ttc_cents.
    // Évite tout désalignement entre le statut et les totaux.
    const requestedStatus = invoice.status || "issued";
    const isPaidStatus = requestedStatus === "paid";
    const paidCents = isPaidStatus
      ? totals.total_ttc_cents
      : totals.paid_cents;

    const invoicePayload = {
      company_id: company.id,
      client_id: clientId,
      number: invoice.number,
      client_snapshot: clientSnapshot,
      company_snapshot: companySnapshot,
      issue_date: invoice.issue_date || new Date().toISOString().slice(0, 10),
      due_date: invoice.due_date || null,
      status: requestedStatus,
      subtotal_ht_cents: totals.subtotal_ht_cents,
      vat_total_cents: totals.vat_total_cents,
      total_ttc_cents: totals.total_ttc_cents,
      paid_cents: paidCents,
      vat_breakdown: totals.vat_breakdown,
      notes: invoice.notes || buildNotesFromMeta(invoice),
      terms: invoice.terms || null,
      external_source: company.source_app,
      external_id: String(externalId),
      // issued_at = maintenant car la facture est figée à la création depuis l'externe
      issued_at: new Date().toISOString()
    };

    let invoiceRow;
    if (existing) {
      // Update
      const updated = await sbAdmin.update(
        "invoices",
        `id=eq.${existing.id}`,
        invoicePayload
      );
      invoiceRow = updated && updated[0];
      // Supprimer les anciennes lignes pour les recréer
      await sbAdmin.delete("document_lines", `document_type=eq.invoice&document_id=eq.${existing.id}`);
      // v8.37 — pour idempotence du status paid, on supprime aussi les anciens
      // payments liés à cette invoice avant de recréer.
      await sbAdmin.delete("payments", `invoice_id=eq.${existing.id}`);
    } else {
      const inserted = await sbAdmin.insert("invoices", invoicePayload);
      invoiceRow = inserted && inserted[0];
    }
    if (!invoiceRow) return json(res, 500, { error: "Échec écriture invoice" });

    // 4) Insérer les lignes
    const linesToInsert = invoice.lines.map((ln, i) => {
      const qty = Number(ln.quantity || 1);
      const up = Number(ln.unit_price_ht_cents || 0);
      const vatRate = Number(ln.vat_rate ?? 20);
      const discPct = Number(ln.discount_pct || 0);
      const lineHt = Math.round(qty * up * (1 - discPct / 100));
      const lineVat = Math.round(lineHt * vatRate / 100);
      const lineTtc = lineHt + lineVat;
      return {
        company_id: company.id,
        document_type: "invoice",
        document_id: invoiceRow.id,
        sort_order: i,
        description: String(ln.description || ""),
        quantity: qty,
        unit: ln.unit || null,
        unit_price_ht_cents: up,
        vat_rate: vatRate,
        discount_pct: discPct,
        line_ht_cents: lineHt,
        line_vat_cents: lineVat,
        line_ttc_cents: lineTtc
      };
    });
    if (linesToInsert.length > 0) {
      await sbAdmin.insert("document_lines", linesToInsert);
    }

    // 4bis) v8.37 — Insérer les payments si fournis
    // L'app source (IOCAR) envoie le détail des règlements : acompte signature,
    // virements, espèces, etc. On les crée dans IOBILL pour que le comptable
    // voie le détail (modes, dates) et non juste un total.
    if (Array.isArray(invoice.payments) && invoice.payments.length > 0) {
      const paymentsToInsert = invoice.payments
        .filter(p => Number(p.amount_cents) > 0)
        .map(p => ({
          company_id: company.id,
          invoice_id: invoiceRow.id,
          amount_cents: Math.round(Number(p.amount_cents)),
          method: p.method || 'other',
          paid_at: p.paid_at || invoiceRow.issue_date,
          notes: p.notes || null,
          reference: p.reference || null
        }));
      if (paymentsToInsert.length > 0) {
        await sbAdmin.insert("payments", paymentsToInsert);
      }
    }

    // 5) v8.37 — Déclenchement Factur-X en arrière-plan (fire-and-forget)
    // Pour les factures issued/paid/sent venant d'une app externe, on génère
    // le PDF/A-3 + XML EN16931 immédiatement. Pour les factures draft, on
    // attend que le user passe en non-draft (au Livré côté IOCAR par ex.).
    if (!isDraftStatus(requestedStatus)) {
      triggerFacturxGeneration(invoiceRow.id);
    }

    return json(res, 200, {
      ok: true,
      created: !existing,
      invoice_id: invoiceRow.id,
      invoice_number: invoiceRow.number,
      pdf_url: invoiceRow.pdf_url || invoiceRow.facturx_pdf_url || null,
      client_id: clientId,
      status: requestedStatus,
      facturx_status: invoiceRow.facturx_status || "pending"
    });
  } catch (err) {
    console.error("[external/push_invoice] ERROR:", err);
    return json(res, 500, { error: String(err.message || err) });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// UPDATE_INVOICE_STATUS — change le statut d'une facture externe
//
// Body :
//   token         : token API de la company
//   external_id   : ID source (orders.id côté IOCAR)
//   new_status    : "paid" (autres futurs : "canceled")
//   payments      : (optionnel) liste à ajouter en cas de passage à paid
//
// Cas d'usage principal :
//   - IOCAR fait push_invoice(status=draft) à la conversion BC→Facture
//   - IOCAR fait update_invoice_status(paid + payments) au clic "Livré"
// ───────────────────────────────────────────────────────────────────────────
async function handleUpdateInvoiceStatus(body, res) {
  const company = await resolveCompanyFromToken(body.token);
  if (!company) return json(res, 401, { error: "Invalid token" });

  const { external_id, new_status } = body;
  if (!external_id) return json(res, 400, { error: "external_id required" });

  const ALLOWED_TRANSITIONS = {
    draft: ["paid", "issued", "canceled"],
    issued: ["paid", "partial", "canceled"],
    sent: ["paid", "partial", "canceled"],
    partial: ["paid", "canceled"],
    paid: [], // état terminal — on ne peut pas en sortir
    overdue: ["paid", "canceled"],
    canceled: [] // état terminal aussi
  };

  if (!new_status) return json(res, 400, { error: "new_status required" });

  try {
    // Trouve la facture par couple (external_source, external_id)
    const inv = await sbAdmin.selectOne(
      "invoices",
      `external_source=eq.${company.source_app}&external_id=eq.${encodeURIComponent(external_id)}&company_id=eq.${company.id}`
    );
    if (!inv) return json(res, 404, { error: "Facture externe introuvable" });

    // Vérif transition valide
    const allowed = ALLOWED_TRANSITIONS[inv.status] || [];
    if (!allowed.includes(new_status) && inv.status !== new_status) {
      return json(res, 400, {
        error: `Transition non autorisée : ${inv.status} → ${new_status}`,
        code: "INVALID_TRANSITION"
      });
    }

    // Build patch
    const patch = {
      status: new_status,
      updated_at: new Date().toISOString()
    };
    if (new_status === "paid") {
      patch.paid_cents = inv.total_ttc_cents;
      // Si pas encore issued_at, on le met (cas draft → paid direct)
      if (!inv.issued_at) patch.issued_at = new Date().toISOString();
    }

    const updated = await sbAdmin.update("invoices", `id=eq.${inv.id}`, patch);
    if (!updated || !updated[0]) return json(res, 500, { error: "Échec mise à jour" });

    // Si payments fournis, on remplace les anciens
    if (Array.isArray(body.payments)) {
      // Supprime anciens
      await sbAdmin.delete("payments", `invoice_id=eq.${inv.id}`);
      // Insère nouveaux
      const paymentsToInsert = body.payments
        .filter(p => Number(p.amount_cents) > 0)
        .map(p => ({
          company_id: company.id,
          invoice_id: inv.id,
          amount_cents: Math.round(Number(p.amount_cents)),
          method: p.method || 'other',
          paid_at: p.paid_at || inv.issue_date,
          notes: p.notes || null,
          reference: p.reference || null
        }));
      if (paymentsToInsert.length > 0) {
        await sbAdmin.insert("payments", paymentsToInsert);
      }
    }

    // Si on bascule en non-draft et que le Factur-X n'est pas encore généré,
    // on lance la génération.
    const becameNonDraft = isDraftStatus(inv.status) && !isDraftStatus(new_status);
    if (becameNonDraft && (!inv.facturx_status || inv.facturx_status === "pending")) {
      triggerFacturxGeneration(inv.id);
    }

    return json(res, 200, {
      ok: true,
      invoice_id: inv.id,
      invoice_number: inv.number,
      status: new_status,
      pdf_url: updated[0].facturx_pdf_url || updated[0].pdf_url || null,
      facturx_status: updated[0].facturx_status || "pending"
    });
  } catch (err) {
    console.error("[external/update_invoice_status] ERROR:", err);
    return json(res, 500, { error: String(err.message || err) });
  }
}

function isDraftStatus(s) {
  return !s || s === "draft";
}

// Déclenchement async (fire-and-forget) de la génération Factur-X.
// Sur Vercel, Promise.resolve().then() survit le temps que la fn termine.
// La response a déjà été envoyée → l'user IOCAR ne sent aucune latence.
function triggerFacturxGeneration(invoiceId) {
  const url = process.env.APP_URL || "https://app.iobill.online";
  const internalSecret = process.env.IOBILL_INTERNAL_GEN_SECRET
                       || process.env.IOBILL_EXTERNAL_SECRET;
  // Fire-and-forget : on n'attend PAS la fin
  Promise.resolve().then(async () => {
    try {
      const r = await fetch(`${url}/api/generate-facturx`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": internalSecret
        },
        body: JSON.stringify({
          internal: true,
          document_type: "invoice",
          document_id: invoiceId
        })
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        console.warn(`[triggerFacturxGen] failed status=${r.status}: ${txt}`);
      } else {
        console.log(`[triggerFacturxGen] OK invoice=${invoiceId}`);
      }
    } catch (e) {
      console.warn("[triggerFacturxGen] error:", e.message);
    }
  });
}

// ───────────────────────────────────────────────────────────────────────────
// HELPERS communs
// ───────────────────────────────────────────────────────────────────────────

// Construit les champs companies depuis le body (uniquement les champs présents)
function buildCompanyFieldsFromBody(body) {
  const out = {};
  const addr = body.address || {};
  // Mapping direct
  if (body.legal_name !== undefined) out.legal_name = body.legal_name;
  if (body.trade_name !== undefined) out.trade_name = body.trade_name;
  if (body.siret !== undefined) out.siret = body.siret;
  if (body.vat_number !== undefined) out.vat_number = body.vat_number;
  if (body.ape_code !== undefined) out.ape_code = body.ape_code;
  if (body.phone !== undefined) out.phone = body.phone;
  if (body.website !== undefined) out.website = body.website;
  if (body.logo_url !== undefined) out.logo_url = body.logo_url;
  // Adresse
  if (addr.line1 !== undefined) out.address_line1 = addr.line1;
  if (addr.line2 !== undefined) out.address_line2 = addr.line2;
  if (addr.postal_code !== undefined) out.postal_code = addr.postal_code;
  if (addr.city !== undefined) out.city = addr.city;
  if (addr.country !== undefined) out.country = addr.country;
  return out;
}

// Update conservative : on n'écrase pas, on écrit tels quels les champs
// envoyés par l'app source. L'alerte UI côté IOBILL avertit l'user si
// jamais il modifie un de ces champs ensuite.
async function applyCompanyUpdate(companyId, fields, addToManaged) {
  if (Object.keys(fields).length === 0) return null;

  let payload = { ...fields, updated_at: new Date().toISOString() };

  if (addToManaged) {
    // Lit la liste actuelle des managed_fields, fusionne, écrit.
    const current = await sbAdmin.selectOne("companies", `id=eq.${companyId}`, "external_managed_fields");
    const setOfMan = new Set(current?.external_managed_fields || []);
    Object.keys(fields).forEach(k => setOfMan.add(k));
    payload.external_managed_fields = Array.from(setOfMan);
  }

  return await sbAdmin.update("companies", `id=eq.${companyId}`, payload);
}

// Résout la company à partir d'un token API. last_used_at est mis à jour.
async function resolveCompanyFromToken(token) {
  if (!token || typeof token !== "string") return null;
  const tokRow = await sbAdmin.selectOne(
    "external_api_keys",
    `token=eq.${token}&revoked_at=is.null`
  );
  if (!tokRow) return null;
  // Mise à jour last_used_at en best-effort (pas bloquant)
  sbAdmin.update("external_api_keys", `id=eq.${tokRow.id}`, { last_used_at: new Date().toISOString() })
    .catch(() => {});
  const company = await sbAdmin.selectOne("companies", `id=eq.${tokRow.company_id}`);
  return company;
}

// Génère/récupère un token actif pour cette company × source_app
async function ensureToken(companyId, sourceApp) {
  const existing = await sbAdmin.selectOne(
    "external_api_keys",
    `company_id=eq.${companyId}&source_app=eq.${sourceApp}&revoked_at=is.null`
  );
  if (existing) return existing;
  const token = generateApiToken();
  const inserted = await sbAdmin.insert("external_api_keys", {
    company_id: companyId, source_app: sourceApp, token, label: `${sourceApp} bridge`
  });
  return inserted && inserted[0] ? inserted[0] : { token };
}

// Crée un user dans auth.users via l'API admin Supabase
async function createAuthUser(email, password, metadata) {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const payload = {
    email,
    email_confirm: true,
    user_metadata: { ...metadata, created_via: "external_bridge" }
  };
  if (password && typeof password === "string" && password.length >= 6) {
    payload.password = password;
  }
  const r = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    console.error("[createAuthUser] failed", r.status, txt);
    return null;
  }
  const j = await r.json();
  return j?.id || j?.user?.id || null;
}

async function findUserByEmail(email) {
  // ⚠️ Important : l'API Supabase Admin /auth/v1/admin/users IGNORE le filtre
  // ?email=... dans certaines versions et retourne tous les users de la page.
  // On filtre donc TOUJOURS côté client par sécurité, et on pagine si besoin.
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const targetEmail = String(email || "").trim().toLowerCase();
  if (!targetEmail) return null;

  // On parcourt jusqu'à 20 pages de 100 users (= 2000 users max)
  // pour rester sous des temps de requête raisonnables.
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=100`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    if (!r.ok) {
      console.warn(`[findUserByEmail] page ${page} HTTP ${r.status}`);
      return null;
    }
    const j = await r.json();
    const users = Array.isArray(j?.users) ? j.users : [];
    if (users.length === 0) return null; // plus de pages

    // Filtre strict côté client
    const match = users.find(u => String(u.email || "").trim().toLowerCase() === targetEmail);
    if (match) return match.id;

    // Si on a reçu moins que per_page, c'est la dernière page
    if (users.length < 100) return null;
  }
  return null;
}

function generateApiToken() {
  const a = (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, "");
  const b = (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, "");
  return (a + b).slice(0, 64);
}

// ───────────────────────────────────────────────────────────────────────────
// HELPERS facture
// ───────────────────────────────────────────────────────────────────────────

// Upsert client IOBILL en se basant sur (siret prioritaire, sinon email)
async function upsertClient(companyId, cli) {
  const where = [];
  if (cli.siret) where.push(`siret=eq.${encodeURIComponent(cli.siret)}`);
  else if (cli.email) where.push(`email=eq.${encodeURIComponent(String(cli.email).toLowerCase())}`);

  if (where.length > 0) {
    const found = await sbAdmin.selectOne("clients", `company_id=eq.${companyId}&${where[0]}`);
    if (found) {
      // Update conservatif : on remplit les champs vides
      const patch = {};
      const fields = ["legal_name", "first_name", "last_name", "siret", "phone",
                      "address_line1", "address_line2", "postal_code", "city", "country"];
      for (const f of fields) {
        if (cli[f] && !found[f]) patch[f] = cli[f];
      }
      if (Object.keys(patch).length > 0) {
        await sbAdmin.update("clients", `id=eq.${found.id}`, patch);
      }
      return found.id;
    }
  }

  // Pas trouvé : créer
  const isCompany = !!(cli.legal_name || cli.siret);
  const payload = {
    company_id: companyId,
    client_type: isCompany ? "company" : "individual",
    legal_name: cli.legal_name || null,
    first_name: cli.first_name || null,
    last_name: cli.last_name || null,
    siret: cli.siret || null,
    email: cli.email ? String(cli.email).toLowerCase() : null,
    phone: cli.phone || null,
    address_line1: cli.address_line1 || null,
    address_line2: cli.address_line2 || null,
    postal_code: cli.postal_code || null,
    city: cli.city || null,
    country: cli.country || "FR"
  };
  const inserted = await sbAdmin.insert("clients", payload);
  return inserted && inserted[0] ? inserted[0].id : null;
}

// Calcule les totaux de facture à partir des lignes (cents)
function computeTotalsFromLines(lines, providedTotals) {
  const breakdown = {};
  let ht = 0, vat = 0, ttc = 0;
  for (const ln of lines) {
    const qty = Number(ln.quantity || 1);
    const up = Number(ln.unit_price_ht_cents || 0);
    const vatRate = Number(ln.vat_rate ?? 20);
    const discPct = Number(ln.discount_pct || 0);
    const lineHt = Math.round(qty * up * (1 - discPct / 100));
    const lineVat = Math.round(lineHt * vatRate / 100);
    ht += lineHt;
    vat += lineVat;
    ttc += lineHt + lineVat;
    const key = String(vatRate);
    if (!breakdown[key]) breakdown[key] = { rate: vatRate, base_cents: 0, vat_cents: 0 };
    breakdown[key].base_cents += lineHt;
    breakdown[key].vat_cents += lineVat;
  }
  const breakdownArr = Object.values(breakdown);

  return {
    subtotal_ht_cents: ht,
    vat_total_cents: vat,
    total_ttc_cents: ttc,
    paid_cents: providedTotals?.paid_cents != null ? Number(providedTotals.paid_cents) : 0,
    vat_breakdown: breakdownArr
  };
}

// Snapshot company à figer dans la facture
function buildCompanySnapshot(company) {
  return {
    legal_name: company.legal_name,
    trade_name: company.trade_name,
    siret: company.siret,
    vat_number: company.vat_number,
    address_line1: company.address_line1,
    address_line2: company.address_line2,
    postal_code: company.postal_code,
    city: company.city,
    country: company.country,
    email: company.email,
    phone: company.phone
  };
}

async function buildClientSnapshot(clientId, fallback) {
  let row = null;
  if (clientId) {
    row = await sbAdmin.selectOne("clients", `id=eq.${clientId}`);
  }
  const src = row || fallback || {};
  return {
    client_type: src.client_type || (src.legal_name || src.siret ? "company" : "individual"),
    legal_name: src.legal_name || null,
    first_name: src.first_name || null,
    last_name: src.last_name || null,
    siret: src.siret || null,
    email: src.email || null,
    phone: src.phone || null,
    address_line1: src.address_line1 || null,
    address_line2: src.address_line2 || null,
    postal_code: src.postal_code || null,
    city: src.city || null,
    country: src.country || "FR"
  };
}

// Notes auto pour le bas de facture (mentions véhicule + mentions légales)
function buildNotesFromMeta(invoice) {
  const v = invoice.vehicle_meta;
  const parts = [];
  if (v && typeof v === "object") {
    const veh = [];
    if (v.marque) veh.push(`Marque : ${v.marque}`);
    if (v.modele) veh.push(`Modèle : ${v.modele}`);
    if (v.plate) veh.push(`Immat. : ${v.plate}`);
    if (v.vin) veh.push(`VIN : ${v.vin}`);
    if (v.kilometrage) veh.push(`Kilométrage : ${Number(v.kilometrage).toLocaleString("fr-FR")} km`);
    if (v.annee) veh.push(`Année : ${v.annee}`);
    if (veh.length > 0) parts.push("🚗 VÉHICULE\n" + veh.join("\n"));
  }
  if (invoice.vat_regime === "margin_297a") {
    parts.push("TVA non applicable — Article 297A du CGI (régime de la marge)");
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}
