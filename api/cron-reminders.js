// IO BILL - Moteur de relances automatiques
// ═══════════════════════════════════════════════════════════════════
// Trois modes d'appel :
//
//   1. CRON Vercel (header x-vercel-cron) ou `Authorization: Bearer <CRON_SECRET>`
//      → balaye TOUTES les sociétés. C'est le filet de sécurité quotidien.
//
//   2. v8.48 — INSTANTANÉ : `Authorization: Bearer <jwt utilisateur>`
//      → balaye uniquement la société de l'utilisateur et envoie
//        immédiatement les relances dues, sans attendre le cron.
//        Body { mode: "auto" }   → déclenché par l'app à l'ouverture
//                                  (limité à 1 passage / 10 min).
//        Body { mode: "manual" } → bouton "Relancer maintenant"
//                                  (limité à 1 passage / min).
//
//   3. Mode "single notif" (body { notif_id }) : envoi immédiat de l'email
//      d'une notification, appelé depuis Postgres via pg_net.
//
// Cadence des relances :
//   J+3   : rappel courtois
//   J+10  : 1ere relance ferme
//   J+30  : 2eme relance avec mention penalites
//   J+60  : derniere relance avant procedure
//
// Le moteur est IDEMPOTENT (reminder_count + last_reminder_sent_at) : on peut
// le repasser toutes les 15 minutes sans jamais renvoyer deux fois la même
// relance.
// ═══════════════════════════════════════════════════════════════════

import { sbAdmin, json, authenticate } from "./_lib/supabase-admin.js";
import { sendTrackedEmail, htmlToText, logEmail, parseRecipients } from "./_lib/email-log.js";
import { notifyAdmin } from "./_lib/monitor.js";

const CRON_SECRET = process.env.CRON_SECRET;

// Intervalle minimum entre deux passages déclenchés depuis l'app.
const THROTTLE_MS = { manual: 60 * 1000, auto: 10 * 60 * 1000 };

