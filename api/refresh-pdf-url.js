// ────────────────────────────────────────────────────────────────
// IO BILL — API /api/refresh-pdf-url
// v8.29 — Régénère une URL signée Supabase Storage fraîche à partir
//         d'une URL stockée (qui peut être expirée).
//
// Entrée  : { stored_url: "https://xxx.supabase.co/storage/v1/object/sign/<bucket>/<path>?token=..." }
// Sortie  : { ok: true, pdf_url: "<nouvelle URL signée valable 1h>" }
//
// Sécurité : vérifie que l'user a le droit de lire le document associé.
//   - bucket "invoices-pdf" + path "<company_id>/<filename>" :
//       autorisé si user owns company_id, est membre firm liée, ou admin.
// ────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SR_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(res, status, body) {
  res.status(status).setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(body));
}

async function getUser(token) {
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SR_KEY }
  });
  if (!r.ok) return null;
  return r.json();
}

async function sbSelect(table, filters, opts = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (typeof v === "string" && v.includes(".")) params.set(k, v);
    else params.set(k, `eq.${v}`);
  }
  if (opts.select) params.set("select", opts.select);
  if (opts.limit) params.set("limit", opts.limit);
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: { Authorization: `Bearer ${SR_KEY}`, apikey: SR_KEY }
  });
  if (!r.ok) return null;
  return r.json();
}

async function signedUrl(bucket, path, expiresIn = 3600) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${bucket}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SR_KEY}`,
      apikey: SR_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ expiresIn })
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.signedURL ? `${SUPABASE_URL}/storage/v1${j.signedURL}` : null;
}

/**
 * Extrait { bucket, path } d'une URL signée Supabase Storage.
 * Formats acceptés :
 *  - https://xxx.supabase.co/storage/v1/object/sign/<bucket>/<path>?token=...
 *  - https://xxx.supabase.co/storage/v1/object/public/<bucket>/<path>
 */
function parseStorageUrl(storedUrl) {
  try {
    const u = new URL(storedUrl);
    const m = u.pathname.match(/\/storage\/v1\/object\/(?:sign|public)\/([^/]+)\/(.+)$/);
    if (!m) return null;
    return { bucket: m[1], path: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}

/**
 * Vérifie que l'utilisateur a le droit de lire le fichier (bucket, path).
 * Pour invoices-pdf : path = "<company_id>/<filename>"
 *   → autorisé si user owns company OU est firm_member lié OU admin.
 */
async function userCanRead(user, bucket, path) {
  if (!user) return false;
  if (bucket !== "invoices-pdf") {
    // Pour d'autres buckets (logos, etc.) on n'autorise pas pour l'instant
    return false;
  }
  const companyId = path.split("/")[0];
  if (!companyId) return false;

  // Cas 1 : l'utilisateur est le propriétaire de la company
  const ownCo = await sbSelect("companies", { id: companyId, user_id: user.id }, { select: "id", limit: 1 });
  if (ownCo && ownCo.length > 0) return true;

  // Cas 2 : l'utilisateur est admin
  const adminP = await sbSelect("profiles", { user_id: user.id, is_admin: "eq.true" }, { select: "user_id", limit: 1 });
  if (adminP && adminP.length > 0) return true;

  // Cas 3 : l'utilisateur est membre d'un cabinet lié à cette company
  const links = await sbSelect("firm_client_links", { company_id: companyId, status: "eq.accepted" }, { select: "firm_id" });
  if (links && links.length > 0) {
    const firmIds = links.map((l) => l.firm_id);
    for (const fid of firmIds) {
      const fm = await sbSelect("firm_members", { firm_id: fid, user_id: user.id }, { select: "id", limit: 1 });
      if (fm && fm.length > 0) return true;
    }
  }

  return false;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const user = await getUser(token);
    if (!user) return json(res, 401, { error: "Non authentifié" });

    const { stored_url } = req.body || {};
    if (!stored_url) return json(res, 400, { error: "stored_url requis" });

    const parsed = parseStorageUrl(stored_url);
    if (!parsed) return json(res, 400, { error: "URL Storage invalide" });

    const allowed = await userCanRead(user, parsed.bucket, parsed.path);
    if (!allowed) return json(res, 403, { error: "Accès refusé à ce document" });

    const fresh = await signedUrl(parsed.bucket, parsed.path, 3600);
    if (!fresh) return json(res, 500, { error: "Échec génération URL signée" });

    return json(res, 200, { ok: true, pdf_url: fresh });
  } catch (e) {
    console.error("[refresh-pdf-url] error", e);
    return json(res, 500, { error: "Erreur serveur", details: e.message });
  }
}
