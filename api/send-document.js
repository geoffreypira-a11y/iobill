// IO BILL - Envoi d'un document (devis, facture, relance) par email via Resend
// Robuste : fallback sur les champs manquants, format From RFC-compliant, messages d'erreur clairs

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
// FROM_EMAIL doit être au format simple "email@domaine.fr" (sans nom)
// On ajoute le nom de la company devant à l'envoi
const FROM_EMAIL = (process.env.RESEND_FROM || "facturation@iobill.online")
  .replace(/.*<([^>]+)>.*/, "$1") // Si format "Nom <email>", on garde juste l'email
  .trim();

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { company } = auth;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const { document_type, document_id, custom_message, custom_subject, override_recipient } = body || {};
  if (!document_type || !document_id) {
    return json(res, 400, { error: "document_type et document_id requis" });
  }
  if (!["quote", "invoice", "credit_note", "reminder"].includes(document_type)) {
    return json(res, 400, { error: "document_type invalide" });
  }

  // 1) Charger le document
  const tableMap = { quote: "quotes", invoice: "invoices", credit_note: "credit_notes", reminder: "invoices" };
  const table = tableMap[document_type];
  const doc = await sbAdmin.selectOne(table, `id=eq.${document_id}&company_id=eq.${company.id}`);
  if (!doc) return json(res, 404, { error: "Document introuvable" });

  // 2) Destinataire : override > client_snapshot.email > erreur claire
  const recipientEmail = override_recipient
    || doc.client_snapshot?.email
    || null;

  if (!recipientEmail) {
    return json(res, 400, {
      error: "Aucune adresse email pour le destinataire. Ajoutez un email au client ou indiquez une adresse pour cet envoi.",
      hint: "missing_recipient_email"
    });
  }

  // Validation format email basique
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
    return json(res, 400, { error: "Format d'email destinataire invalide : " + recipientEmail });
  }

  if (!RESEND_API_KEY) {
    return json(res, 503, { error: "Resend non configuré (variable RESEND_API_KEY manquante)" });
  }

  // 3) Récupérer ou générer le PDF (si facture)
  let pdfUrl = doc.pdf_url || doc.facturx_pdf_url || null;
  if (!pdfUrl && document_type === "invoice") {
    try {
      const baseUrl = process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : (process.env.PUBLIC_BASE_URL || "");
      if (baseUrl) {
        const facturxRes = await fetch(`${baseUrl}/api/generate-facturx`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: req.headers.authorization
          },
          body: JSON.stringify({ invoice_id: document_id })
        });
        if (facturxRes.ok) {
          const j = await facturxRes.json();
          pdfUrl = j.pdf_url;
        }
      }
    } catch (e) {
      // Génération PDF non bloquante, on continue sans le PDF
      console.warn("[send-document] PDF generation failed:", e?.message);
    }
  }

  // 4) Lien public (pour devis : permettre la signature)
  let publicUrl = null;
  if (doc.public_token) {
    const base = process.env.PUBLIC_BASE_URL || "https://app.iobill.online";
    publicUrl = `${base}/p/${document_type === "quote" ? "quote" : "invoice"}/${doc.public_token}`;
  }

  // 5) Construction du sujet et corps email
  const docLabel = {
    quote: "Devis",
    invoice: "Facture",
    credit_note: "Avoir",
    reminder: "Relance facture"
  }[document_type];

  const issuerName = company.legal_name || "Votre prestataire";
  const subject = custom_subject || `${docLabel} ${doc.number} — ${issuerName}`;
  const intro = custom_message || defaultIntro(document_type, doc, issuerName);

  // 6) Email HTML — mise en avant de l'ÉMETTEUR (la company), IO BILL en petit footer
  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,'Segoe UI',sans-serif;color:#222;background:#f5f4f0;padding:24px;margin:0">
  <div style="max-width:560px;margin:auto;background:#fff;border-radius:10px;padding:32px">
    <div style="font-size:22px;font-weight:700;color:#0b0c10;margin-bottom:6px">
      ${escapeHtml(issuerName)}
    </div>
    <div style="font-size:11px;color:#888;letter-spacing:1px;margin-bottom:24px;text-transform:uppercase">
      ${docLabel} ${escapeHtml(doc.number)}
    </div>
    <div style="white-space:pre-line;font-size:14px;line-height:1.6;color:#222">${escapeHtml(intro)}</div>
    ${publicUrl ? `<div style="margin:28px 0">
      <a href="${publicUrl}" style="display:inline-block;background:#d4a843;color:#0b0c10;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;letter-spacing:0.5px">
        ${document_type === "quote" ? "✍️ Voir et signer le devis" : "📄 Voir le document"}
      </a>
    </div>` : ""}
    ${pdfUrl ? `<div style="margin:14px 0">
      <a href="${pdfUrl}" style="display:inline-block;background:transparent;color:#0b0c10;padding:10px 20px;text-decoration:underline;font-size:13px">
        Télécharger le PDF
      </a>
    </div>` : ""}
    ${doc.stripe_payment_link_url && document_type === "invoice" ? `<div style="margin:14px 0">
      <a href="${doc.stripe_payment_link_url}" style="display:inline-block;background:#3ecf7a;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:600;font-size:13px">
        💳 Payer en ligne
      </a>
    </div>` : ""}
    <div style="margin-top:32px;padding-top:18px;border-top:1px solid #eee;font-size:11px;color:#999">
      ${escapeHtml(issuerName)}${company.siret ? ` · SIRET ${company.siret}` : ""}<br>
      ${company.email ? escapeHtml(company.email) : ""}${company.phone ? ` · ${escapeHtml(company.phone)}` : ""}
    </div>
    <div style="margin-top:18px;font-size:10px;color:#bbb;text-align:center">
      Email envoyé via IO BILL · OWL'S INDUSTRY
    </div>
  </div>