export default async function handler(req, res) {
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  // Auth Vercel Cron : header `x-vercel-cron: 1` automatiquement injecte par Vercel.
  // En complement, on accepte un Bearer si configure (utilise par pg_net pour le mode single notif).
  const isVercelCron = req.headers["x-vercel-cron"] === "1";
  const auth = req.headers.authorization || "";
  const hasSecret = CRON_SECRET && auth === `Bearer ${CRON_SECRET}`;
  const isPrivileged = isVercelCron || hasSecret;

  // ═══════════════════════════════════════════════════════════
  // MODE "single notif" : appele depuis Postgres via pg_net
  // pour envoyer un email instantanement apres creation d'une notif.
  // Body: { notif_id: "uuid" }
  // ═══════════════════════════════════════════════════════════
  const singleNotifId = isPrivileged ? body?.notif_id : null;

  if (singleNotifId) {
    try {
      const notif = await sbAdmin.selectOne("notifications", `id=eq.${singleNotifId}`);
      if (!notif) return json(res, 404, { error: "notif not found" });
      if (notif.email_sent_at) return json(res, 200, { ok: true, skipped: "already sent" });

      // Verifier la preference email pour ce type
      const prefRows = await sbAdmin.select("notification_preferences", {
        filter: `company_id=eq.${notif.company_id}&notif_type=eq.${notif.notif_type}`,
        limit: 1
      });
      const pref = (prefRows && prefRows[0]) || null;
      if (pref && pref.email === false) {
        // Pref desactivee : marquer comme traite pour ne pas reessayer
        await sbAdmin.update("notifications", `id=eq.${singleNotifId}`, {
          email_sent_at: new Date().toISOString()
        });
        return json(res, 200, { ok: true, skipped: "email disabled in prefs" });
      }

      // Recuperer email recipient
      const companyRow = await sbAdmin.selectOne("companies", `id=eq.${notif.company_id}`);
      if (!companyRow) return json(res, 404, { error: "company not found" });
      const userEmail = await resolveUserEmail(companyRow);
      if (!userEmail) return json(res, 400, { error: "no email for user" });

      const sent = await sendNotifEmail({ notif, company: companyRow, recipientEmail: userEmail });
      if (sent) {
        await sbAdmin.update("notifications", `id=eq.${singleNotifId}`, {
          email_sent_at: new Date().toISOString()
        });
      }
      return json(res, 200, { ok: sent, recipient: userEmail });
    } catch (e) {
      console.error("[cron] single notif error", e.message);
      notifyAdmin({
        level: "warn",
        subject: "Cron single notif a planté",
        details: { notif_id: singleNotifId, error: e?.message }
      }).catch(() => {});
      return json(res, 500, { error: e.message });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // v8.48 — DÉCLENCHEMENT INSTANTANÉ par un utilisateur connecté
  // ═══════════════════════════════════════════════════════════
  let scopedCompany = null;
  let source = "cron";

  if (!isPrivileged) {
    const userAuth = await authenticate(req);
    if (userAuth.error) return json(res, 401, { error: "Unauthorized" });

    scopedCompany = userAuth.company;
    source = body?.mode === "auto" ? "auto" : "manual";

    if (scopedCompany.reminders_email_enabled === false) {
      return json(res, 200, {
        ok: true,
        skipped: "reminders_disabled",
        message: "Les relances automatiques sont désactivées pour cette société."
      });
    }

    // Anti-rafale : inutile de rebalayer les factures toutes les 10 secondes.
    const last = scopedCompany.reminders_last_run_at
      ? Date.parse(scopedCompany.reminders_last_run_at)
      : 0;
    const gap = THROTTLE_MS[source];
    if (last && Date.now() - last < gap) {
      return json(res, 200, {
        ok: true,
        throttled: true,
        last_run_at: scopedCompany.reminders_last_run_at,
        message: "Relances déjà vérifiées il y a moins de "
          + Math.round(gap / 60000) + " min."
      });
    }
  }

  // ═══════════════════════════════════════════════════════════
  // BALAYAGE DES FACTURES EN RETARD
  // ═══════════════════════════════════════════════════════════
  const result = await runReminders({
    companyId: scopedCompany?.id || null,
    source
  });

  // ═══════════════════════════════════════════════════════════
  // ENVOI EMAILS pour les notifications non lues + pref email=true
  // (uniquement sur le passage global : c'est du courrier interne)
  // ═══════════════════════════════════════════════════════════
  let notifEmailsSent = 0;
  if (!scopedCompany) notifEmailsSent = await runPendingNotifEmails();

  return json(res, 200, {
    ok: true,
    scope: scopedCompany ? "company" : "all",
    source,
    ...result,
    notif_emails_sent: notifEmailsSent
  });
}

// ═══════════════════════════════════════════════════════════
// Moteur : balaye les factures en retard et envoie ce qui est dû
// ═══════════════════════════════════════════════════════════
async function runReminders({ companyId = null, source = "cron" } = {}) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const nowIso = new Date().toISOString();

  // Toutes les factures en retard (status != paid/canceled, due_date passee)
  const filter = [
    `status=in.(issued,sent,partial,overdue)`,
    `due_date=lt.${today.toISOString().slice(0, 10)}`,
    companyId ? `company_id=eq.${companyId}` : null
  ].filter(Boolean).join("&");

  const allOverdue = await sbAdmin.select("invoices", {
    filter,
    order: "due_date.asc",
    limit: 1000
  });

  let sent = 0;
  let updated = 0;
  let errors = 0;
  let skipped = 0;
  const reminders = [];
  const companies = new Map(); // cache company_id → row

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

    try {
      // v8.110 — Relances activables par société (défaut ON : null/undefined =
      // activé). Si explicitement désactivé, on n'envoie NI email NI SMS.
      let company = companies.get(inv.company_id);
      if (company === undefined) {
        company = await sbAdmin.selectOne("companies", `id=eq.${inv.company_id}`);
        companies.set(inv.company_id, company);
      }
      if (company && company.reminders_email_enabled === false) continue;

      const message = buildReminderMessage(template, inv);
      const subject = buildReminderSubject(template, inv);

      // 1) Email
      const out = await sendReminderEmail(inv, company, subject, message, source, template);
      if (out.ok) {
        await sbAdmin.update("invoices", `id=eq.${inv.id}`, {
          last_reminder_sent_at: nowIso,
          reminder_count: (inv.reminder_count || 0) + 1
        });
        sent++;
        reminders.push({
          invoice: inv.number, template, overdueDays, channel: "email",
          status: "sent", recipient: out.recipient
        });
      } else if (out.reason === "missing_recipient_email") {
        // Cause n°1 des « mon client n'a rien reçu » : pas d'email sur la fiche.
        skipped++;
        reminders.push({
          invoice: inv.number, template, overdueDays, channel: "email",
          status: "skipped",
          error: "Aucune adresse email sur la fiche client"
        });
      } else {
        errors++;
        reminders.push({
          invoice: inv.number, template, overdueDays, channel: "email",
          status: "failed", recipient: out.recipient, error: out.error
        });
      }

      // 2) SMS aux relances tardives (J+30, J+60) si SMS active sur la company
      //    On necessite : company.sms_enabled, client phone, et on n'envoie qu'une fois par template
      if (["second", "final"].includes(template)) {
        const clientPhone = inv.client_snapshot?.phone;
        if (company?.sms_enabled && clientPhone) {
          const smsOk = await sendReminderSms(inv, company, clientPhone, template);
          if (smsOk) {
            sent++;
            reminders.push({
              invoice: inv.number, template, overdueDays, channel: "sms", status: "sent"
            });
          }
        }
      }
    } catch (e) {
      errors++;
      reminders.push({
        invoice: inv.number, template, overdueDays, channel: "email",
        status: "failed", error: e?.message || "erreur inconnue"
      });
    }
  }

  // Horodater le passage (affiché dans les réglages + anti-rafale).
  const touched = companyId ? [companyId] : [...companies.keys()];
  for (const id of touched) {
    await sbAdmin.update("companies", `id=eq.${id}`, { reminders_last_run_at: nowIso });
  }

  return {
    scanned: (allOverdue || []).length,
    marked_overdue: updated,
    reminders_sent: sent,
    skipped,
    errors,
    run_at: nowIso,
    detail: reminders
  };
}

