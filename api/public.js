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

// v8.47 : bodyParser désactivé pour pouvoir vérifier la signature HMAC
// du webhook PA sur les octets BRUTS. Les autres ops reçoivent un
// req.body réhydraté à l'identique juste en dessous.
export const config = { api: { bodyParser: false } };

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(req, res) {
  // Détermine l'opération
  const op = (req.query && req.query.op) || inferOp(req);

  // ─── WEBHOOK PLATEFORME AGRÉÉE (non authentifié, HMAC obligatoire) ───
  if (op === "pa_webhook") {
    if (req.method !== "POST") return json(res, 405, { error: "POST requis" });
    let raw = "";
    try { raw = await readRaw(req); } catch { return json(res, 400, { error: "body illisible" }); }
    let pa;
    try {
      pa = await import("./_lib/pa-actions.js");
    } catch (e) {
      console.error("[public] module PA indisponible", e?.stack || e?.message);
      return json(res, 503, { error: "Module PA indisponible" });
    }
    try {
      const companyId = req.query && req.query.company_id;
      const out = await pa.paWebhook(companyId, raw, req.headers);
      return json(res, out.status, out.body);
    } catch (e) {
      console.error("[public/pa_webhook]", e?.stack || e?.message);
      return json(res, 500, { error: "Erreur webhook" });
    }
  }

  // Réhydrate req.body pour les ops historiques (bodyParser désactivé).
  if (req.method === "POST" || req.method === "PATCH" || req.method === "PUT") {
    if (req.body === undefined) {
      try {
        const raw = await readRaw(req);
        req.body = raw ? JSON.parse(raw) : {};
      } catch { req.body = {}; }
    }
  }

  if (op === "share") return handleShare(req, res);
  if (op === "fetch") return handleFetch(req, res);
  if (op === "external") return handleExternal(req, res);
  return json(res, 400, { error: "Unknown op. Use ?op=share, ?op=fetch, ?op=external or ?op=pa_webhook" });
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

// v8.39 — Upload un logo base64 (depuis IOCAR par ex.) vers le bucket
// company-logos d'IOBILL. Retourne le path à stocker dans companies.logo_url.
//
// Accepte les data URLs : "data:image/png;base64,..." ou "data:image/jpeg;base64,..."
// ou simplement la chaîne base64 brute (png par défaut).
//
// Le path retourné est de la forme "external/{companyId}.{ext}".
async function uploadLogoFromBase64(companyId, base64Input) {
  if (!base64Input || typeof base64Input !== "string") return null;
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  // Parse data URL ou base64 brut
  let mime = "image/png";
  let b64 = base64Input;
  const dataMatch = base64Input.match(/^data:([^;]+);base64,(.+)$/);
  if (dataMatch) {
    mime = dataMatch[1];
    b64 = dataMatch[2];
  }

  // Garde-fou : taille raisonnable (max 2 MB en base64 ≈ 1.5 MB binaire)
  if (b64.length > 2_700_000) {
    console.warn("[uploadLogoFromBase64] logo trop volumineux:", b64.length);
    return null;
  }

  // Détecte l'extension depuis le MIME
  const ext = mime.includes("png") ? "png"
    : mime.includes("jpeg") || mime.includes("jpg") ? "jpg"
    : mime.includes("webp") ? "webp"
    : mime.includes("svg") ? "svg"
    : "png";

  // Décode base64 → Buffer
  const buffer = Buffer.from(b64, "base64");
  const path = `external/${companyId}.${ext}`;

  // Upload via Storage REST API (upsert pour remplacer si existe)
  const r = await fetch(`${url}/storage/v1/object/company-logos/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      apikey: key,
      "Content-Type": mime,
      "x-upsert": "true"
    },
    body: buffer
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    console.error("[uploadLogoFromBase64] FAIL", r.status, errText);
    return null;
  }

  return path;
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
  // v8.41 — Avoirs IOCAR → table credit_notes IOBILL (avec lien invoice_id parent)
  if (action === "push_credit_note") return handlePushCreditNote(body, res);
  // v8.43 — CRM mono-source : sync proactive depuis l'app source
  if (action === "sync_client") return handleSyncClient(body, res);
  if (action === "delete_client") return handleDeleteClient(body, res);
  // v8.45 — Polling périodique : sync TOUS les clients en un seul appel (batch)
  if (action === "sync_clients_batch") return handleSyncClientsBatch(body, res);
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
      // v8.49 — Assert : ensureToken DOIT retourner un token non vide.
      // Sans ce garde-fou, on renvoyait 200 avec token=undefined et IOCAR
      // écrivait un état partiel (company_id renseigné, token vide).
      if (!tokenRow || !tokenRow.token) {
        console.error("[external/link_account] ensureToken() n'a pas retourné de token pour company existante",
          { company_id: existing.id, source_app, tokenRow });
        return json(res, 500, {
          error: "Token API introuvable pour cette company",
          hint: "ensureToken a échoué — vérifier RLS/insert sur external_api_keys"
        });
      }
      // On sync les champs même si le compte existe déjà (idempotent + à jour)
      await applyCompanyUpdate(existing.id, companyFields, /*managed*/ true);
      console.log("[external/link_account] company existante réutilisée",
        { company_id: existing.id, source_app, external_ref, has_token: !!tokenRow.token });
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
      // v8.39 — NE PAS forcer vat_regime: "franchise" par défaut !
      // Sans valeur explicite, vat_regime reste NULL et le PDF n'affichera
      // PAS la mention "art 293 B" (qui s'applique uniquement à la franchise).
      // L'user IOBILL configurera son régime dans ses paramètres si besoin.
      //
      // v8.40 — Régression C : sub_status='active' par défaut pour les
      // ponts écosystème (IOCAR offre l'accès IOBILL aux garages abonnés,
      // donc pas de période d'essai ni de blocage "mode découverte").
      sub_status: "active",
      is_active: true
    });
    const newCompany = insertedRows && insertedRows[0];
    if (!newCompany) return json(res, 500, { error: "Échec création company IOBILL" });

    // 5) Token API
    const tokenRow = await ensureToken(newCompany.id, source_app);
    // v8.49 — Assert : sans token en base, on retourne 500 explicite
    // (pas 200 avec token undefined qui corrompait IOCAR).
    if (!tokenRow || !tokenRow.token) {
      console.error("[external/link_account] ensureToken() n'a pas retourné de token après création company",
        { company_id: newCompany.id, source_app, tokenRow });
      return json(res, 500, {
        error: "Company créée mais token API introuvable",
        company_id: newCompany.id, // pour permettre à IOCAR de logger et retry
        hint: "Ré-appelle link_account : le path 'existing' passera et rappellera ensureToken"
      });
    }
    console.log("[external/link_account] nouvelle company créée",
      { company_id: newCompany.id, user_id: userId, source_app, external_ref, has_token: !!tokenRow.token });

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
  let company = await resolveCompanyFromToken(body.token);
  if (!company) return json(res, 401, { error: "Invalid token" });

  // v8.39 — Auto-resync de la company si l'app source pousse des champs
  // (utile quand link_account initial avait des champs vides côté IOCAR
  // qui ont été remplis depuis). On ne remplace pas les valeurs existantes,
  // on remplit juste les champs vides.
  if (body.company_update && typeof body.company_update === "object") {
    const fields = buildCompanyFieldsFromBody(body.company_update);
    const fillEmpty = {};
    for (const [k, v] of Object.entries(fields)) {
      // Ne remplit que les champs vides/null côté IOBILL (respecte les
      // modifications éventuelles du user IOBILL).
      if (v != null && v !== "" && (company[k] == null || company[k] === "")) {
        fillEmpty[k] = v;
      }
      // Exception : on FORCE business_mentions à se resync car la source
      // de vérité c'est IOCAR (mentions configurées dans Paramètres > Mentions)
      if (k === "business_mentions" && v != null) {
        fillEmpty[k] = v;
      }
    }

    // v8.39 — Logo base64 : on upload vers le bucket et on remplit logo_url.
    // L'app source peut envoyer { logo_base64: "data:image/png;base64,..." }.
    // On upload UNIQUEMENT si le logo_url côté IOBILL est vide (pour ne pas
    // écraser un logo défini manuellement par l'user IOBILL).
    if (body.company_update.logo_base64 && !company.logo_url) {
      try {
        const newLogoUrl = await uploadLogoFromBase64(company.id, body.company_update.logo_base64);
        if (newLogoUrl) {
          fillEmpty.logo_url = newLogoUrl;
        }
      } catch (e) {
        console.warn("[push_invoice] logo upload failed:", e.message);
        // On continue sans bloquer la facture
      }
    }

    if (Object.keys(fillEmpty).length > 0) {
      await applyCompanyUpdate(company.id, fillEmpty, /*managed*/ true);
      // Recharge la company pour les snapshots à venir
      company = await resolveCompanyFromToken(body.token);
    }
  }

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
    const clientId = await upsertClient(company.id, invoice.client || {}, { sourceApp: company.source_app });

    // 2) Idempotence : existe déjà ?
    const existing = await sbAdmin.selectOne(
      "invoices",
      `external_source=eq.${company.source_app}&external_id=eq.${encodeURIComponent(externalId)}`
    );

    // 3) Build payload invoice
    // v8.39 — Passe les débours pour calculer le grand_total (lines + débours)
    const totals = computeTotalsFromLines(invoice.lines, invoice.totals, invoice.debours);
    const companySnapshot = buildCompanySnapshot(company) || {};
    const clientSnapshot = (await buildClientSnapshot(clientId, invoice.client || {})) || {};

    // v8.37 — Cohérence forcée : si status=paid, paid_cents == grand_total (lines + débours).
    // Évite tout désalignement entre le statut et les totaux.
    const requestedStatus = invoice.status || "issued";
    const isPaidStatus = requestedStatus === "paid";
    const paidCents = isPaidStatus
      ? (totals.grand_total_cents || totals.total_ttc_cents)
      : totals.paid_cents;

    // v8.38 — Mode métier : auto-déduit depuis source_app
    // (futur : on pourra passer body.business_mode pour override explicite)
    const businessMode = invoice.business_mode
      || (company.source_app === "iocar" ? "garage"
        : company.source_app === "iobtp" ? "btp"
        : company.source_app === "ioinstitute" ? "institute"
        : "standard");

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
      notes: invoice.notes || (businessMode === "standard" ? buildNotesFromMeta(invoice) : null),
      terms: invoice.terms || null,
      external_source: company.source_app,
      external_id: String(externalId),
      // v8.38 — Mode métier + métadonnées véhicule (mode garage)
      business_mode: businessMode,
      vehicle_meta: invoice.vehicle_meta || null,
      business_mentions: invoice.business_mentions || null,
      // v8.39 — Débours (CG, malus...) hors base TVA mais à payer par le client
      debours: invoice.debours || null,
      // v8.39 — Régime TVA spécifique à cette facture (par véhicule)
      vat_regime: invoice.vat_regime || null,
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
      // v8.37 — Fallback idempotence : si l'insert a échoué (probablement
      // pour cause de violation UNIQUE company_id+number ou external_*),
      // on tente de retrouver l'invoice existante et on l'update à la place.
      if (!invoiceRow) {
        console.warn("[push_invoice] insert échoué, tentative de récupération existante", { number: invoice.number, external_id: externalId });
        // Cherche par (external_source, external_id) - cas 1 : duplicate idempotence
        let foundExisting = await sbAdmin.selectOne(
          "invoices",
          `external_source=eq.${company.source_app}&external_id=eq.${encodeURIComponent(externalId)}&company_id=eq.${company.id}`
        );
        // Sinon cherche par number (cas 2 : numéro déjà utilisé manuellement avant le pont)
        if (!foundExisting) {
          foundExisting = await sbAdmin.selectOne(
            "invoices",
            `number=eq.${encodeURIComponent(invoice.number)}&company_id=eq.${company.id}`
          );
        }
        if (foundExisting) {
          console.log("[push_invoice] récupération invoice existante:", foundExisting.id);
          const reUpdated = await sbAdmin.update("invoices", `id=eq.${foundExisting.id}`, invoicePayload);
          invoiceRow = reUpdated && reUpdated[0];
          await sbAdmin.delete("document_lines", `document_type=eq.invoice&document_id=eq.${foundExisting.id}`);
          await sbAdmin.delete("payments", `invoice_id=eq.${foundExisting.id}`);
        }
      }
    }
    if (!invoiceRow) {
      return json(res, 500, {
        error: "Échec écriture invoice",
        hint: "Voir les logs Vercel IOBILL pour le détail (probablement contrainte UNIQUE company_id+number ou RLS bloquée).",
        last_error: sbAdmin._lastError || null
      });
    }

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
// v8.41 — Generalisé pour invoice ou credit_note
function triggerFacturxGeneration(documentId, documentType = "invoice") {
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
          document_type: documentType,
          document_id: documentId
        })
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        console.warn(`[triggerFacturxGen] failed status=${r.status}: ${txt}`);
      } else {
        console.log(`[triggerFacturxGen] OK ${documentType}=${documentId}`);
      }
    } catch (e) {
      console.warn("[triggerFacturxGen] error:", e.message);
    }
  });
}

// ───────────────────────────────────────────────────────────────────────────
// v8.41 — PUSH_CREDIT_NOTE — Pousse un avoir externe vers la table credit_notes
//
// Body :
//   action: "push_credit_note"
//   token : token API IOBILL
//   credit_note: {
//     external_id, number, issue_date, status,
//     source_invoice_number,  // ← lookup invoice parent par (external_source, number)
//     reason, client, lines
//   }
//   company_update: { ... }  // optionnel, même format que push_invoice
//
// Workflow :
//   1. Resolve company depuis token
//   2. Sync company (mêmes règles que push_invoice)
//   3. Lookup invoice source via (company_id, number = source_invoice_number)
//      → si pas trouvée : erreur 400 (l'utilisateur doit d'abord pousser la facture source)
//   4. Upsert client_id (mêmes règles)
//   5. Upsert credit_notes (idempotent via external_source + external_id)
//   6. Insert document_lines (document_type='credit_note')
//   7. Trigger anti-dépassement vérifie automatiquement
//   8. triggerFacturxGeneration(creditNoteId, 'credit_note') en fire-and-forget
//   9. Retourne credit_note_id, credit_note_number, pdf_url (null en attente)
// ───────────────────────────────────────────────────────────────────────────
async function handlePushCreditNote(body, res) {
  let company = await resolveCompanyFromToken(body.token);
  if (!company) return json(res, 401, { error: "Invalid token" });

  // Sync company depuis l'app source (logique identique à push_invoice)
  if (body.company_update && typeof body.company_update === "object") {
    const fields = buildCompanyFieldsFromBody(body.company_update);
    const fillEmpty = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v != null && v !== "" && (company[k] == null || company[k] === "")) {
        fillEmpty[k] = v;
      }
      if (k === "business_mentions" && v != null) {
        fillEmpty[k] = v;
      }
    }
    if (body.company_update.logo_base64 && !company.logo_url) {
      try {
        const newLogoUrl = await uploadLogoFromBase64(company.id, body.company_update.logo_base64);
        if (newLogoUrl) fillEmpty.logo_url = newLogoUrl;
      } catch (e) {
        console.warn("[push_credit_note] logo upload failed:", e.message);
      }
    }
    if (Object.keys(fillEmpty).length > 0) {
      await applyCompanyUpdate(company.id, fillEmpty, true);
      company = await resolveCompanyFromToken(body.token);
    }
  }

  const { credit_note } = body;
  if (!credit_note || typeof credit_note !== "object") {
    return json(res, 400, { error: "credit_note required" });
  }
  const externalId = credit_note.external_id;
  if (!externalId) return json(res, 400, { error: "credit_note.external_id required" });
  if (!credit_note.number) return json(res, 400, { error: "credit_note.number required" });
  if (!credit_note.source_invoice_number) {
    return json(res, 400, { error: "credit_note.source_invoice_number required (numéro de la facture d'origine)" });
  }
  if (!Array.isArray(credit_note.lines) || credit_note.lines.length === 0) {
    return json(res, 400, { error: "credit_note.lines (non vide) required" });
  }

  try {
    // 1) Lookup invoice source par (company_id, number)
    const sourceInvoice = await sbAdmin.selectOne(
      "invoices",
      `company_id=eq.${company.id}&number=eq.${encodeURIComponent(credit_note.source_invoice_number)}`
    );
    if (!sourceInvoice) {
      return json(res, 400, {
        error: `Facture d'origine "${credit_note.source_invoice_number}" introuvable côté IOBILL. ` +
               `Assurez-vous qu'elle ait été transmise et finalisée avant de pousser l'avoir.`,
        code: 'SOURCE_INVOICE_NOT_FOUND'
      });
    }

    // 2) Client (upsert)
    const clientId = await upsertClient(company.id, credit_note.client || {}, { sourceApp: company.source_app });

    // 3) Idempotence : credit_note déjà existant pour (external_source, external_id) ?
    const existing = await sbAdmin.selectOne(
      "credit_notes",
      `company_id=eq.${company.id}&number=eq.${encodeURIComponent(credit_note.number)}`
    );

    // 4) Totaux
    const totals = computeTotalsFromLines(credit_note.lines, null, null);
    const companySnapshot = buildCompanySnapshot(company) || {};
    const clientSnapshot = (await buildClientSnapshot(clientId, credit_note.client || {})) || {};

    const creditNotePayload = {
      company_id: company.id,
      invoice_id: sourceInvoice.id,
      client_id: clientId,
      number: credit_note.number,
      client_snapshot: clientSnapshot,
      company_snapshot: companySnapshot,
      issue_date: credit_note.issue_date || new Date().toISOString().slice(0, 10),
      reason: credit_note.reason || null,
      status: credit_note.status || 'issued',
      subtotal_ht_cents: totals.subtotal_ht_cents,
      vat_total_cents: totals.vat_total_cents,
      total_ttc_cents: totals.total_ttc_cents,
      vat_breakdown: totals.vat_breakdown,
      notes: credit_note.notes || null
    };

    let creditNoteRow;
    if (existing) {
      const updated = await sbAdmin.update(
        "credit_notes",
        `id=eq.${existing.id}`,
        creditNotePayload
      );
      creditNoteRow = updated && updated[0];
      // Supprimer anciennes lignes pour les recréer
      await sbAdmin.delete("document_lines", `document_type=eq.credit_note&document_id=eq.${existing.id}`);
    } else {
      const inserted = await sbAdmin.insert("credit_notes", creditNotePayload);
      creditNoteRow = inserted && inserted[0];
    }

    if (!creditNoteRow) {
      return json(res, 500, { error: "Échec création credit_note" });
    }

    // 5) Lignes
    const linesPayload = credit_note.lines.map((l, idx) => ({
      document_type: 'credit_note',
      document_id: creditNoteRow.id,
      position: idx + 1,
      description: l.description || '',
      quantity: l.quantity || 1,
      unit: l.unit || 'u',
      unit_price_ht_cents: l.unit_price_ht_cents || 0,
      vat_rate: l.vat_rate || 0,
      discount_pct: l.discount_pct || 0,
      line_ht_cents: l.line_ht_cents != null
        ? l.line_ht_cents
        : Math.round((l.quantity || 1) * (l.unit_price_ht_cents || 0) * (1 - (l.discount_pct || 0) / 100))
    }));
    await sbAdmin.insert("document_lines", linesPayload);

    // 6) Génération PDF Factur-X en arrière-plan
    triggerFacturxGeneration(creditNoteRow.id, 'credit_note');

    return json(res, 200, {
      ok: true,
      credit_note_id: creditNoteRow.id,
      credit_note_number: creditNoteRow.number,
      invoice_id: sourceInvoice.id,
      invoice_number: sourceInvoice.number,
      pdf_url: null, // sera rempli après génération Factur-X
      status: creditNoteRow.status, // v8.41 — signal pour IOCAR (draft / issued)
      facturx_status: 'pending'
    });
  } catch (err) {
    console.error("[external/push_credit_note] ERROR:", err);
    return json(res, 500, { error: String(err.message || err) });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// v8.43 — SYNC_CLIENT — Pousse un client de l'app source vers IOBILL
//
// Body :
//   action: "sync_client"
//   token : token API IOBILL
//   client: {
//     external_id (requis),      // id stable côté app source (IOCAR clients.id)
//     legal_name, first_name, last_name, siret, email, phone,
//     address_line1, address_line2, postal_code, city, country
//   }
//
// Comportement :
//   - Lookup par (company_id, external_source, external_id)
//   - Si trouvé → update non-conservatif (source maîtresse)
//   - Sinon → insert avec external_managed=true (verrouille la lecture seule UI)
// ───────────────────────────────────────────────────────────────────────────
async function handleSyncClient(body, res) {
  const company = await resolveCompanyFromToken(body.token);
  if (!company) return json(res, 401, { error: "Invalid token" });

  const { client } = body;
  if (!client || typeof client !== "object") {
    return json(res, 400, { error: "client required" });
  }
  if (!client.external_id) {
    return json(res, 400, { error: "client.external_id required (id stable côté app source)" });
  }

  try {
    const clientId = await upsertClient(company.id, client, { sourceApp: company.source_app });
    if (!clientId) {
      return json(res, 500, { error: "Échec upsert client" });
    }
    return json(res, 200, {
      ok: true,
      client_id: clientId,
      external_managed: true
    });
  } catch (err) {
    console.error("[external/sync_client] ERROR:", err);
    return json(res, 500, { error: String(err.message || err) });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// v8.43 — DELETE_CLIENT — Supprime un client externe (cas suppression côté IOCAR)
//
// Body :
//   action: "delete_client"
//   token : token API IOBILL
//   external_id : id du client dans l'app source
//
// Comportement :
//   - Si le client a des factures liées → on archive (soft delete via colonne
//     archived_at) au lieu de supprimer (sinon RLS / FK refuserait)
//   - Si pas de factures → DELETE
// ───────────────────────────────────────────────────────────────────────────
async function handleDeleteClient(body, res) {
  const company = await resolveCompanyFromToken(body.token);
  if (!company) return json(res, 401, { error: "Invalid token" });

  if (!body.external_id) {
    return json(res, 400, { error: "external_id required" });
  }

  try {
    const found = await sbAdmin.selectOne(
      "clients",
      `company_id=eq.${company.id}&external_source=eq.${company.source_app}&external_id=eq.${encodeURIComponent(body.external_id)}`
    );
    if (!found) {
      return json(res, 200, { ok: true, not_found: true });
    }

    // Vérifier s'il y a des factures liées (FK : invoices.client_id)
    const linkedInvoices = await sbAdmin.selectOne(
      "invoices",
      `client_id=eq.${found.id}`
    );

    if (linkedInvoices) {
      // Soft delete : on ne touche pas physiquement (factures gardent le snapshot)
      // On marque juste external_managed=false pour permettre à l'user IOBILL de
      // décider quoi en faire (ex: l'archiver depuis l'UI).
      await sbAdmin.update("clients", `id=eq.${found.id}`, {
        external_managed: false,
        external_synced_at: new Date().toISOString()
      });
      return json(res, 200, {
        ok: true,
        soft_deleted: true,
        message: "Client conservé (factures liées) mais déverrouillé côté IOBILL"
      });
    }

    // Pas de factures liées → hard delete
    await sbAdmin.delete("clients", `id=eq.${found.id}`);
    return json(res, 200, { ok: true, hard_deleted: true });
  } catch (err) {
    console.error("[external/delete_client] ERROR:", err);
    return json(res, 500, { error: String(err.message || err) });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// v8.45 — SYNC_CLIENTS_BATCH — Sync miroir TOUS les clients en 1 appel
//
// Body :
//   action: "sync_clients_batch"
//   token : token API IOBILL
//   clients: [
//     { external_id, legal_name, first_name, last_name, siret, email, phone,
//       address_line1, postal_code, city, country },
//     ...
//   ]
//   hash: string (optionnel) — si fourni et identique au dernier sync, on skip
//
// Comportement :
//   1. Upsert chaque client (matching external_id en priorité)
//   2. Identifie les clients IOBILL external_managed=true dont l'external_id
//      n'est PLUS dans la liste → ils ont été supprimés côté IOCAR
//       - si pas de factures liées : DELETE
//       - si factures liées : déverrouille (external_managed=false)
//   3. Retourne { synced, removed, total }
// ───────────────────────────────────────────────────────────────────────────
async function handleSyncClientsBatch(body, res) {
  const company = await resolveCompanyFromToken(body.token);
  if (!company) return json(res, 401, { error: "Invalid token" });

  const clients = Array.isArray(body.clients) ? body.clients : [];
  const sourceApp = company.source_app;
  if (!sourceApp) {
    return json(res, 400, { error: "company.source_app missing (token mal configuré)" });
  }

  try {
    // 1. Upsert chaque client
    const seenExternalIds = new Set();
    let syncedCount = 0;
    let errorCount = 0;

    for (const cli of clients) {
      if (!cli.external_id) continue;
      seenExternalIds.add(String(cli.external_id));
      try {
        await upsertClient(company.id, cli, { sourceApp });
        syncedCount++;
      } catch (e) {
        errorCount++;
        console.error("[batch upsert] error for", cli.external_id, e.message);
      }
    }

    // 2. Détecter les clients qui étaient external_managed mais ne sont plus dans la liste
    // (= supprimés côté IOCAR)
    const externalClientsInIobill = await sbAdmin.select(
      "clients",
      {
        filter: `company_id=eq.${company.id}&external_source=eq.${sourceApp}&external_managed=eq.true`,
        select: "id,external_id"
      }
    );

    let removedCount = 0;
    let unlockedCount = 0;
    for (const cli of (externalClientsInIobill || [])) {
      if (!cli.external_id) continue;
      if (seenExternalIds.has(String(cli.external_id))) continue;
      // Ce client n'est plus côté IOCAR
      const hasInvoices = await sbAdmin.selectOne("invoices", `client_id=eq.${cli.id}`);
      const hasCreditNotes = await sbAdmin.selectOne("credit_notes", `client_id=eq.${cli.id}`);
      if (hasInvoices || hasCreditNotes) {
        // Soft delete : on déverrouille
        await sbAdmin.update("clients", `id=eq.${cli.id}`, {
          external_managed: false,
          external_synced_at: new Date().toISOString()
        });
        unlockedCount++;
      } else {
        await sbAdmin.delete("clients", `id=eq.${cli.id}`);
        removedCount++;
      }
    }

    return json(res, 200, {
      ok: true,
      received: clients.length,
      synced: syncedCount,
      errors: errorCount,
      removed: removedCount,
      unlocked: unlockedCount
    });
  } catch (err) {
    console.error("[external/sync_clients_batch] ERROR:", err);
    return json(res, 500, { error: String(err.message || err) });
  }
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
  // v8.38 — Mentions métier réutilisables (mode garage : garantie, conditions, cession)
  if (body.business_mentions !== undefined) out.business_mentions = body.business_mentions;
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
  if (!company) return null;
  // v8.43 — FIX : enrichir company avec source_app (vient de external_api_keys, pas de companies).
  // Sans ça, tous les filtres `external_source=eq.${company.source_app}` matchaient sur "undefined"
  // → cause racine des doublons clients côté IOBILL.
  company.source_app = tokRow.source_app;
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
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(`${url}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (Array.isArray(j?.users) && j.users.length > 0) return j.users[0].id;
  if (j?.id && j?.email === email) return j.id;
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
// v8.43 — Upsert client avec priorité au matching par (external_source, external_id).
// Si l'app source pousse un external_id, on s'en sert comme clé primaire pour
// éviter les doublons. Sinon fallback par SIRET / email comme avant.
// Update non-conservatif quand external : la source IOCAR est maîtresse.
async function upsertClient(companyId, cli, opts = {}) {
  const { sourceApp = null } = opts;
  const hasExternal = !!(sourceApp && cli.external_id);

  // 1) Matching par external_id (prioritaire et fiable)
  if (hasExternal) {
    const foundExt = await sbAdmin.selectOne(
      "clients",
      `company_id=eq.${companyId}&external_source=eq.${sourceApp}&external_id=eq.${encodeURIComponent(cli.external_id)}`
    );
    if (foundExt) {
      // Update non-conservatif : la source écrase systématiquement (IOCAR maître)
      const patch = buildClientPatch(cli, /*overwrite*/ true);
      patch.external_synced_at = new Date().toISOString();
      patch.external_managed = true;
      patch.external_source = sourceApp;
      patch.external_id = String(cli.external_id);
      await sbAdmin.update("clients", `id=eq.${foundExt.id}`, patch);
      return foundExt.id;
    }
  }

  // 2) Fallback : matching par SIRET puis email (legacy, pour les anciens flux)
  let found = null;
  if (cli.siret) {
    found = await sbAdmin.selectOne(
      "clients",
      `company_id=eq.${companyId}&siret=eq.${encodeURIComponent(cli.siret)}`
    );
  }
  if (!found && cli.email) {
    found = await sbAdmin.selectOne(
      "clients",
      `company_id=eq.${companyId}&email=eq.${encodeURIComponent(String(cli.email).toLowerCase())}`
    );
  }

  if (found) {
    // Si on est dans le flux external mais qu'on retrouve un client legacy
    // sans external_id, on l'enrôle (= on lui attribue l'external_id pour le matching futur)
    const patch = buildClientPatch(cli, /*overwrite*/ hasExternal);
    if (hasExternal) {
      patch.external_synced_at = new Date().toISOString();
      patch.external_managed = true;
      patch.external_source = sourceApp;
      patch.external_id = String(cli.external_id);
    }
    if (Object.keys(patch).length > 0) {
      await sbAdmin.update("clients", `id=eq.${found.id}`, patch);
    }
    return found.id;
  }

  // 3) Pas trouvé : créer
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
  if (hasExternal) {
    payload.external_source = sourceApp;
    payload.external_id = String(cli.external_id);
    payload.external_synced_at = new Date().toISOString();
    payload.external_managed = true;
  }
  const inserted = await sbAdmin.insert("clients", payload);
  return inserted && inserted[0] ? inserted[0].id : null;
}

// Helper : construit l'objet patch pour update.
// overwrite=true → écrase tous les champs non-null fournis (source maîtresse)
// overwrite=false → ne remplit que les champs vides (conservatif, legacy)
function buildClientPatch(cli, overwrite) {
  const patch = {};
  const fields = ["legal_name", "first_name", "last_name", "siret", "email", "phone",
                  "address_line1", "address_line2", "postal_code", "city", "country"];
  for (const f of fields) {
    if (cli[f] != null && cli[f] !== "") {
      if (overwrite) {
        patch[f] = f === "email" ? String(cli[f]).toLowerCase() : cli[f];
      }
      // En mode conservatif on devrait checker !found[f] mais on n'a pas found ici
      // → ce helper n'est utilisé qu'en mode external (overwrite=true)
    }
  }
  return patch;
}

// Calcule les totaux de facture à partir des lignes (cents)
// v8.39 — Accepte un 3e paramètre `debours` (array) qui s'ajoute au TTC
// sans entrer dans la base TVA (cf art. 267 II 2° CGI).
function computeTotalsFromLines(lines, providedTotals, debours) {
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

  // v8.39 — Ajoute les débours au total TTC final (à payer)
  // sans toucher à ht ni vat ni breakdown (ils restent hors base TVA).
  let debourCents = 0;
  if (Array.isArray(debours)) {
    for (const d of debours) {
      debourCents += Math.abs(Number(d.amount_cents || 0));
    }
  }
  const totalAvecDebours = ttc + debourCents;

  return {
    subtotal_ht_cents: ht,
    vat_total_cents: vat,
    // total_ttc_cents = lignes uniquement (sans débours) — base TVA pure
    total_ttc_cents: ttc,
    // v8.39 — Champs débours pour reflet client + comptable
    debour_total_cents: debourCents,
    grand_total_cents: totalAvecDebours,
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