</body></html>`;

  // 7) Envoi via Resend
  // Format From : "Nom de la société <facturation@iobill.online>"
  // Le nom est nettoyé pour éviter les caractères qui cassent le format RFC
  const cleanName = issuerName.replace(/[<>"\\]/g, "").trim();
  const fromHeader = cleanName ? `${cleanName} <${FROM_EMAIL}>` : FROM_EMAIL;

  const replyTo = company.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(company.email)
    ? company.email
    : undefined;

  const resendPayload = {
    from: fromHeader,
    to: [recipientEmail],
    subject,
    html
  };
  if (replyTo) resendPayload.reply_to = replyTo;

  let resendRes;
  try {
    resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`
      },
      body: JSON.stringify(resendPayload)
    });
  } catch (e) {
    return json(res, 502, { error: "Réseau Resend indisponible", detail: e?.message });
  }

  if (!resendRes.ok) {
    const errText = await resendRes.text().catch(() => "");
    return json(res, 502, {
      error: "Erreur Resend (" + resendRes.status + ")",
      detail: errText.slice(0, 500),
      hint: resendRes.status === 422 ? "Vérifiez que votre domaine est validé dans Resend et que l'adresse from est correcte." : undefined
    });
  }

  const resendData = await resendRes.json();

  // 8) Marquer le document comme envoyé
  if (document_type === "quote" && ["draft"].includes(doc.status)) {
    await sbAdmin.update("quotes", `id=eq.${doc.id}`, {
      status: "sent",
      sent_at: new Date().toISOString()
    });
  } else if (document_type === "invoice" && doc.status === "issued") {
    await sbAdmin.update("invoices", `id=eq.${doc.id}`, {
      status: "sent",
      sent_at: new Date().toISOString()
    });
  } else if (document_type === "reminder") {
    await sbAdmin.update("invoices", `id=eq.${doc.id}`, {
      last_reminder_sent_at: new Date().toISOString(),
      reminder_count: (doc.reminder_count || 0) + 1
    });
  }

  return json(res, 200, { ok: true, resend_id: resendData.id, recipient: recipientEmail });
}

function defaultIntro(type, doc, issuerName) {
  const recipient = doc.client_snapshot?.contact_person
    || doc.client_snapshot?.first_name
    || doc.client_snapshot?.legal_name
    || "Bonjour,";
  if (type === "quote") {
    return `${recipient},\n\nVeuillez trouver ci-joint le devis ${doc.number} pour un montant de ${formatEUR(doc.total_ttc_cents)} TTC, valable jusqu'au ${formatDate(doc.expires_at)}.\n\nVous pouvez le consulter et le signer en ligne via le lien ci-dessous.\n\nN'hésitez pas à revenir vers moi pour toute question.\n\nCordialement,\n${issuerName}`;
  }
  if (type === "invoice") {
    return `${recipient},\n\nVeuillez trouver ci-joint la facture ${doc.number} d'un montant de ${formatEUR(doc.total_ttc_cents)} TTC, à régler avant le ${formatDate(doc.due_date)}.\n\nMerci pour votre confiance.\n\nCordialement,\n${issuerName}`;
  }
  if (type === "credit_note") {
    return `${recipient},\n\nVous trouverez ci-joint l'avoir ${doc.number} d'un montant de ${formatEUR(doc.total_ttc_cents)}.\n\nCordialement,\n${issuerName}`;
  }
  if (type === "reminder") {
    return `${recipient},\n\nSauf erreur de notre part, la facture ${doc.number} d'un montant de ${formatEUR(doc.total_ttc_cents - (doc.paid_cents || 0))} reste impayée à ce jour.\n\nNous vous remercions de procéder à son règlement dans les meilleurs délais.\n\nCordialement,\n${issuerName}`;
  }
  return "";
}

function formatEUR(cents) {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format((cents || 0) / 100);
}
function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("fr-FR");
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
