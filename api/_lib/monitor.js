// api/_lib/monitor.js — Alertes critiques vers contact@iobill.online
//
// Usage côté backend :
//   import { notifyAdmin } from "./_lib/monitor.js";
//   await notifyAdmin({
//     level: "error",                          // info | warn | error | critical
//     subject: "buildFacturxXml a planté",     // titre court
//     details: { error: e.message, doc: ... }  // objet contexte (JSON)
//   });
//
// Limites anti-spam : max 10 alerts/heure pour un même subject identique
// (déduplication via in-memory rate limiter — best-effort, partagé entre
// instances Vercel uniquement par chance, mais bon enough).
//
// Variables d'env requises :
//   RESEND_API_KEY (déjà configurée pour send-document)
//   MONITOR_EMAIL (optionnel, défaut "contact@iobill.online")
//   MONITOR_FROM  (optionnel, défaut "alerts@iobill.online")

const TO_EMAIL = process.env.MONITOR_EMAIL || "contact@iobill.online";
const FROM_EMAIL = process.env.MONITOR_FROM || "alerts@iobill.online";

// Rate limiter in-memory (réinitialisé à chaque cold-start Vercel, suffisant
// pour éviter de spammer en cas de boucle d'erreur dans une même invocation)
const recentAlerts = new Map();
const RATE_LIMIT_WINDOW_MS = 3600 * 1000; // 1h
const MAX_PER_SUBJECT = 10;

const LEVEL_EMOJI = {
  info: "ℹ️",
  warn: "⚠️",
  error: "🔴",
  critical: "🚨"
};

const LEVEL_COLOR = {
  info: "#3b82f6",
  warn: "#f59e0b",
  error: "#ef4444",
  critical: "#dc2626"
};

export async function notifyAdmin({ level = "error", subject, details = {} }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn("[monitor] RESEND_API_KEY manquant, alerte non envoyée");
    return false;
  }

  // Rate limit par sujet
  const now = Date.now();
  const key = subject || "(no subject)";
  const log = recentAlerts.get(key) || [];
  const recent = log.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= MAX_PER_SUBJECT) {
    console.warn(`[monitor] rate-limited (${MAX_PER_SUBJECT}/h) pour "${key}"`);
    return false;
  }
  recent.push(now);
  recentAlerts.set(key, recent);

  const emoji = LEVEL_EMOJI[level] || LEVEL_EMOJI.error;
  const color = LEVEL_COLOR[level] || LEVEL_COLOR.error;
  const title = `${emoji} [IO BILL ${level.toUpperCase()}] ${subject}`;

  const detailsHtml = renderDetails(details);

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table style="max-width:600px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">
    <tr><td style="background:${color};padding:18px 24px;color:white;">
      <div style="font-size:18px;font-weight:600;">${escapeHtml(title)}</div>
      <div style="font-size:11px;opacity:.85;margin-top:4px;">${new Date().toISOString()}</div>
    </td></tr>
    <tr><td style="padding:20px 24px;">
      <pre style="background:#f5f5f7;padding:14px;border-radius:6px;font-size:11px;overflow-x:auto;white-space:pre-wrap;word-break:break-word;">${detailsHtml}</pre>
      <div style="margin-top:18px;padding-top:14px;border-top:1px solid #eee;font-size:11px;color:#888;">
        Alert IO BILL · Pour ne plus recevoir : retire la variable d'env <code>MONITOR_EMAIL</code> côté Vercel.
      </div>
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
        from: `IO BILL Alerts <${FROM_EMAIL}>`,
        to: [TO_EMAIL],
        subject: title.slice(0, 120),
        html
      })
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.warn("[monitor] Resend non-ok:", r.status, t);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("[monitor] envoi échoué:", e?.message);
    return false;
  }
}

function renderDetails(details) {
  if (!details) return "(aucun détail)";
  try {
    return escapeHtml(JSON.stringify(details, null, 2));
  } catch {
    return escapeHtml(String(details));
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
