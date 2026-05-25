// ────────────────────────────────────────────────────────────────
// IO BILL — API /api/firm-invitation
// v8.30 — + action attachment_signed_url (URL signée PJ messagerie)
// v8.29 — + action pdf_refresh_url (régénère URL signée Storage)
// v8.28 — Messagerie cabinet/abonné (thread_create, message_send,
//         message_mark_read, thread_close, thread_reopen, thread_archive)
//         + Sprint 3 (signalements) + Sprint 2 (invitations/links)
//         + Hotfix v8.26.1 : try/catch global, logs, import crypto fix
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

  // ═══════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════
  // ACTIONS SIGNALEMENTS (Sprint 3 v8.27)
  // ═══════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════

  const VALID_TARGETS = ['invoice', 'quote', 'credit_note', 'purchase', 'client', 'general'];
  const VALID_SEVERITIES = ['info', 'warning', 'critical'];

  // ─────────────────────────────────────────────────────────────────
  // SIGNAL_CREATE : cabinet crée un signalement
  // ─────────────────────────────────────────────────────────────────
  if (action === "signal_create") {
    const { firm_id, company_id, target_type, target_id, severity, title, content, visible_to_client, blocks_emission } = p;
    if (!firm_id || !company_id || !target_type || !title) {
      return json(res, 400, { error: "firm_id, company_id, target_type, title requis" });
    }
    if (!VALID_TARGETS.includes(target_type)) {
      return json(res, 400, { error: "target_type invalide" });
    }
    const sev = VALID_SEVERITIES.includes(severity) ? severity : 'warning';

    const sigMembers = await sbSelect("firm_members", {
      firm_id: `eq.${firm_id}`,
      user_id: `eq.${user.id}`,
      role: "in.(owner,partner,staff)",
      select: "role"
    });
    if (!sigMembers || sigMembers.length === 0) {
      return json(res, 403, { error: "Non autorisé (firm_member requis)" });
    }

    const sigLinks = await sbSelect("firm_client_links", {
      firm_id: `eq.${firm_id}`,
      company_id: `eq.${company_id}`,
      status: "eq.accepted",
      select: "id",
      limit: 1
    });
    if (!sigLinks || sigLinks.length === 0) {
      return json(res, 403, { error: "Cabinet non lié à cette company (status accepted requis)" });
    }

    const signal = await sbInsert("firm_signals", {
      firm_id,
      company_id,
      author_id: user.id,
      target_type,
      target_id: target_id || null,
      severity: sev,
      title: String(title).slice(0, 200),
      content: String(content || "").slice(0, 2000),
      status: 'open',
      visible_to_client: visible_to_client !== false,
      blocks_emission: !!blocks_emission
    });

    if (!signal) return json(res, 500, { error: "Échec création signalement" });

    if (visible_to_client !== false) {
      const sigCompanies = await sbSelect("companies", { id: `eq.${company_id}`, select: "user_id,legal_name" });
      const sigFirms = await sbSelect("accounting_firms", { id: `eq.${firm_id}`, select: "name" });
      if (sigCompanies?.[0]?.user_id) {
        const sevEmoji = { info: "🟦", warning: "🟧", critical: "🟥" }[sev] || "🟧";
        await sbInsert("notifications_firm", {
          user_id: sigCompanies[0].user_id,
          firm_id,
          company_id,
          type: "signal_new",
          title: `${sevEmoji} ${sigFirms?.[0]?.name || "Votre cabinet"} a signalé : ${String(title).slice(0, 80)}`,
          body: String(content || "").slice(0, 200),
          link: `/signals/${signal[0].id}`,
          metadata: { signal_id: signal[0].id, severity: sev, target_type, target_id }
        });
      }
    }

    return json(res, 200, { ok: true, signal: signal[0] });
  }

  // ─────────────────────────────────────────────────────────────────
  // SIGNAL_RESOLVE : marquer comme résolu (cabinet ou client)
  // ─────────────────────────────────────────────────────────────────
  if (action === "signal_resolve") {
    const { signal_id, comment } = p;
    if (!signal_id) return json(res, 400, { error: "signal_id requis" });

    const sigs = await sbSelect("firm_signals", { id: `eq.${signal_id}`, limit: 1 });
    if (!sigs || sigs.length === 0) return json(res, 404, { error: "Signal introuvable" });
    const signal = sigs[0];

    let allowed = false;
    let isCabinetAction = false;
    const fm = await sbSelect("firm_members", { firm_id: `eq.${signal.firm_id}`, user_id: `eq.${user.id}`, limit: 1 });
    if (fm && fm.length > 0) { allowed = true; isCabinetAction = true; }
    if (!allowed) {
      const c = await sbSelect("companies", { id: `eq.${signal.company_id}`, user_id: `eq.${user.id}`, limit: 1 });
      if (c && c.length > 0) allowed = true;
    }
    if (!allowed) return json(res, 403, { error: "Non autorisé" });

    const updated = await sbUpdate("firm_signals", `id=eq.${signal_id}`, {
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      ...(comment ? { client_response: String(comment).slice(0, 2000) } : {})
    });

    // Notifier l'autre partie
    if (isCabinetAction) {
      const c = await sbSelect("companies", { id: `eq.${signal.company_id}`, select: "user_id" });
      if (c?.[0]?.user_id) {
        await sbInsert("notifications_firm", {
          user_id: c[0].user_id,
          firm_id: signal.firm_id,
          company_id: signal.company_id,
          type: "signal_resolved",
          title: "✅ Signalement résolu",
          body: signal.title,
          metadata: { signal_id }
        });
      }
    } else {
      const fms = await sbSelect("firm_members", { firm_id: `eq.${signal.firm_id}`, select: "user_id" });
      for (const m of (fms || [])) {
        await sbInsert("notifications_firm", {
          user_id: m.user_id,
          firm_id: signal.firm_id,
          company_id: signal.company_id,
          type: "signal_resolved_by_client",
          title: "✅ Le client a résolu un signalement",
          body: signal.title + (comment ? ` — Réponse : ${String(comment).slice(0, 100)}` : ""),
          link: `/firm/clients`,
          metadata: { signal_id }
        });
      }
    }

    return json(res, 200, { ok: true, signal: updated?.[0] });
  }

  // ─────────────────────────────────────────────────────────────────
  // SIGNAL_DISMISS : classer sans suite (cabinet only)
  // ─────────────────────────────────────────────────────────────────
  if (action === "signal_dismiss") {
    const { signal_id, reason } = p;
    if (!signal_id) return json(res, 400, { error: "signal_id requis" });

    const sigs = await sbSelect("firm_signals", { id: `eq.${signal_id}`, limit: 1 });
    if (!sigs || sigs.length === 0) return json(res, 404, { error: "Signal introuvable" });
    const signal = sigs[0];

    const fm = await sbSelect("firm_members", {
      firm_id: `eq.${signal.firm_id}`,
      user_id: `eq.${user.id}`,
      role: "in.(owner,partner)",
      limit: 1
    });
    if (!fm || fm.length === 0) return json(res, 403, { error: "Non autorisé (owner/partner cabinet requis)" });

    const updated = await sbUpdate("firm_signals", `id=eq.${signal_id}`, {
      status: 'dismissed',
      resolved_at: new Date().toISOString(),
      ...(reason ? { content: signal.content + `\n\n[CLASSÉ SANS SUITE] ${reason}` } : {})
    });

    return json(res, 200, { ok: true, signal: updated?.[0] });
  }

  // ─────────────────────────────────────────────────────────────────
  // SIGNAL_RESPOND : client répond au signalement
  // ─────────────────────────────────────────────────────────────────
  if (action === "signal_respond") {
    const { signal_id, response } = p;
    if (!signal_id || !response) return json(res, 400, { error: "signal_id et response requis" });

    const sigs = await sbSelect("firm_signals", { id: `eq.${signal_id}`, limit: 1 });
    if (!sigs || sigs.length === 0) return json(res, 404, { error: "Signal introuvable" });
    const signal = sigs[0];

    const c = await sbSelect("companies", { id: `eq.${signal.company_id}`, user_id: `eq.${user.id}`, limit: 1 });
    if (!c || c.length === 0) return json(res, 403, { error: "Non autorisé" });

    const updated = await sbUpdate("firm_signals", `id=eq.${signal_id}`, {
      client_response: String(response).slice(0, 2000),
      client_responded_at: new Date().toISOString()
    });

    const fms = await sbSelect("firm_members", { firm_id: `eq.${signal.firm_id}`, select: "user_id" });
    for (const m of (fms || [])) {
      await sbInsert("notifications_firm", {
        user_id: m.user_id,
        firm_id: signal.firm_id,
        company_id: signal.company_id,
        type: "signal_response",
        title: "💬 Réponse à un signalement",
        body: String(response).slice(0, 200),
        link: `/firm/clients`,
        metadata: { signal_id }
      });
    }

    return json(res, 200, { ok: true, signal: updated?.[0] });
  }

  // ═══════════════════════════════════════════════════════════════════
  // ACTIONS MESSAGERIE (Sprint 4 v8.28)
  // ═══════════════════════════════════════════════════════════════════

  if (action === "thread_create") {
    const { firm_id, company_id, subject, first_message } = p;
    if (!firm_id || !company_id || !subject) return json(res, 400, { error: "firm_id, company_id, subject requis" });

    let authorSide = null;
    const tcFm = await sbSelect("firm_members", { firm_id: `eq.${firm_id}`, user_id: `eq.${user.id}`, limit: 1 });
    if (tcFm && tcFm.length > 0) authorSide = "firm";
    if (!authorSide) {
      const tcC = await sbSelect("companies", { id: `eq.${company_id}`, user_id: `eq.${user.id}`, limit: 1 });
      if (tcC && tcC.length > 0) authorSide = "client";
    }
    if (!authorSide) return json(res, 403, { error: "Non autorisé" });

    const tcLinks = await sbSelect("firm_client_links", { firm_id: `eq.${firm_id}`, company_id: `eq.${company_id}`, status: "eq.accepted", select: "id", limit: 1 });
    if (!tcLinks || tcLinks.length === 0) return json(res, 403, { error: "Cabinet non lié" });

    const thread = await sbInsert("firm_threads", {
      firm_id, company_id, created_by: user.id, subject: String(subject).slice(0, 200), status: "open"
    });
    if (!thread) return json(res, 500, { error: "Échec création thread" });

    if (first_message && String(first_message).trim()) {
      const msg = await sbInsert("firm_messages", {
        thread_id: thread[0].id, firm_id, company_id,
        author_id: user.id, author_side: authorSide,
        content: String(first_message).slice(0, 5000),
        read_by_firm: authorSide === "firm",
        read_by_client: authorSide === "client"
      });
      await notifyNewMessage(thread[0], msg?.[0], authorSide);
    }

    return json(res, 200, { ok: true, thread: thread[0] });
  }

  if (action === "message_send") {
    const { thread_id, content, attachments } = p;
    if (!thread_id || !content) return json(res, 400, { error: "thread_id et content requis" });

    const threads = await sbSelect("firm_threads", { id: `eq.${thread_id}`, limit: 1 });
    if (!threads || threads.length === 0) return json(res, 404, { error: "Thread introuvable" });
    const thread = threads[0];

    let authorSide = null;
    const msFm = await sbSelect("firm_members", { firm_id: `eq.${thread.firm_id}`, user_id: `eq.${user.id}`, limit: 1 });
    if (msFm && msFm.length > 0) authorSide = "firm";
    if (!authorSide) {
      const msC = await sbSelect("companies", { id: `eq.${thread.company_id}`, user_id: `eq.${user.id}`, limit: 1 });
      if (msC && msC.length > 0) authorSide = "client";
    }
    if (!authorSide) return json(res, 403, { error: "Non autorisé" });
    if (thread.status === "archived") return json(res, 400, { error: "Thread archivé" });

    const msg = await sbInsert("firm_messages", {
      thread_id, firm_id: thread.firm_id, company_id: thread.company_id,
      author_id: user.id, author_side: authorSide,
      content: String(content).slice(0, 5000),
      attachments: Array.isArray(attachments) ? attachments.slice(0, 10) : [],
      read_by_firm: authorSide === "firm",
      read_by_client: authorSide === "client"
    });
    if (!msg) return json(res, 500, { error: "Échec envoi" });

    await notifyNewMessage(thread, msg[0], authorSide);
    return json(res, 200, { ok: true, message: msg[0] });
  }

  if (action === "message_mark_read") {
    const { thread_id } = p;
    if (!thread_id) return json(res, 400, { error: "thread_id requis" });
    const threads = await sbSelect("firm_threads", { id: `eq.${thread_id}`, limit: 1 });
    if (!threads || threads.length === 0) return json(res, 404, { error: "Thread introuvable" });
    const thread = threads[0];

    let side = null;
    const mrFm = await sbSelect("firm_members", { firm_id: `eq.${thread.firm_id}`, user_id: `eq.${user.id}`, limit: 1 });
    if (mrFm && mrFm.length > 0) side = "firm";
    if (!side) {
      const mrC = await sbSelect("companies", { id: `eq.${thread.company_id}`, user_id: `eq.${user.id}`, limit: 1 });
      if (mrC && mrC.length > 0) side = "client";
    }
    if (!side) return json(res, 403, { error: "Non autorisé" });

    const field = side === "firm" ? "read_by_firm" : "read_by_client";
    await sbUpdate("firm_messages", `thread_id=eq.${thread_id}&${field}=eq.false`, { [field]: true });
    return json(res, 200, { ok: true });
  }

  if (action === "thread_close" || action === "thread_reopen" || action === "thread_archive") {
    const { thread_id } = p;
    if (!thread_id) return json(res, 400, { error: "thread_id requis" });
    const threads = await sbSelect("firm_threads", { id: `eq.${thread_id}`, limit: 1 });
    if (!threads || threads.length === 0) return json(res, 404, { error: "Thread introuvable" });
    const thread = threads[0];

    let allowed = false;
    const tFm = await sbSelect("firm_members", { firm_id: `eq.${thread.firm_id}`, user_id: `eq.${user.id}`, limit: 1 });
    if (tFm && tFm.length > 0) allowed = true;
    if (!allowed) {
      const tC = await sbSelect("companies", { id: `eq.${thread.company_id}`, user_id: `eq.${user.id}`, limit: 1 });
      if (tC && tC.length > 0) allowed = true;
    }
    if (!allowed) return json(res, 403, { error: "Non autorisé" });

    const newStatus = action === "thread_close" ? "closed" : action === "thread_reopen" ? "open" : "archived";
    const patch = { status: newStatus };
    if (action === "thread_close") patch.closed_at = new Date().toISOString();
    if (action === "thread_reopen") patch.closed_at = null;

    const updated = await sbUpdate("firm_threads", `id=eq.${thread_id}`, patch);
    return json(res, 200, { ok: true, thread: updated?.[0] });
  }

  // ═══════════════════════════════════════════════════════════════════
  // PDF_REFRESH_URL : régénère une URL signée Storage fraîche (1h)
  //   Entrée : { stored_url }   (l'URL stockée en base, potentiellement expirée)
  //   Sortie : { ok: true, pdf_url }
  //   Sécurité : bucket "invoices-pdf", path commence par "<company_id>/".
  //   Accès autorisé si user owns company, est admin, ou est firm_member lié.
  // ═══════════════════════════════════════════════════════════════════
  if (action === "pdf_refresh_url") {
    const { stored_url } = p;
    if (!stored_url) return json(res, 400, { error: "stored_url requis" });

    // Parser l'URL pour extraire bucket + path
    let bucket, path;
    try {
      const u = new URL(stored_url);
      const m = u.pathname.match(/\/storage\/v1\/object\/(?:sign|public)\/([^/]+)\/(.+)$/);
      if (!m) return json(res, 400, { error: "URL Storage invalide" });
      bucket = m[1];
      path = decodeURIComponent(m[2]);
    } catch {
      return json(res, 400, { error: "URL Storage invalide" });
    }

    // Buckets autorisés : factures émises + scans d'achats
    if (bucket !== "invoices-pdf" && bucket !== "purchases-attach") {
      return json(res, 400, { error: "Bucket non autorisé : " + bucket });
    }

    // Extraire company_id (premier segment du path)
    const companyId = path.split("/")[0];
    if (!companyId) return json(res, 400, { error: "company_id introuvable dans le path" });

    // Vérifier l'autorisation : on tente d'abord la voie owner direct,
    // puis on délègue à la fonction SQL firm_can_read qui couvre tous les cas
    // (owner, admin, firm_member via lien accepté).
    let allowed = false;

    console.log(`[pdf_refresh_url] user=${user.id} company=${companyId} bucket=${bucket}`);

    // Cas 1 : user owns this company (rapide, évite l'appel RPC)
    const ownCo = await sbSelect("companies", { id: `eq.${companyId}`, user_id: `eq.${user.id}`, select: "id", limit: 1 });
    if (ownCo && ownCo.length > 0) { allowed = true; console.log("[pdf_refresh_url] allowed via owner"); }

    // Cas 2 : on demande à PostgREST d'invoquer firm_can_read avec le token user.
    // Cette fonction est SECURITY DEFINER et gère tous les cas (admin, firm_member, etc.)
    if (!allowed) {
      try {
        const rpcR = await fetch(`${SUPABASE_URL}/rest/v1/rpc/firm_can_read`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: SR_KEY,
            Authorization: `Bearer ${token}`  // token user, pas service role
          },
          body: JSON.stringify({ p_company_id: companyId })
        });
        if (rpcR.ok) {
          const can = await rpcR.json();
          console.log(`[pdf_refresh_url] firm_can_read returned: ${JSON.stringify(can)}`);
          if (can === true) allowed = true;
        } else {
          const txt = await rpcR.text();
          console.warn(`[pdf_refresh_url] firm_can_read RPC failed ${rpcR.status}: ${txt}`);
        }
      } catch (e) {
        console.warn("[pdf_refresh_url] firm_can_read exception:", e.message);
      }
    }

    if (!allowed) {
      console.warn(`[pdf_refresh_url] DENIED user=${user.id} company=${companyId}`);
      return json(res, 403, { error: "Accès refusé à ce document" });
    }

    // Générer une URL signée fraîche (1h)
    const signR = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${bucket}/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SR_KEY}`,
        apikey: SR_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ expiresIn: 3600 })
    });
    if (!signR.ok) {
      const txt = await signR.text();
      console.error("[firm-invitation] sign error", signR.status, txt);
      return json(res, 500, { error: "Échec génération URL signée" });
    }
    const signJ = await signR.json();
    const freshUrl = signJ.signedURL ? `${SUPABASE_URL}/storage/v1${signJ.signedURL}` : null;
    if (!freshUrl) return json(res, 500, { error: "URL signée vide" });

    return json(res, 200, { ok: true, pdf_url: freshUrl });
  }

  // ═══════════════════════════════════════════════════════════════════
  // ATTACHMENT_SIGNED_URL : URL signée pour une PJ de message (bucket firm-attachments)
  //   Entrée : { thread_id, path }   (path = "thread_<id>/<filename>")
  //   Sortie : { ok: true, url }
  //   Sécurité : user doit avoir accès au thread (firm_member OU owner de la company)
  // ═══════════════════════════════════════════════════════════════════
  if (action === "attachment_signed_url") {
    const { thread_id, path } = p;
    if (!thread_id || !path) return json(res, 400, { error: "thread_id et path requis" });

    // Charger le thread
    const threads = await sbSelect("firm_threads", { id: `eq.${thread_id}`, limit: 1 });
    const thread = threads && threads[0];
    if (!thread) return json(res, 404, { error: "Thread introuvable" });

    // Vérifier l'accès (même pattern que thread_close, qui fonctionne)
    let allowed = false;
    const fm = await sbSelect("firm_members", { firm_id: `eq.${thread.firm_id}`, user_id: `eq.${user.id}`, limit: 1 });
    if (fm && fm.length > 0) allowed = true;
    if (!allowed) {
      const co = await sbSelect("companies", { id: `eq.${thread.company_id}`, user_id: `eq.${user.id}`, limit: 1 });
      if (co && co.length > 0) allowed = true;
    }
    if (!allowed) {
      console.warn("[attachment_signed_url] Accès refusé", {
        user_id: user.id,
        thread_id: thread.id,
        thread_firm_id: thread.firm_id,
        thread_company_id: thread.company_id,
        fm_count: fm?.length,
        fm_raw: fm
      });
      return json(res, 403, { error: "Accès refusé" });
    }

    // Vérifier que le path appartient bien à ce thread (sécurité supplémentaire :
    // empêche un user qui a accès au thread A de demander une PJ du thread B)
    const expectedPrefix = `thread_${thread_id}/`;
    if (!path.startsWith(expectedPrefix)) {
      return json(res, 400, { error: "Path ne correspond pas au thread" });
    }

    // Générer URL signée 1h
    const signR = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/firm-attachments/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SR_KEY}`,
        apikey: SR_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ expiresIn: 3600 })
    });
    if (!signR.ok) {
      const txt = await signR.text();
      console.error("[firm-invitation] attachment sign error", signR.status, txt);
      return json(res, 500, { error: "Échec génération URL signée" });
    }
    const signJ = await signR.json();
    const freshUrl = signJ.signedURL ? `${SUPABASE_URL}/storage/v1${signJ.signedURL}` : null;
    if (!freshUrl) return json(res, 500, { error: "URL signée vide" });

    return json(res, 200, { ok: true, url: freshUrl });
  }

  return json(res, 400, { error: "Action inconnue : " + action });
}

