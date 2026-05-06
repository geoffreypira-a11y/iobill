// IO BILL - Envoi d'un document (devis, facture, relance) par email via Resend
// Le PDF est généré à la volée si pas encore stocké, puis envoyé en piece jointe.

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.RESEND_FROM || "facturation@iobill.fr";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { company } = auth;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const { document_type, document_id, custom_message, custom_subject } = body || {};
  if (!document_type || !document_id) {
    return json(res, 400, { error: "document_type and document_id required" });
  }
  if (!["quote", "invoice", "credit_note", "reminder"].includes(document_type)) {
    return json(res, 400, { error: "Invalid document_type" });
  }

  // 1) Charger le document
  const tableMap = { quote: "quotes", invoice: "invoices", credit_note: "credit_notes", reminder: "invoices" };
  const table = tableMap[document_type];
  const doc = await sbAdmin.selectOne(table, `id=eq.${document_id}&company_id=eq.${company.id}`);
  if (!doc) return json(res, 404, { error: "Document not found" });

  const recipientEmail = doc.client_snapshot?.email;
  if (!recipientEmail) {
    return json(res, 400, { error: "Recipient email missing in client snapshot" });
  }

  // 2) Récupérer ou générer le PDF
  let pdfUrl = doc.pdf_url || doc.facturx_pdf_url;
  if (!pdfUrl && document_type === "invoice") {
    // Déclencher la génération Factur-X côté serveur (appel interne)
    const facturxRes = await fetch(
      `${process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : "http://localhost:3000"}/api/generate-facturx`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: req.headers.authorization
        },
        body: JSON.stringify({ invoice_id: document_id })
      }
    );
    if (facturxRes.ok) {
      const j = await facturxRes.json();
      pdfUrl = j.pdf_url;
    }
  }

  // 3) Construction du sujet et corps email
  const docLabel = {
    quote: "Devis",
    invoice: "Facture",
    credit_note: "Avoir",
    reminder: "Relance facture"
  }[document_type];

  const subject = custom_subject || `${docLabel} ${doc.number} — ${company.legal_name}`;
  const intro = custom_message || defaultIntro(document_type, doc, company);

  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,sans-serif;color:#222;background:#f5f4f0;padding:24px;margin:0">
  <div style="max-width:560px;margin:auto;background:#fff;border-radius:10px;padding:32px">
    <div style="font-family:'Syne',sans-serif;font-size:22px;letter-spacing:2px;font-weight:800;color:#0b0c10;margin-bottom:6px">
      IO<span style="color:#d4a843">BILL</span>
    </div>
    <div style="font-size:11px;color:#888;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:24px">
      Facturation par OWL'S INDUSTRY
    </div>
    <div style="white-space:pre-line;font-size:14px;line-height:1.6;color:#222">${escapeHtml(intro)}</div>
    ${pdfUrl ? `<div style="margin:28px 0">
      <a href="${pdfUrl}" style="display:inline-block;background:#0b0c10;color:#d4a843;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;letter-spacing:0.5px">
        📄 Télécharger le ${docLabel.toLowerCase()}
      </a>
    </div>` : ""}
    ${doc.stripe_payment_link_url ? `<div style="margin:14px 0">
      <a href="${doc.stripe_payment_link_url}" style="display:inline-block;background:#3ecf7a;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:600;font-size:13px">
        💳 Payer en ligne
      </a>
    </div>` : ""}
    <div style="margin-top:32px;padding-top:18px;border-top:1px solid #eee;font-size:11px;color:#999">
      ${escapeHtml(company.legal_name)}${company.siret ? ` · SIRET ${company.siret}` : ""}<br>
      ${company.email || ""}${company.phone ? ` · ${company.phone}` : ""}
    </div>
  </div>
</body></html>`;

  // 4) Envoi via Resend
  if (!RESEND_API_KEY) {
    return json(res, 503, { error: "Resend not configured (set RESEND_API_KEY)" });
  }

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`
    },
    body: JSON.stringify({
      from: `${company.legal_name} <${FROM_EMAIL}>`,
      to: [recipientEmail],
      reply_to: company.email,
      subject,
      html
    })
  });

  if (!resendRes.ok) {
    const errText = await resendRes.text();
    return json(res, 502, { error: "Resend API error", detail: errText.slice(0, 500) });
  }

  const resendData = await resendRes.json();

  // 5) Marquer le document comme envoyé
  if (document_type === "quote" && doc.status === "draft") {
    await sbAdmin.update("quotes", `id=eq.${doc.id}`, { status: "sent" });
  } else if (document_type === "invoice" && doc.status === "issued") {
    await sbAdmin.update("invoices", `id=eq.${doc.id}`, { status: "sent" });
  } else if (document_type === "reminder") {
    await sbAdmin.update("invoices", `id=eq.${doc.id}`, {
      last_reminder_sent_at: new Date().toISOString(),
      reminder_count: (doc.reminder_count || 0) + 1
    });
  }

  return json(res, 200, { ok: true, resend_id: resendData.id, recipient: recipientEmail });
}

function defaultIntro(type, doc, company) {
  const recipient = doc.client_snapshot?.contact_person || doc.client_snapshot?.first_name || "Bonjour,";
  if (type === "quote") {
    return `${recipient}\n\nVous trouverez ci-joint le devis ${doc.number} pour un montant de ${formatEUR(doc.total_ttc_cents)} TTC, valable jusqu'au ${formatDate(doc.expires_at)}.\n\nN'hésitez pas à revenir vers moi pour toute question.\n\nCordialement,\n${company.legal_name}`;
  }
  if (type === "invoice") {
    return `${recipient}\n\nVeuillez trouver ci-joint la facture ${doc.number} d'un montant de ${formatEUR(doc.total_ttc_cents)} TTC, à régler avant le ${formatDate(doc.due_date)}.\n\nMerci pour votre confiance.\n\nCordialement,\n${company.legal_name}`;
  }
  if (type === "credit_note") {
    return `${recipient}\n\nVous trouverez ci-joint l'avoir ${doc.number} d'un montant de ${formatEUR(doc.total_ttc_cents)}.\n\nCordialement,\n${company.legal_name}`;
  }
  if (type === "reminder") {
    return `${recipient}\n\nSauf erreur de notre part, la facture ${doc.number} d'un montant de ${formatEUR(doc.total_ttc_cents - (doc.paid_cents || 0))} reste impayée à ce jour.\n\nNous vous remercions de procéder à son règlement dans les meilleurs délais.\n\nCordialement,\n${company.legal_name}`;
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
