// ────────────────────────────────────────────────────────────────
// IO BILL — API /api/firm-invitation
// v8.26.1 — Hotfix : try/catch global + logs + import crypto fix
// ────────────────────────────────────────────────────────────────

import { randomBytes } from "crypto";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SR_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const APP_URL = process.env.APP_URL || "https://app.iobill.online";
const FROM_EMAIL = process.env.FROM_EMAIL || "noreply@iobill.online";

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  return res.end(JSON.stringify(body));
}

function authHeaders(extra = {}) {
  return {
    apikey: SR_KEY,
    Authorization: `Bearer ${SR_KEY}`,
    "Content-Type": "application/json",
    ...extra
  };
}

async function sbSelect(table, params) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), { headers: authHeaders() });
  if (!r.ok) {
    const txt = await r.text();
    console.warn(`[firm-invitation] sbSelect ${table} ${r.status}: ${txt}`);
    return null;
  }
  return await r.json();
}

async function sbInsert(table, data, prefer = "return=representation") {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: authHeaders({ Prefer: prefer }),
    body: JSON.stringify(data)
  });
  if (!r.ok) {
    const txt = await r.text();
    console.error(`[firm-invitation] sbInsert ${table} ${r.status}: ${txt}`);
    return null;
  }
  return await r.json();
}

async function sbUpdate(table, filter, data) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: authHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(data)
  });
  if (!r.ok) {
    const txt = await r.text();
    console.warn(`[firm-invitation] sbUpdate ${table} ${r.status}: ${txt}`);
    return null;
  }
  return await r.json();
}

async function getUserFromToken(token) {
  if (!token) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SR_KEY, Authorization: `Bearer ${token}` }
    });
    return r.ok ? await r.json() : null;
  } catch (e) {
    console.error("[firm-invitation] getUserFromToken:", e.message);
    return null;
  }
}