// ═══════════════════════════════════════════════════════════════════
// Helper notif
// ═══════════════════════════════════════════════════════════════════
async function notifyNewMessage(thread, message, authorSide) {
  if (!thread || !message) return;
  const firms = await sbSelect("accounting_firms", { id: `eq.${thread.firm_id}`, select: "name" });
  const companies = await sbSelect("companies", { id: `eq.${thread.company_id}`, select: "legal_name,user_id,billing_email" });
  const firmName = firms?.[0]?.name || "Cabinet";
  const companyName = companies?.[0]?.legal_name || "Client";
  const preview = String(message.content || "").slice(0, 200);

  if (authorSide === "firm") {
    if (companies?.[0]?.user_id) {
      await sbInsert("notifications_firm", {
        user_id: companies[0].user_id,
        firm_id: thread.firm_id,
        company_id: thread.company_id,
        type: "message_new",
        title: `💬 Message de ${firmName} : ${thread.subject}`,
        body: preview,
        link: `/dashboard`,
        metadata: { thread_id: thread.id, message_id: message.id }
      });
      // Email
      if (process.env.RESEND_API_KEY && companies?.[0]?.billing_email) {
        try {
          await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: process.env.FROM_EMAIL || "noreply@iobill.online",
              to: companies[0].billing_email,
              subject: `[${firmName}] ${thread.subject}`,
              html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
<h3 style="color:#d4a843">💬 Nouveau message de votre cabinet</h3>
<p><strong>${firmName}</strong> dans <strong>« ${String(thread.subject).replace(/</g,"&lt;")} »</strong> :</p>
<blockquote style="border-left:3px solid #d4a843;padding-left:12px;color:#555;">${String(preview).replace(/</g,"&lt;")}</blockquote>
<p><a href="${process.env.APP_URL || "https://app.iobill.online"}" style="background:#d4a843;color:#0b0c10;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Voir le message →</a></p>
<p style="font-size:11px;color:#aaa">— IO BILL</p></div>`
            })
          });
        } catch (e) { console.warn("[notifyNewMessage] email fail:", e.message); }
      }
    }
  } else {
    const fms = await sbSelect("firm_members", { firm_id: `eq.${thread.firm_id}`, select: "user_id" });
    for (const m of (fms || [])) {
      await sbInsert("notifications_firm", {
        user_id: m.user_id,
        firm_id: thread.firm_id,
        company_id: thread.company_id,
        type: "message_new",
        title: `💬 Message de ${companyName} : ${thread.subject}`,
        body: preview,
        link: `/firm/messages?thread=${thread.id}`,
        metadata: { thread_id: thread.id, message_id: message.id }
      });
    }
  }
}
