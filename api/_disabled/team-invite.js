// IO BILL - Inviter un utilisateur dans une company
// 1) Cree une ligne company_users avec invited_email + invited_at, sans user_id
// 2) Envoie un email (Resend) avec un lien d'inscription
// 3) Quand le destinataire signup avec cet email, on resoud la ligne (cron OU trigger)

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.RESEND_FROM || "facturation@iobill.fr";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://iobill.fr";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { company, user } = auth;

  // Verifier que le user est owner ou admin
  const me = await sbAdmin.selectOne(
    "company_users",
    `company_id=eq.${company.id}&user_id=eq.${user.id}`
  );
  if (!me || !["owner", "admin"].includes(me.role)) {
    return json(res, 403, { error: "Only owner/admin can invite" });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const email = String(body?.email || "").toLowerCase().trim();
  const role = body?.role || "readonly";

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json(res, 400, { error: "Invalid email" });
  }
  if (!["admin", "accountant", "readonly"].includes(role)) {
    return json(res, 400, { error: "Invalid role" });
  }

  // Doublon ?
  const existing = await sbAdmin.selectOne(
    "company_users",
    `company_id=eq.${company.id}&invited_email=eq.${encodeURIComponent(email)}`
  );
  if (existing) {
    return json(res, 400, { error: "Cet email est déjà invité ou membre." });
  }

  // 1) Insert (user_id NULL — sera resolu apres signup)
  const created = await sbAdmin.insert("company_users", {
    company_id: company.id,
    user_id: null,
    role,
    invited_email: email,
    invited_at: new Date().toISOString()
  });

  if (!created || !created[0]) {
    return json(res, 500, { error: "Database insert failed" });
  }

  // 2) Email d'invitation
  if (RESEND_API_KEY) {
    const inviterName = user.email || "Un collaborateur";
    const subject = `Invitation à rejoindre ${company.legal_name} sur IO BILL`;
    const signupUrl = `${PUBLIC_BASE_URL}/?invite_email=${encodeURIComponent(email)}`;

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
    <div style="font-size:14px;line-height:1.6">
      Bonjour,<br><br>
      <strong>${escapeHtml(inviterName)}</strong> vous invite à rejoindre l'équipe de
      <strong>${escapeHtml(company.legal_name)}</strong> sur IO BILL.<br><br>
      Votre rôle : <strong>${escapeHtml(roleLabel(role))}</strong>
    </div>
    <div style="margin:28px 0">
      <a href="${signupUrl}" style="display:inline-block;background:#0b0c10;color:#d4a843;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:600">
        Créer mon compte
      </a>
    </div>
    <div style="font-size:11px;color:#888;margin-top:20px">
      Si vous avez déjà un compte IO BILL avec cet email, l'invitation sera automatiquement liée à la connexion suivante.
    </div>
  </div>
</body></html>`;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: `${company.legal_name} <${FROM_EMAIL}>`,
        to: [email],
        subject,
        html
      })
    }).catch(() => {});
  }

  return json(res, 200, { ok: true, member_id: created[0].id });
}

function roleLabel(r) {
  return { admin: "Administrateur", accountant: "Comptable", readonly: "Lecture seule" }[r] || r;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
