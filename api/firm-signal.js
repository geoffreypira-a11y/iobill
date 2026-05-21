// ────────────────────────────────────────────────────────────────
// IO BILL — API /api/firm-signal
// Sprint 3 — Signalements universels par le cabinet
// Actions : create, resolve, dismiss, respond, delete
// ────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SR_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
    console.warn(`[firm-signal] sbSelect ${table} ${r.status}: ${txt}`);
    return null;
  }
  return await r.json();
}

async function sbInsert(table, data) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: authHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(data)
  });
  if (!r.ok) {
    const txt = await r.text();
    console.error(`[firm-signal] sbInsert ${table} ${r.status}: ${txt}`);
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
    console.warn(`[firm-signal] sbUpdate ${table} ${r.status}: ${txt}`);
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
    return null;
  }
}

const VALID_TARGETS = ['invoice', 'quote', 'credit_note', 'purchase', 'client', 'general'];
const VALID_SEVERITIES = ['info', 'warning', 'critical'];

export default async function handler(req, res) {
  try {
    return await handleRequest(req, res);
  } catch (e) {
    console.error("[firm-signal] UNCAUGHT:", e?.stack || e?.message);
    return json(res, 500, { error: "Erreur serveur", details: e?.message });
  }
}

async function handleRequest(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

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

  // ═══════════════════════════════════════════════════════════════════
  // CREATE : cabinet crée un signalement
  // ═══════════════════════════════════════════════════════════════════
  if (action === "create") {
    const { firm_id, company_id, target_type, target_id, severity, title, content, visible_to_client, blocks_emission } = p;

    if (!firm_id || !company_id || !target_type || !title) {
      return json(res, 400, { error: "firm_id, company_id, target_type, title requis" });
    }
    if (!VALID_TARGETS.includes(target_type)) {
      return json(res, 400, { error: "target_type invalide" });
    }
    const sev = VALID_SEVERITIES.includes(severity) ? severity : 'warning';

    // Vérifier que l'user est firm_member (owner/partner/staff)
    const members = await sbSelect("firm_members", {
      firm_id: `eq.${firm_id}`,
      user_id: `eq.${user.id}`,
      role: "in.(owner,partner,staff)",
      select: "role"
    });
    if (!members || members.length === 0) {
      return json(res, 403, { error: "Non autorisé (firm_member owner/partner/staff requis)" });
    }

    // Vérifier que le cabinet est lié à la company (status accepted)
    const links = await sbSelect("firm_client_links", {
      firm_id: `eq.${firm_id}`,
      company_id: `eq.${company_id}`,
      status: "eq.accepted",
      select: "id",
      limit: 1
    });
    if (!links || links.length === 0) {
      return json(res, 403, { error: "Cabinet non lié à cette company (status accepted requis)" });
    }

    // Créer le signal
    const signal = await sbInsert("firm_signals", {
      firm_id,
      company_id,
      author_id: user.id,
      target_type,
      target_id: target_id || null,
      severity: sev,
      title: title.slice(0, 200),
      content: (content || "").slice(0, 2000),
      status: 'open',
      visible_to_client: visible_to_client !== false,
      blocks_emission: !!blocks_emission
    });

    if (!signal) return json(res, 500, { error: "Échec création signalement" });

    // Notifier le client si visible
    if (visible_to_client !== false) {
      const companies = await sbSelect("companies", { id: `eq.${company_id}`, select: "user_id,legal_name" });
      const firms = await sbSelect("accounting_firms", { id: `eq.${firm_id}`, select: "name" });
      if (companies?.[0]?.user_id) {
        const sevEmoji = { info: "🟦", warning: "🟧", critical: "🟥" }[sev] || "🟧";
        await sbInsert("notifications_firm", {
          user_id: companies[0].user_id,
          firm_id,
          company_id,
          type: "signal_new",
          title: `${sevEmoji} ${firms?.[0]?.name || "Votre cabinet"} a signalé : ${title.slice(0, 80)}`,
          body: content?.slice(0, 200) || "",
          link: `/signals/${signal[0].id}`,
          metadata: { signal_id: signal[0].id, severity: sev, target_type, target_id }
        });
      }
    }

    return json(res, 200, { ok: true, signal: signal[0] });
  }

  // ═══════════════════════════════════════════════════════════════════
  // RESOLVE : marquer comme résolu (client ou cabinet)
  // ═══════════════════════════════════════════════════════════════════
  if (action === "resolve") {
    const { signal_id, comment } = p;
    if (!signal_id) return json(res, 400, { error: "signal_id requis" });

    const signals = await sbSelect("firm_signals", { id: `eq.${signal_id}`, limit: 1 });
    if (!signals || signals.length === 0) return json(res, 404, { error: "Signal introuvable" });
    const signal = signals[0];

    // Autorisation : firm_member OU owner company
    let allowed = false;
    const fm = await sbSelect("firm_members", { firm_id: `eq.${signal.firm_id}`, user_id: `eq.${user.id}`, limit: 1 });
    if (fm && fm.length > 0) allowed = true;
    if (!allowed) {
      const c = await sbSelect("companies", { id: `eq.${signal.company_id}`, user_id: `eq.${user.id}`, limit: 1 });
      if (c && c.length > 0) allowed = true;
    }
    if (!allowed) return json(res, 403, { error: "Non autorisé" });

    const updated = await sbUpdate("firm_signals", `id=eq.${signal_id}`, {
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      ...(comment ? { client_response: comment } : {})
    });

    // Notifier l'autre partie
    const isCabinetAction = fm && fm.length > 0;
    if (isCabinetAction) {
      // Cabinet a résolu → notifier client
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
      // Client a résolu → notifier cabinet
      const fms = await sbSelect("firm_members", { firm_id: `eq.${signal.firm_id}`, select: "user_id" });
      for (const m of (fms || [])) {
        await sbInsert("notifications_firm", {
          user_id: m.user_id,
          firm_id: signal.firm_id,
          company_id: signal.company_id,
          type: "signal_resolved_by_client",
          title: "✅ Le client a résolu un signalement",
          body: signal.title + (comment ? ` — Réponse : ${comment.slice(0, 100)}` : ""),
          link: `/firm/clients/${signal.company_id}`,
          metadata: { signal_id }
        });
      }
    }

    return json(res, 200, { ok: true, signal: updated?.[0] });
  }

  // ═══════════════════════════════════════════════════════════════════
  // DISMISS : annuler / classer sans suite (cabinet only)
  // ═══════════════════════════════════════════════════════════════════
  if (action === "dismiss") {
    const { signal_id, reason } = p;
    if (!signal_id) return json(res, 400, { error: "signal_id requis" });

    const signals = await sbSelect("firm_signals", { id: `eq.${signal_id}`, limit: 1 });
    if (!signals || signals.length === 0) return json(res, 404, { error: "Signal introuvable" });
    const signal = signals[0];

    const fm = await sbSelect("firm_members", { firm_id: `eq.${signal.firm_id}`, user_id: `eq.${user.id}`, role: "in.(owner,partner)", limit: 1 });
    if (!fm || fm.length === 0) return json(res, 403, { error: "Non autorisé (owner/partner cabinet requis)" });

    const updated = await sbUpdate("firm_signals", `id=eq.${signal_id}`, {
      status: 'dismissed',
      resolved_at: new Date().toISOString(),
      ...(reason ? { content: signal.content + `\n\n[CLASSÉ SANS SUITE] ${reason}` } : {})
    });

    return json(res, 200, { ok: true, signal: updated?.[0] });
  }

  // ═══════════════════════════════════════════════════════════════════
  // RESPOND : client répond au signalement
  // ═══════════════════════════════════════════════════════════════════
  if (action === "respond") {
    const { signal_id, response } = p;
    if (!signal_id || !response) return json(res, 400, { error: "signal_id et response requis" });

    const signals = await sbSelect("firm_signals", { id: `eq.${signal_id}`, limit: 1 });
    if (!signals || signals.length === 0) return json(res, 404, { error: "Signal introuvable" });
    const signal = signals[0];

    const c = await sbSelect("companies", { id: `eq.${signal.company_id}`, user_id: `eq.${user.id}`, limit: 1 });
    if (!c || c.length === 0) return json(res, 403, { error: "Non autorisé" });

    const updated = await sbUpdate("firm_signals", `id=eq.${signal_id}`, {
      client_response: response.slice(0, 2000),
      client_responded_at: new Date().toISOString()
    });

    // Notifier le cabinet
    const fms = await sbSelect("firm_members", { firm_id: `eq.${signal.firm_id}`, select: "user_id" });
    for (const m of (fms || [])) {
      await sbInsert("notifications_firm", {
        user_id: m.user_id,
        firm_id: signal.firm_id,
        company_id: signal.company_id,
        type: "signal_response",
        title: "💬 Réponse à un signalement",
        body: response.slice(0, 200),
        link: `/firm/clients/${signal.company_id}`,
        metadata: { signal_id }
      });
    }

    return json(res, 200, { ok: true, signal: updated?.[0] });
  }

  return json(res, 400, { error: "Action inconnue : " + action });
}
