// IO BILL - Envoi d'un document (devis, facture, relance) par email via Resend
// - PDF joint en piece attachee (base64)
// - Bouton "Voir et accepter" pointant vers la page publique (signature simple)
// - Branding de l'emetteur en grand, IO BILL en petit footer

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";
import { randomBytes } from "node:crypto";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = (process.env.RESEND_FROM || "facturation@iobill.online")
  .replace(/.*<([^>]+)>.*/, "$1")
  .trim();
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { company } = auth;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const {
    document_type,
    document_id,
    custom_message,
    custom_subject,
    override_recipient,
    public_token: providedToken  // optionnel: si le frontend a deja un token
  } = body || {};

  if (!document_type || !document_id) {
    return json(res, 400, { error: "document_type et document_id requis" });
  }
  if (!["quote", "invoice", "credit_note", "reminder"].includes(document_type)) {
    return json(res, 400, { error: "document_type invalide" });
  }

  if (!RESEND_API_KEY) {
    return json(res, 503, { error: "Resend non configure (variable RESEND_API_KEY manquante)" });
  }

  // 1) Charger le document
  const tableMap = { quote: "quotes", invoice: "invoices", credit_note: "credit_notes", reminder: "invoices" };
  const table = tableMap[document_type];
  const doc = await sbAdmin.selectOne(table, `id=eq.${document_id}&company_id=eq.${company.id}`);
  if (!doc) return json(res, 404, { error: "Document introuvable" });

  // 2) Destinataire (override > client_snapshot.email)
  const recipientEmail = override_recipient || doc.client_snapshot?.email || null;

  if (!recipientEmail) {
    return json(res, 400, {
      error: "Aucune adresse email pour le destinataire. Ajoutez un email au client ou indiquez une adresse pour cet envoi.",
      hint: "missing_recipient_email"
    });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail)) {
    return json(res, 400, { error: "Format d'email destinataire invalide : " + recipientEmail });
  }

  // 3) Generer ou recuperer le PDF
  // Pour les devis : appel direct a generate-quote-pdf en interne via fetch local n'est pas fiable
  // sous Vercel. On utilise plutot le module directement, ou on telecharge le PDF depuis Storage si deja genere.
  let pdfUrl = doc.pdf_url || doc.facturx_pdf_url || null;
  let pdfBase64 = null;
  let pdfFilename = `${document_type === "quote" ? "Devis" : document_type === "invoice" ? "Facture" : document_type === "credit_note" ? "Avoir" : "Document"}-${(doc.number || "").replace(/[^a-zA-Z0-9-]/g, "_")}.pdf`;

  // Si pas de PDF deja en base, on essaie de le generer
  if (!pdfUrl) {
    try {
      const baseUrl = process.env.PUBLIC_BASE_URL
        || (process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : "");
      if (baseUrl) {
        const genEndpoint = document_type === "quote"
          ? "/api/generate-quote-pdf"
          : (document_type === "invoice" ? "/api/generate-facturx" : null);

        if (genEndpoint) {
          const genRes = await fetch(`${baseUrl}${genEndpoint}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: req.headers.authorization
            },
            body: JSON.stringify(
              document_type === "quote"
                ? { quote_id: document_id }
                : { invoice_id: document_id }
            )
          });
          if (genRes.ok) {
            const genJson = await genRes.json();
            pdfUrl = genJson.pdf_url || null;
            if (genJson.pdf_base64) pdfBase64 = genJson.pdf_base64;
          }
        }
      }
    } catch (e) {
      console.warn("[send-document] PDF generation failed:", e?.message);
      // Non bloquant, l'email peut partir sans PJ
    }
  }

  // Si on a une URL mais pas le base64, on telecharge le PDF depuis Storage
  if (pdfUrl && !pdfBase64) {
    try {
      const r = await fetch(pdfUrl);
      if (r.ok) {
        const buf = await r.arrayBuffer();
        pdfBase64 = bufferToBase64(buf);
      }
    } catch (e) {
      console.warn("[send-document] Cannot download PDF:", e?.message);
    }
  }

  // 4) Lien public pour signature/consultation
  let publicUrl = null;
  let publicToken = providedToken || null;

  if (!publicToken && (document_type === "quote" || document_type === "invoice")) {
    // a) Chercher un token existant
    try {
      const existing = await sbAdmin.select("public_tokens", {
        filter: `scope=eq.${document_type}&resource_id=eq.${document_id}`,
        order: "created_at.desc",
        limit: 1,
        select: "token,expires_at,revoked_at"
      });
      if (existing && existing[0]) {
        const t = existing[0];
        const notExpired = !t.expires_at || new Date(t.expires_at) > new Date();
        const notRevoked = !t.revoked_at;
        if (notExpired && notRevoked) {
          publicToken = t.token;
        }
      }
    } catch (e) {
      console.error("[send-document] Token lookup error:", e?.message);
    }

    // b) Si toujours pas de token, en creer un (sans try-catch pour voir l'erreur)
    if (!publicToken) {
      const newToken = generateUrlSafeToken(32);
      const expiresAt = new Date(Date.now() + 90 * 86400000).toISOString();
      const insertResult = await sbAdmin.insert("public_tokens", {
        token: newToken,
        company_id: company.id,
        scope: document_type,
        resource_id: document_id,
        expires_at: expiresAt,
        max_uses: null
      });
      // insertResult est un array, ou null si erreur HTTP
      if (insertResult && Array.isArray(insertResult) && insertResult.length > 0) {
        publicToken = newToken;
      } else if (insertResult && insertResult.token) {
        // Cas où retour direct sans array
        publicToken = insertResult.token;
      } else {
        // Insert a échoué → on garde le token quand même (probable cas: création OK mais réponse vide)
        // On vérifie via SELECT
        const check = await sbAdmin.select("public_tokens", {
          filter: `token=eq.${newToken}`,
          limit: 1
        });
        if (check && check[0]) {
          publicToken = newToken;
        } else {
          console.error("[send-document] Token creation failed, no record found");
        }
      }
    }
  }

  if (publicToken) {
    const base = process.env.PUBLIC_BASE_URL || "https://app.iobill.online";
    publicUrl = `${base}/p/${document_type === "quote" ? "quote" : "invoice"}/${publicToken}`;
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

  // 6) Email HTML — emetteur en grand, IO BILL en petit footer
  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,'Segoe UI',sans-serif;color:#222;background:#f5f4f0;padding:24px;margin:0">
  <div style="max-width:560px;margin:auto;background:#fff;border-radius:10px;padding:32px">
    <div style="font-size:22px;font-weight:700;color:#0b0c10;margin-bottom:6px">
      ${escapeHtml(issuerName)}
    </div>
    <div style="font-size:11px;color:#888;letter-spacing:1px;margin-bottom:24px;text-transform:uppercase">
      ${docLabel} ${escapeHtml(doc.number || "")}
    </div>
    <div style="white-space:pre-line;font-size:14px;line-height:1.6;color:#222">${escapeHtml(intro)}</div>
    ${publicUrl ? `<div style="margin:28px 0">
      <a href="${publicUrl}" style="display:inline-block;background:${escapeHtml(company.brand_color || '#d4a843')};color:#0b0c10;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px;letter-spacing:0.5px">
        ${document_type === "quote" ? "✍️ Consulter et accepter le devis" : "📄 Consulter le document"}
      </a>
    </div>` : ""}
    ${doc.stripe_payment_link_url && document_type === "invoice" ? `<div style="margin:14px 0">
      <a href="${doc.stripe_payment_link_url}" style="display:inline-block;background:#3ecf7a;color:#fff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:600;font-size:13px">
        💳 Payer en ligne
      </a>
    </div>` : ""}
    ${pdfBase64 ? `<div style="margin:16px 0;font-size:12px;color:#888">📎 Document joint en PDF : ${escapeHtml(pdfFilename)}</div>` : ""}
    <div style="margin-top:32px;padding-top:18px;border-top:1px solid #eee;font-size:11px;color:#999">
      ${escapeHtml(issuerName)}${company.siret ? ` · SIRET ${company.siret}` : ""}<br>
      ${company.email ? escapeHtml(company.email) : ""}${company.phone ? ` · ${escapeHtml(company.phone)}` : ""}
    </div>
    <div style="margin-top:18px;font-size:10px;color:#bbb;text-align:center">
      Envoyé via IO BILL · OWL'S INDUSTRY
    </div>
  </div>
</body></html>`;

  // 7) Envoi via Resend
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

  // PJ
  if (pdfBase64) {
    resendPayload.attachments = [
      {
        filename: pdfFilename,
        content: pdfBase64
      }
    ];
  }

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
    return json(res, 502, { error: "Reseau Resend indisponible", detail: e?.message });
  }

  if (!resendRes.ok) {
    const errText = await resendRes.text().catch(() => "");
    return json(res, 502, {
      error: "Erreur Resend (" + resendRes.status + ")",
      detail: errText.slice(0, 500),
      hint: resendRes.status === 422
        ? "Verifiez que votre domaine est valide dans Resend et que l'adresse from est correcte."
        : undefined
    });
  }

  const resendData = await resendRes.json();

  // 8) Marquer le document comme envoye
  // Note : public_token n'est PAS stocke sur quote/invoice, il est dans la table public_tokens
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

  return json(res, 200, {
    ok: true,
    resend_id: resendData.id,
    recipient: recipientEmail,
    pdf_attached: !!pdfBase64,
    public_url: publicUrl
  });
}

// ─── Helpers ──────────────────────────────────────────────

function defaultIntro(type, doc, issuerName) {
  const recipient = doc.client_snapshot?.contact_person
    || doc.client_snapshot?.first_name
    || doc.client_snapshot?.legal_name
    || "Bonjour,";
  if (type === "quote") {
    return `${recipient},\n\nVeuillez trouver ci-joint le devis ${doc.number} pour un montant de ${formatEUR(doc.total_ttc_cents)} TTC, valable jusqu'au ${formatDate(doc.expires_at)}.\n\nVous pouvez le consulter et l'accepter en ligne via le lien ci-dessous.\n\nN'hésitez pas à revenir vers moi pour toute question.\n\nCordialement,\n${issuerName}`;
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
function bufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return Buffer.from(bin, "binary").toString("base64");
}
function generateUrlSafeToken(n = 32) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  const bytes = randomBytes(n);
  for (let i = 0; i < n; i++) out += chars[bytes[i] % chars.length];
  return out;
}
