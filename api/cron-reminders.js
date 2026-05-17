// IO BILL - CRON job de relances automatiques
// A configurer dans vercel.json :
//   "crons": [{ "path": "/api/cron-reminders", "schedule": "0 9 * * *" }]
// (tous les jours a 9h)
//
// Cadence des relances :
//   J+3   : rappel courtois
//   J+10  : 1ere relance ferme
//   J+30  : 2eme relance avec mention penalites
//   J+60  : derniere relance avant procedure
//
// Securite : ce endpoint n'est appelable que par Vercel Cron OU avec un header
// Authorization: Bearer <CRON_SECRET>.

import { sbAdmin, json } from "./_lib/supabase-admin.js";

const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  // Auth Vercel Cron : header `x-vercel-cron: 1` automatiquement injecte par Vercel.
  // En complement, on accepte un Bearer si configure.
  const isVercelCron = req.headers["x-vercel-cron"] === "1";
  const auth = req.headers.authorization || "";
  const hasSecret = CRON_SECRET && auth === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !hasSecret) {
    return json(res, 401, { error: "Unauthorized" });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Toutes les factures en retard (status != paid/canceled, due_date passee)
  const allOverdue = await sbAdmin.select("invoices", {
    filter: `status=in.(issued,sent,partial,overdue)&due_date=lt.${today.toISOString().slice(0, 10)}`,
    order: "due_date.asc",
    limit: 1000
  });

  let sent = 0;
  let updated = 0;
  let errors = 0;
  const reminders = [];

  for (const inv of allOverdue || []) {
    const dueDate = new Date(inv.due_date);
    const overdueDays = Math.floor((today - dueDate) / 86400000);

    // Calcule le seuil de la prochaine relance
    const lastSentAt = inv.last_reminder_sent_at ? new Date(inv.last_reminder_sent_at) : null;
    const lastSentDays = lastSentAt ? Math.floor((today - lastSentAt) / 86400000) : 999;

    // Doit-on envoyer une relance maintenant ?
    let template = null;
    if (overdueDays >= 60 && (inv.reminder_count || 0) < 4 && lastSentDays >= 25) {
      template = "final"; // J+60
    } else if (overdueDays >= 30 && (inv.reminder_count || 0) < 3 && lastSentDays >= 15) {
      template = "second"; // J+30
    } else if (overdueDays >= 10 && (inv.reminder_count || 0) < 2 && lastSentDays >= 5) {
      template = "first"; // J+10
    } else if (overdueDays >= 3 && (inv.reminder_count || 0) < 1) {
      template = "courteous"; // J+3
    }

    // Marquer comme overdue si pas encore fait
    if (inv.status !== "overdue") {
      await sbAdmin.update("invoices", `id=eq.${inv.id}`, { status: "overdue" });
      updated++;
    }

    if (!template) continue;

    // Envoyer la relance via l'API send-document (en interne)
    try {
      const message = buildReminderMessage(template, inv);
      const subject = buildReminderSubject(template, inv);

      // 1) Email
      const ok = await sendReminderEmail(inv, subject, message);
      if (ok) {
        await sbAdmin.update("invoices", `id=eq.${inv.id}`, {
          last_reminder_sent_at: new Date().toISOString(),
          reminder_count: (inv.reminder_count || 0) + 1
        });
        sent++;
        reminders.push({ invoice: inv.number, template, overdueDays, channel: "email" });
      } else {
        errors++;
      }

      // 2) SMS aux relances tardives (J+30, J+60) si SMS active sur la company
      //    On necessite : company.sms_enabled, client phone, et on n'envoie qu'une fois par template
      if (["second", "final"].includes(template)) {
        const company = await sbAdmin.selectOne("companies", `id=eq.${inv.company_id}`);
        const clientPhone = inv.client_snapshot?.phone;
        if (company?.sms_enabled && clientPhone) {
          const smsOk = await sendReminderSms(inv, company, clientPhone, template);
          if (smsOk) {
            sent++;
            reminders.push({ invoice: inv.number, template, overdueDays, channel: "sms" });
          }
        }
      }
    } catch (e) {
      errors++;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // ENVOI EMAILS pour les notifications non lues + pref email=true
  // ═══════════════════════════════════════════════════════════
  let notifEmailsSent = 0;
  try {
    // 1) Recuperer les notifs eligibles : non lues, pas encore emailees,
    //    creees dans les dernieres 24h (pour eviter le spam si la fonction
    //    a ete down)
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const pendingNotifs = await sbAdmin.select("notifications", {
      filter: `read_at=is.null&email_sent_at=is.null&created_at=gte.${since}`,
      order: "created_at.asc",
      limit: 50
    });

    // 2) Pour chaque notif : verifier la preference email, recuperer email user, envoyer
    for (const notif of (pendingNotifs || [])) {
      try {
        // Charger la pref pour cette company + ce type
        const prefRows = await sbAdmin.select("notification_preferences", {
          filter: `company_id=eq.${notif.company_id}&notif_type=eq.${notif.notif_type}`,
          limit: 1
        });
        const pref = (prefRows && prefRows[0]) || null;
        // Si pref existe et email=false → on skip
        if (pref && pref.email === false) {
          // Marquer comme "traite" pour pas reessayer 1000 fois
          await sbAdmin.update("notifications", `id=eq.${notif.id}`, {
            email_sent_at: new Date().toISOString()
          });
          continue;
        }
        // Si pas de pref enregistree, on respecte le defaut : envoyer

        // Recuperer email de la company (l'utilisateur)
        const companyRow = await sbAdmin.selectOne("companies", `id=eq.${notif.company_id}`);
        if (!companyRow) continue;

        // L'email peut etre dans company.email OU faut le chercher via auth.users (service_role)
        let userEmail = companyRow.email;
        if (!userEmail && companyRow.user_id) {
          // Appel direct API auth admin
          try {
            const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
            const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
            const ur = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${companyRow.user_id}`, {
              headers: { apikey: SERVICE_ROLE, Authorization: "Bearer " + SERVICE_ROLE }
            });
            if (ur.ok) {
              const user = await ur.json();
              userEmail = user?.email;
            }
          } catch {}
        }
        if (!userEmail) continue;

        // Envoi via Resend
        await sendNotifEmail({ notif, company: companyRow, recipientEmail: userEmail });
        await sbAdmin.update("notifications", `id=eq.${notif.id}`, {
          email_sent_at: new Date().toISOString()
        });
        notifEmailsSent++;
      } catch (e) {
        // Continuer avec la suivante en cas d'erreur
        console.error("[cron] notif email error", e.message);
      }
    }
  } catch (e) {
    console.error("[cron] notif scan error", e.message);
  }

  return json(res, 200, {
    ok: true,
    scanned: (allOverdue || []).length,
    marked_overdue: updated,
    reminders_sent: sent,
    notif_emails_sent: notifEmailsSent,
    errors,
    detail: reminders
  });
}

// ═══════════════════════════════════════════════════════════
// Envoi email de notification (helper)
// ═══════════════════════════════════════════════════════════
async function sendNotifEmail({ notif, company, recipientEmail }) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) return false;

  const FROM = (process.env.RESEND_FROM || "notifications@iobill.online")
    .replace(/.*<([^>]+)>.*/, "$1")
    .trim();
  const brandColor = company.brand_color || "#d4a843";
  const appUrl = "https://app.iobill.online" + (notif.url || "/");
  const icon = notif.icon || "🔔";

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; background: #fff; color: #0b0c10">
      <div style="margin-bottom: 24px">
        <div style="font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: #888; margin-bottom: 8px">
          IO BILL
        </div>
        <h1 style="font-size: 20px; font-weight: 700; margin: 0; color: #0b0c10">
          ${icon} ${escapeHtml(notif.title)}
        </h1>
      </div>
      ${notif.body ? `<p style="font-size: 14px; line-height: 1.6; color: #333; margin: 0 0 24px 0">${escapeHtml(notif.body)}</p>` : ""}
      ${notif.url ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 16px 0">
        <tr>
          <td bgcolor="${brandColor}" style="background-color:${brandColor};border-radius:8px;padding:0">
            <a href="${appUrl}" style="display:inline-block;background-color:${brandColor};color:#0b0c10 !important;padding:12px 24px;text-decoration:none !important;border-radius:8px;font-weight:600;font-size:13px">
              <span style="color:#0b0c10 !important;text-decoration:none !important">Voir dans IO BILL →</span>
            </a>
          </td>
        </tr>
      </table>` : ""}
      <div style="margin-top: 36px; padding-top: 16px; border-top: 1px solid #eee; font-size: 11px; color: #999; line-height: 1.6">
        Vous recevez cet email parce que vous avez activé les notifications pour "${escapeHtml(notif.title)}".<br/>
        <a href="https://app.iobill.online/settings" style="color: #999">Gérer vos préférences</a> · IO BILL — OWL'S INDUSTRY
      </div>
    </div>
  `;

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + RESEND_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: `IO BILL <${FROM}>`,
      to: [recipientEmail],
      subject: `${icon} ${notif.title}`,
      html
    })
  });
  return r.ok;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function buildReminderSubject(template, inv) {
  const labels = {
    courteous: `Rappel — Facture ${inv.number}`,
    first: `1ère relance — Facture ${inv.number}`,
    second: `2ème relance — Facture ${inv.number}`,
    final: `Dernière relance avant procédure — Facture ${inv.number}`
  };
  return labels[template];
}

function buildReminderMessage(template, inv) {
  const recipient = inv.client_snapshot?.contact_person || "Bonjour,";
  const remaining = formatEUR(inv.total_ttc_cents - (inv.paid_cents || 0));
  const dueDate = new Date(inv.due_date).toLocaleDateString("fr-FR");
  const supplier = inv.company_snapshot?.legal_name || "";

  const tpls = {
    courteous: `${recipient}\n\nSauf erreur de notre part, la facture ${inv.number} d'un montant de ${remaining} arrivait à échéance le ${dueDate} et reste impayée à ce jour.\n\nIl s'agit peut-être d'un oubli — n'hésitez pas à revenir vers moi en cas de difficulté.\n\nCordialement,\n${supplier}`,
    first: `${recipient}\n\nMalgré un premier rappel, la facture ${inv.number} d'un montant de ${remaining} (échéance ${dueDate}) reste impayée.\n\nMerci de procéder au règlement sous 7 jours.\n\nCordialement,\n${supplier}`,
    second: `${recipient}\n\nMalgré nos relances, la facture ${inv.number} d'un montant de ${remaining} reste impayée à ce jour, soit plus de 30 jours après l'échéance du ${dueDate}.\n\nNous vous rappelons qu'en application de l'article L441-10 du Code de commerce, des pénalités de retard ainsi qu'une indemnité forfaitaire de 40 € pour frais de recouvrement seront appliquées.\n\nCordialement,\n${supplier}`,
    final: `${recipient}\n\nVotre facture ${inv.number} d'un montant de ${remaining} reste impayée plus de 60 jours après son échéance, malgré nos relances précédentes.\n\nÀ défaut de règlement sous 8 jours, nous serons contraints d'engager une procédure de recouvrement, avec toutes les conséquences que cela implique (mise en demeure, injonction de payer).\n\nNous restons à votre disposition pour trouver une solution amiable avant cette extrémité.\n\nCordialement,\n${supplier}`
  };
  return tpls[template];
}

async function sendReminderEmail(inv, subject, message) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const FROM_EMAIL = process.env.RESEND_FROM || "facturation@iobill.fr";
  if (!RESEND_API_KEY) return false;

  const recipientEmail = inv.client_snapshot?.email;
  if (!recipientEmail) return false;

  const supplierName = inv.company_snapshot?.legal_name || "IO BILL";
  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,sans-serif;color:#222;background:#f5f4f0;padding:24px;margin:0">
  <div style="max-width:560px;margin:auto;background:#fff;border-radius:10px;padding:32px">
    <div style="font-family:'Syne',sans-serif;font-size:22px;letter-spacing:2px;font-weight:800;color:#0b0c10">
      IO<span style="color:#d4a843">BILL</span>
    </div>
    <div style="font-size:11px;color:#888;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:24px">
      Facturation par OWL'S INDUSTRY
    </div>
    <div style="white-space:pre-line;font-size:14px;line-height:1.6">${escapeHtml(message)}</div>
    ${inv.stripe_payment_link_url ? `<div style="margin:28px 0">
      <a href="${inv.stripe_payment_link_url}" style="display:inline-block;background:#3ecf7a;color:#fff;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px">
        💳 Régler maintenant
      </a>
    </div>` : ""}
  </div>
</body></html>`;

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({
      from: `${supplierName} <${FROM_EMAIL}>`,
      to: [recipientEmail],
      subject,
      html
    })
  });
  return r.ok;
}

function formatEUR(cents) {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format((cents || 0) / 100);
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ──────────────────────────────────────────────────────────────
// SMS de relance via OVH (uniquement aux relances tardives)
// ──────────────────────────────────────────────────────────────
async function sendReminderSms(inv, company, phone, template) {
  const cfg = {
    appKey: process.env.OVH_APP_KEY,
    appSecret: process.env.OVH_APP_SECRET,
    consumerKey: process.env.OVH_CONSUMER_KEY,
    serviceName: process.env.OVH_SMS_SERVICE_NAME,
    sender: process.env.OVH_SMS_SENDER || "IOBILL"
  };
  if (!cfg.appKey || !cfg.appSecret || !cfg.consumerKey || !cfg.serviceName) return false;

  const remaining = (inv.total_ttc_cents - (inv.paid_cents || 0)) / 100;
  const n = remaining.toFixed(2).replace(".", ",");
  const message = template === "final"
    ? `URGENT - Facture ${inv.number} (${n}€) impayée. Procédure de recouvrement engagée si non règlement sous 7j. ${company.legal_name}.`
    : `Rappel : facture ${inv.number} de ${n}€ impayée + de 30j. Merci de régler rapidement. ${company.legal_name}.`;

  // E.164 normalisation
  const normalized = phone.startsWith("+") ? phone
    : phone.startsWith("0") ? "+33" + phone.slice(1).replace(/[\s\.\-]/g, "")
    : null;
  if (!normalized) return false;

  const url = `https://eu.api.ovh.com/1.0/sms/${cfg.serviceName}/jobs`;
  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyStr = JSON.stringify({
    receivers: [normalized], message, sender: cfg.sender,
    senderForResponse: false, noStopClause: false, priority: "high"
  });
  const { createHash } = await import("crypto");
  const sig = "$1$" + createHash("sha1")
    .update([cfg.appSecret, cfg.consumerKey, "POST", url, bodyStr, ts].join("+"))
    .digest("hex");

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "X-Ovh-Application": cfg.appKey,
        "X-Ovh-Consumer": cfg.consumerKey,
        "X-Ovh-Timestamp": ts,
        "X-Ovh-Signature": sig,
        "Content-Type": "application/json"
      },
      body: bodyStr
    });
    if (r.ok) {
      // Log
      await sbAdmin.insert("sms_log", {
        company_id: inv.company_id,
        invoice_id: inv.id,
        recipient_phone: normalized,
        message, provider: "ovh", status: "sent"
      });
      // Increment counter
      await sbAdmin.update("companies", `id=eq.${inv.company_id}`, {
        sms_count_month: (company.sms_count_month || 0) + 1
      });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