// ═══════════════════════════════════════════════════════════
// Emails des notifications internes en attente
// ═══════════════════════════════════════════════════════════
async function runPendingNotifEmails() {
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

        const userEmail = await resolveUserEmail(companyRow);
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
  return notifEmailsSent;
}

// L'email peut etre dans company.email OU faut le chercher via auth.users (service_role)
async function resolveUserEmail(companyRow) {
  if (companyRow.email) return companyRow.email;
  if (!companyRow.user_id) return null;
  try {
    const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const ur = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${companyRow.user_id}`, {
      headers: { apikey: SERVICE_ROLE, Authorization: "Bearer " + SERVICE_ROLE }
    });
    if (ur.ok) {
      const user = await ur.json();
      return user?.email || null;
    }
  } catch {}
  return null;
}

// ═══════════════════════════════════════════════════════════
// Envoi email de notification (helper)
// ═══════════════════════════════════════════════════════════
async function sendNotifEmail({ notif, company, recipientEmail }) {
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

  const out = await sendTrackedEmail(
    {
      from: `IO BILL <${FROM}>`,
      to: [recipientEmail],
      subject: `${icon} ${notif.title}`,
      html,
      text: htmlToText(html)
    },
    {
      company_id: notif.company_id,
      kind: "notification",
      document_type: "notification",
      document_id: notif.id,
      trigger_source: "cron"
    }
  );
  return out.ok;
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

async function sendReminderEmail(inv, company, subject, message, source, template) {
  const FROM_EMAIL = (process.env.RESEND_FROM || "facturation@iobill.online")
    .replace(/.*<([^>]+)>.*/, "$1")
    .trim();

  // v8.49 — plusieurs destinataires possibles ("compta@x.fr ; direction@x.fr")
  const { to: recipientEmail, cc: ccEmails, all: allRecipients } =
    parseRecipients(inv.client_snapshot?.email);
  const supplierName = inv.company_snapshot?.legal_name || company?.legal_name || "IO BILL";

  // Pas d'email sur la fiche client → on trace le motif au lieu d'échouer en
  // silence (c'est LA raison la plus fréquente d'une relance jamais reçue).
  if (!recipientEmail) {
    await logEmail({
      company_id: inv.company_id,
      kind: "reminder",
      document_type: "invoice",
      document_id: inv.id,
      document_number: inv.number,
      subject,
      status: "skipped",
      error: "missing_recipient_email — aucune adresse email valide sur la fiche client",
      reminder_template: template,
      trigger_source: source
    });
    return { ok: false, reason: "missing_recipient_email", recipient: null };
  }

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

  const payload = {
    from: `${supplierName.replace(/[<>"\\]/g, "").trim()} <${FROM_EMAIL}>`,
    to: [recipientEmail],
    ...(ccEmails.length ? { cc: ccEmails } : {}),
    subject,
    html,
    // Partie texte : indispensable pour ne pas tomber en spam.
    text: message
  };

  // v8.48 — reply_to sur l'email de l'émetteur : le client répond au
  // fournisseur, pas dans le vide. C'est aussi un bon signal anti-spam.
  if (company?.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(company.email)) {
    payload.reply_to = company.email;
  }

  const out = await sendTrackedEmail(payload, {
    company_id: inv.company_id,
    kind: "reminder",
    document_type: "invoice",
    document_id: inv.id,
    document_number: inv.number,
    reminder_template: template,
    trigger_source: source
  });

  return { ok: out.ok, error: out.error, recipient: allRecipients.join(", ") };
}

function formatEUR(cents) {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format((cents || 0) / 100);
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
      // Journal unifié des envois (email + SMS)
      await logEmail({
        company_id: inv.company_id,
        kind: "reminder",
        document_type: "invoice",
        document_id: inv.id,
        document_number: inv.number,
        recipient: normalized,
        subject: message.slice(0, 120),
        provider: "ovh",
        channel: "sms",
        status: "sent",
        reminder_template: template,
        sent_at: new Date().toISOString()
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