async function sendEmail({ to, subject, html }) {
  if (!RESEND_KEY) {
    console.warn("[firm-invitation] RESEND_API_KEY manquant");
    return false;
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html })
    });
    if (!r.ok) {
      console.error("[firm-invitation] Resend error:", await r.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error("[firm-invitation] sendEmail:", e.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Wrapper avec try/catch global
// ═══════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  try {
    return await handleRequest(req, res);
  } catch (e) {
    console.error("[firm-invitation] UNCAUGHT:", e?.stack || e?.message);
    return json(res, 500, {
      error: "Erreur serveur interne",
      details: e?.message || String(e)
    });
  }
}

async function handleRequest(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  // Parsing body safe
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const user = await getUserFromToken(token);
  if (!user) return json(res, 401, { error: "Non authentifié" });

  const { action, payload } = body;
  const p = payload || {};

  console.log(`[firm-invitation] action=${action} user=${user.email}`);

  // ═══════════════════════════════════════════════════════════════════
  // LOOKUP
  // ═══════════════════════════════════════════════════════════════════
  if (action === "lookup") {
    const { siret } = p;
    const result = { company: null, firm: null };
    if (siret) {
      const cleanSiret = String(siret).replace(/\s/g, "");
      const companies = await sbSelect("companies", {
        select: "id,legal_name,siret,user_id",
        siret: `eq.${cleanSiret}`,
        limit: 1
      });
      if (companies && companies.length > 0) result.company = companies[0];

      const firms = await sbSelect("accounting_firms", {
        select: "id,name,siret,email",
        siret: `eq.${cleanSiret}`,
        limit: 1
      });
      if (firms && firms.length > 0) result.firm = firms[0];
    }
    return json(res, 200, result);
  }

  // ═══════════════════════════════════════════════════════════════════
  // CREATE FROM FIRM
  // ═══════════════════════════════════════════════════════════════════
  if (action === "create_from_firm") {
    const { firm_id, siret, email, message } = p;
    if (!firm_id || !siret || !email) {
      return json(res, 400, { error: "firm_id, siret et email sont requis" });
    }

    // Vérifier membership cabinet
    const members = await sbSelect("firm_members", {
      firm_id: `eq.${firm_id}`,
      user_id: `eq.${user.id}`,
      select: "role"
    });
    if (!members || members.length === 0) {
      return json(res, 403, { error: "Vous n'êtes pas membre de ce cabinet" });
    }
    if (!["owner", "partner"].includes(members[0].role)) {
      return json(res, 403, { error: "Permissions insuffisantes (owner/partner requis)" });
    }

    const cleanSiret = String(siret).replace(/\s/g, "");
    const cleanEmail = String(email).trim().toLowerCase();

    // Chercher company
    let existingCompany = null;
    const companies = await sbSelect("companies", {
      select: "id,legal_name,user_id",
      siret: `eq.${cleanSiret}`,
      limit: 1
    });
    if (companies && companies.length > 0) existingCompany = companies[0];

    // Vérifier doublons (2 requêtes séparées au lieu de or: compliqué)
    if (existingCompany) {
      const existingByCompany = await sbSelect("firm_client_links", {
        firm_id: `eq.${firm_id}`,
        company_id: `eq.${existingCompany.id}`,
        status: "in.(pending,accepted)",
        limit: 1
      });
      if (existingByCompany && existingByCompany.length > 0) {
        return json(res, 409, { error: `Invitation existe déjà (${existingByCompany[0].status})` });
      }
    } else {
      const existingBySiret = await sbSelect("firm_client_links", {
        firm_id: `eq.${firm_id}`,
        invited_siret: `eq.${cleanSiret}`,
        status: "in.(pending,accepted)",
        limit: 1
      });
      if (existingBySiret && existingBySiret.length > 0) {
        return json(res, 409, { error: `Invitation existe déjà (${existingBySiret[0].status})` });
      }
    }

    const firms = await sbSelect("accounting_firms", { id: `eq.${firm_id}`, select: "name", limit: 1 });
    const firmName = firms?.[0]?.name || "Votre cabinet";

    const invitationToken = randomBytes(32).toString("hex");

    const link = await sbInsert("firm_client_links", {
      firm_id,
      company_id: existingCompany?.id || null,
      invited_email: cleanEmail,
      invited_siret: cleanSiret,
      invitation_token: invitationToken,
      initiated_by: "firm",
      status: "pending",
      message_invite: (message || "").slice(0, 500),
      invited_at: new Date().toISOString()
    });

    if (!link) return json(res, 500, { error: "Échec création invitation (DB)" });

    // Notification in-app si client déjà inscrit
    if (existingCompany?.user_id) {
      await sbInsert("notifications_firm", {
        user_id: existingCompany.user_id,
        company_id: existingCompany.id,
        firm_id,
        type: "invitation_firm_to_client",
        title: `Le cabinet ${firmName} souhaite gérer votre compte`,
        body: message || "Acceptez l'invitation depuis vos paramètres.",
        link: "/settings/firm-link",
        metadata: { firm_id, firm_name: firmName, link_id: link[0]?.id }
      });
    }

    // Email
    const acceptUrl = `${APP_URL}/firm-invitation?token=${invitationToken}`;
    await sendEmail({
      to: cleanEmail,
      subject: `${firmName} vous invite à connecter votre comptabilité`,
      html: `<div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
<h2 style="color: #d4a843;">🦉 IO BILL · Mode Comptable</h2>
<p>Bonjour,</p>
<p>Le cabinet comptable <strong>${firmName}</strong> souhaite gérer votre comptabilité via IO BILL.</p>
${message ? `<blockquote style="border-left: 3px solid #d4a843; padding-left: 12px; margin: 16px 0; color: #555;">${String(message).replace(/</g, "&lt;")}</blockquote>` : ""}
<p>En acceptant, vous autorisez ce cabinet à consulter vos factures et achats (lecture seule), signaler des anomalies et échanger avec vous via messagerie.</p>
<p style="text-align: center; margin: 28px 0;">
<a href="${acceptUrl}" style="background: #d4a843; color: #0b0c10; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600;">Voir l'invitation</a>
</p>
<p style="font-size: 12px; color: #888;">Vous pouvez accepter ou refuser à tout moment. Vos données restent privées tant que vous n'avez pas validé.</p>
<p style="font-size: 11px; color: #aaa;">— IO BILL · app.iobill.online</p>
</div>`
    });

    return json(res, 200, { ok: true, link: link[0], company_found: !!existingCompany });
  }

  // ═══════════════════════════════════════════════════════════════════
  // CREATE FROM CLIENT
  // ═══════════════════════════════════════════════════════════════════
  if (action === "create_from_client") {
    const { company_id, siret, email, message } = p;
    if (!company_id || !siret || !email) {
      return json(res, 400, { error: "company_id, siret et email sont requis" });
    }

    const companies = await sbSelect("companies", {
      id: `eq.${company_id}`,
      user_id: `eq.${user.id}`,
      select: "id,legal_name"
    });
    if (!companies || companies.length === 0) {
      return json(res, 403, { error: "Vous n'êtes pas propriétaire de cette company" });
    }

    const cleanSiret = String(siret).replace(/\s/g, "");
    const cleanEmail = String(email).trim().toLowerCase();

    const firms = await sbSelect("accounting_firms", {
      siret: `eq.${cleanSiret}`,
      select: "id,name,email",
      limit: 1
    });
    if (!firms || firms.length === 0) {
      return json(res, 404, { 
        error: "Aucun cabinet IO BILL trouvé avec ce SIRET. Le cabinet doit d'abord créer son compte sur IO BILL." 
      });
    }
    const existingFirm = firms[0];

    const existing = await sbSelect("firm_client_links", {
      firm_id: `eq.${existingFirm.id}`,
      company_id: `eq.${company_id}`,
      status: "in.(pending,accepted)",
      limit: 1
    });
    if (existing && existing.length > 0) {
      return json(res, 409, { error: `Invitation existe déjà (${existing[0].status})` });
    }

    const invitationToken = randomBytes(32).toString("hex");

    const link = await sbInsert("firm_client_links", {
      firm_id: existingFirm.id,
      company_id,
      invited_email: cleanEmail,
      invited_siret: cleanSiret,
      invitation_token: invitationToken,
      initiated_by: "client",
      status: "pending",
      message_invite: (message || "").slice(0, 500),
      invited_at: new Date().toISOString()
    });

    if (!link) return json(res, 500, { error: "Échec création invitation (DB)" });

    // Notifier owners/partners du cabinet
    const firmMembers = await sbSelect("firm_members", {
      firm_id: `eq.${existingFirm.id}`,
      role: "in.(owner,partner)",
      select: "user_id"
    });
    for (const m of (firmMembers || [])) {
      await sbInsert("notifications_firm", {
        user_id: m.user_id,
        firm_id: existingFirm.id,
        company_id,
        type: "invitation_client_to_firm",
        title: `${companies[0].legal_name} souhaite vous confier sa comptabilité`,
        body: message || "Un client souhaite vous rattacher comme cabinet comptable.",
        link: "/firm/clients",
        metadata: { firm_id: existingFirm.id, company_id, link_id: link[0]?.id }
      });
    }

    await sendEmail({
      to: existingFirm.email || cleanEmail,
      subject: `Nouvelle demande client : ${companies[0].legal_name}`,
      html: `<div style="font-family: -apple-system, sans-serif; max-width: 560px; margin: 0 auto; color: #1a1a1a;">
<h2 style="color: #d4a843;">🦉 IO BILL · Nouvelle demande client</h2>
<p>Bonjour,</p>
<p><strong>${companies[0].legal_name}</strong> (SIRET ${cleanSiret}) souhaite vous rattacher comme cabinet comptable sur IO BILL.</p>
${message ? `<blockquote style="border-left: 3px solid #d4a843; padding-left: 12px; margin: 16px 0; color: #555;">${String(message).replace(/</g, "&lt;")}</blockquote>` : ""}
<p style="text-align: center; margin: 28px 0;">
<a href="${APP_URL}/firm/clients" style="background: #d4a843; color: #0b0c10; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600;">Voir la demande</a>
</p>
<p style="font-size: 11px; color: #aaa;">— IO BILL · app.iobill.online</p>
</div>`
    });

    return json(res, 200, { ok: true, link: link[0] });
  }

  // ═══════════════════════════════════════════════════════════════════
  // ACCEPT
  // ═══════════════════════════════════════════════════════════════════
  if (action === "accept") {
    const { link_id } = p;
    if (!link_id) return json(res, 400, { error: "link_id requis" });

    const links = await sbSelect("firm_client_links", { id: `eq.${link_id}`, limit: 1 });
    if (!links || links.length === 0) return json(res, 404, { error: "Lien introuvable" });
    const link = links[0];

    let allowed = false;
    if (link.initiated_by === "firm") {
      if (link.company_id) {
        const c = await sbSelect("companies", {
          id: `eq.${link.company_id}`,
          user_id: `eq.${user.id}`,
          limit: 1
        });
        if (c && c.length > 0) allowed = true;
      }
      if (!allowed && link.invited_email && user.email === link.invited_email) allowed = true;
    } else {
      const members = await sbSelect("firm_members", {
        firm_id: `eq.${link.firm_id}`,
        user_id: `eq.${user.id}`,
        role: "in.(owner,partner)",
        limit: 1
      });
      if (members && members.length > 0) allowed = true;
    }
    if (!allowed) return json(res, 403, { error: "Non autorisé" });
    if (link.status !== "pending") return json(res, 400, { error: "Invitation déjà " + link.status });

    const updated = await sbUpdate("firm_client_links", `id=eq.${link_id}`, {
      status: "accepted",
      accepted_at: new Date().toISOString(),
      invitation_token: null
    });

    // Notifier l'autre partie
    if (link.initiated_by === "firm") {
      const fm = await sbSelect("firm_members", { firm_id: `eq.${link.firm_id}`, role: "in.(owner,partner)", select: "user_id" });
      const fs = await sbSelect("accounting_firms", { id: `eq.${link.firm_id}`, select: "name" });
      const cs = link.company_id ? await sbSelect("companies", { id: `eq.${link.company_id}`, select: "legal_name" }) : null;
      for (const m of (fm || [])) {
        await sbInsert("notifications_firm", {
          user_id: m.user_id,
          firm_id: link.firm_id,
          company_id: link.company_id,
          type: "invitation_accepted",
          title: `${cs?.[0]?.legal_name || link.invited_email} a accepté votre invitation`,
          body: "Vous pouvez maintenant consulter sa comptabilité.",
          link: `/firm/clients/${link_id}`
        });
      }
    } else {
      if (link.company_id) {
        const cs = await sbSelect("companies", { id: `eq.${link.company_id}`, select: "user_id" });
        const fs = await sbSelect("accounting_firms", { id: `eq.${link.firm_id}`, select: "name" });
        if (cs?.[0]?.user_id) {
          await sbInsert("notifications_firm", {
            user_id: cs[0].user_id,
            company_id: link.company_id,
            firm_id: link.firm_id,
            type: "invitation_accepted",
            title: `Le cabinet ${fs?.[0]?.name || ""} a accepté votre demande`,
            body: "Votre cabinet comptable est désormais lié à votre compte.",
            link: "/settings/firm-link"
          });
        }
      }
    }

    return json(res, 200, { ok: true, link: updated?.[0] });
  }

  // ═══════════════════════════════════════════════════════════════════
  // REFUSE
  // ═══════════════════════════════════════════════════════════════════
  if (action === "refuse") {
    const { link_id, reason } = p;
    if (!link_id) return json(res, 400, { error: "link_id requis" });

    const links = await sbSelect("firm_client_links", { id: `eq.${link_id}`, limit: 1 });
    if (!links || links.length === 0) return json(res, 404, { error: "Lien introuvable" });
    const link = links[0];

    let allowed = false;
    if (link.initiated_by === "firm") {
      if (link.company_id) {
        const c = await sbSelect("companies", { id: `eq.${link.company_id}`, user_id: `eq.${user.id}`, limit: 1 });
        if (c && c.length > 0) allowed = true;
      }
      if (!allowed && link.invited_email && user.email === link.invited_email) allowed = true;
    } else {
      const m = await sbSelect("firm_members", { firm_id: `eq.${link.firm_id}`, user_id: `eq.${user.id}`, limit: 1 });
      if (m && m.length > 0) allowed = true;
    }
    if (!allowed) return json(res, 403, { error: "Non autorisé" });
    if (link.status !== "pending") return json(res, 400, { error: "Invitation déjà " + link.status });

    await sbUpdate("firm_client_links", `id=eq.${link_id}`, {
      status: "refused",
      refused_at: new Date().toISOString(),
      invitation_token: null,
      message_invite: reason ? `[REFUS] ${reason}` : link.message_invite
    });

    return json(res, 200, { ok: true });
  }

  // ═══════════════════════════════════════════════════════════════════
  // REVOKE
  // ═══════════════════════════════════════════════════════════════════
  if (action === "revoke") {
    const { link_id } = p;
    if (!link_id) return json(res, 400, { error: "link_id requis" });

    const links = await sbSelect("firm_client_links", { id: `eq.${link_id}`, limit: 1 });
    if (!links || links.length === 0) return json(res, 404, { error: "Lien introuvable" });
    const link = links[0];

    let allowed = false;
    const m = await sbSelect("firm_members", {
      firm_id: `eq.${link.firm_id}`,
      user_id: `eq.${user.id}`,
      role: "in.(owner,partner)",
      limit: 1
    });
    if (m && m.length > 0) allowed = true;
    if (!allowed && link.company_id) {
      const c = await sbSelect("companies", { id: `eq.${link.company_id}`, user_id: `eq.${user.id}`, limit: 1 });
      if (c && c.length > 0) allowed = true;
    }
    if (!allowed) return json(res, 403, { error: "Non autorisé" });

    await sbUpdate("firm_client_links", `id=eq.${link_id}`, {
      status: "revoked",
      revoked_at: new Date().toISOString(),
      invitation_token: null
    });

    return json(res, 200, { ok: true });
  }

  return json(res, 400, { error: "Action inconnue : " + action });
}
