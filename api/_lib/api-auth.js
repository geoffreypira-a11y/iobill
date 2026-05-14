// IO BILL - Middleware d'authentification API publique
// Format de cle : iobill_live_<8 chars prefix>_<32 chars secret>
// Hash: pbkdf2 sha256, 10 000 iterations, salt fixe par cle (stocke en DB)
//
// Workflow request :
//   1. Extraire Authorization: Bearer iobill_live_xxx
//   2. Lookup api_keys par key_hash (= hash full key)
//   3. Verifier non-revoked + scope necessaire
//   4. Ratelimit in-memory window 1 minute (60 req par defaut)
//   5. Log dans api_request_log

import { createHash, randomBytes, pbkdf2Sync } from "crypto";
import { sbAdmin } from "./supabase-admin.js";

// Window-based ratelimit en memoire process. OK pour Vercel serverless
// (chaque cold-start reset, mais le ratelimit moyen est sur 1 minute glissante).
// Pour du strict, il faudrait Redis Upstash mais on garde simple en V1.3.
const rateLimits = new Map(); // key_id -> { count, resetAt }

const PBKDF2_ITERATIONS = 10000;
const PBKDF2_KEYLEN = 32;

/**
 * Hash une cle API en clair pour comparaison ou stockage.
 * Utilise pbkdf2 mais avec un salt deterministe (le prefix de la cle)
 * pour permettre le lookup en DB sans avoir le salt en clair.
 */
export function hashApiKey(plainKey) {
  // Strategy : on hashe la cle entiere avec un salt = "iobill" + prefix
  const prefix = plainKey.split("_").slice(0, 3).join("_"); // iobill_live_xxxxxxxx
  const salt = "iobill_v1_" + prefix;
  return pbkdf2Sync(plainKey, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, "sha256").toString("hex");
}

/**
 * Generer une nouvelle cle API
 * Format : iobill_live_<8 chars prefix>_<32 chars secret>
 * Le prefix sert pour identification dans le dashboard
 */
export function generateApiKey() {
  const prefix = randomBytes(4).toString("hex"); // 8 hex chars
  const secret = randomBytes(16).toString("hex"); // 32 hex chars
  const fullKey = `iobill_live_${prefix}_${secret}`;
  const hash = hashApiKey(fullKey);
  const displayPrefix = `iobill_live_${prefix}`;
  return { fullKey, hash, displayPrefix };
}

/**
 * Authentifier une requete via cle API.
 * Retourne { error, status, key, company } ou { key, company }.
 */
export async function authenticateApiKey(req, requiredScope = "read") {
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader) return { error: "Missing Authorization header", status: 401 };

  const match = authHeader.match(/^Bearer\s+(iobill_live_[a-z0-9_]+)$/i);
  if (!match) return { error: "Invalid API key format", status: 401 };

  const plainKey = match[1];
  const hash = hashApiKey(plainKey);

  const apiKey = await sbAdmin.selectOne("api_keys", `key_hash=eq.${hash}&revoked_at=is.null`);
  if (!apiKey) return { error: "Invalid or revoked API key", status: 401 };

  // Verifier le scope
  if (requiredScope && !apiKey.scopes?.includes(requiredScope) && !apiKey.scopes?.includes("admin")) {
    return { error: `Scope "${requiredScope}" required`, status: 403 };
  }

  // Charger la company associee
  const company = await sbAdmin.selectOne("companies", `id=eq.${apiKey.company_id}`);
  if (!company) return { error: "Company not found", status: 404 };

  // Ratelimit
  const limit = apiKey.rate_limit_per_minute || 60;
  const now = Date.now();
  const window = rateLimits.get(apiKey.id) || { count: 0, resetAt: now + 60000 };

  if (now > window.resetAt) {
    window.count = 0;
    window.resetAt = now + 60000;
  }

  window.count++;
  rateLimits.set(apiKey.id, window);

  if (window.count > limit) {
    return {
      error: `Rate limit exceeded (${limit}/min)`,
      status: 429,
      retryAfter: Math.ceil((window.resetAt - now) / 1000)
    };
  }

  // Mise à jour async (pas bloquante) du last_used + IP
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress;
  sbAdmin.rpc("api_key_touch", { p_key_hash: hash, p_ip: ip || null }).catch(() => {});

  return {
    key: apiKey,
    company,
    rateLimitRemaining: Math.max(0, limit - window.count),
    rateLimitReset: Math.ceil(window.resetAt / 1000)
  };
}

/**
 * Logger une requete API (pour audit + analytics)
 */
export async function logApiRequest({ apiKey, company, req, statusCode, durationMs }) {
  if (!apiKey) return;
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || null;
  const requestId = req.headers["x-request-id"] || randomBytes(8).toString("hex");

  // Fire and forget
  sbAdmin.insert("api_request_log", {
    api_key_id: apiKey.id,
    company_id: company?.id || null,
    method: req.method,
    path: req.url?.split("?")[0]?.slice(0, 200),
    status_code: statusCode,
    duration_ms: durationMs,
    ip,
    request_id: requestId
  }).catch(() => {});
}
