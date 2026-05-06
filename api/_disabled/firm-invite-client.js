// IO BILL - Inviter une company a accepter la supervision par un cabinet
// Workflow :
// 1) Le partner d'un firm appelle cette route avec email + access_level
// 2) On cherche la company associee a cet email (via auth.users + companies.user_id)
// 3) On insere une ligne firm_clients en pending (accepted_at NULL)
// 4) On envoie un email a l'utilisateur avec un lien pour accepter

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.RESEND_FROM || "facturation@iobill.fr";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://iobill.fr";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { user } = auth;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const { firm_id, email, access_level = "viewer" } = body || {};
  if (!firm_id || !email) return json(res, 400, { error: "firm_id and email required" });
  if (!["viewer", "editor"].includes(access_level)) return json(res, 400, { error: "Invalid access_level" });

  // Verifier que l'utilisateur est bien partner du firm
  const fu = await sbAdmin.selectOne(
    "firm_users",
    `firm_id=eq.${firm_id}&user_id=eq.${user.id}&role=eq.partner`
  );
  if (!fu) return json(res, 403, { error: "Only partners can invite clients" });

  const firm = await sbAdmin.selectOne("firms", `id=eq.${firm_id}`);
  if (!firm) return json(res, 404, { error: "Firm not found" });

  // Limite max_clients
  if (firm.max_clients && firm.client_count >= firm.max_clients) {
    return json(res, 400, { error: `Limite de ${firm.max_clients} clients atteinte. Contactez le support pour augmenter.` });
  }

  // Trouver la company associee a cet email
  // 1) Chercher dans auth.users via la vue (Supabase managed n'expose pas auth.users directement)
  // 2) Fallback : chercher companies.email
  // En V1.1 on ne fait que la 2eme option (plus simple)
  const company = await sbAdmin.selectOne("companies", `email=eq.${encodeURIComponent(email.toLowerCase())}`);

  if (!company) {
    return json(res, 404, {
      error: "Aucune entreprise IO BILL trouvée avec cet email. Le client doit créer son compte avant que vous puissiez l'inviter."
    });
  }

  // Doublon ?
  const existing = await sbAdmin.selectOne(
    "firm_clients",
    `firm_id=eq.${firm_id}&company_id=eq.${company.id}&revoked_at=is.null`
  );
  if (existing) {
    return json(res, 400, { error: "Cette entreprise est déjà liée à votre cabinet (ou a une invitation en attente)." });
  }

  // Insert en pending
  const created = await sbAdmin.insert("firm_clients", {
    firm_id,
    company_id: company.id,
    access_level,
    invited_by: user.id,
    invited_at: new Date().toISOString(),
    accepted_at: null
  });

  if (!created || !created[0]) {
    return json(res, 500, { error: "Database insert failed" });
  }
  const inviteId = created[0].id;

  // Envoyer un email a l'utilisateur de la company
  if (RESEND_API_KEY) {
    const acceptUrl = `${PUBLIC_BASE_URL}/firm-invite/${inviteId}`;
    const accessLabel = access_level === "editor" ? "Édition" : "Lecture seule";

    const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,sans-serif;color:#222;background:#f5f4f0;padding:24px;margin:0">
  <div style="max-width:560px;margin:auto;background:#fff;border-radius:10px;padding:32px">
    <div style="font-family:'Syne',sans-serif;font-size:22px;letter-spacing:2px;font-weight:800;color:#0b0c10">
      IO<span style="color:#d4a843">BILL</span>
    </div>
    <div style="font-size:11px;color:#888;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:24px">
      Demande de supervision cabinet
    </div>
    <div style="font-size:14px;line-height:1.6">
      Bonjour,<br><br>
      Le cabinet <strong>${escapeHtml(firm.legal_name)}</strong> souhaite assurer le suivi
      comptable de votre entreprise <strong>${escapeHtml(company.legal_name)}</strong> via IO BILL.<br><br>
      Niveau d'accès demandé : <strong>${accessLabel}</strong>
    </div>
    <div style="margin:28px 0">
      <a href="${acceptUrl}" style="display:inline-block;background:#0b0c10;color:#d4a843;padding:14px 28px;text-decoration:none;border-radius:8px;font-weight:600">
        Voir la demande
      </a>
    </div>
    <div style="font-size:12px;color:#666;line-height:1.6">
      Vous pouvez accepter ou refuser cette demande. Vous pourrez révoquer l'accès à tout moment
      depuis votre interface IO BILL. Toutes les actions du cabinet seront tracées dans votre audit log.
    </div>
    <div style="font-size:11px;color:#888;margin-top:20px">
      Si vous n'attendiez pas cette demande, ignorez simplement cet email.
    </div>
  </div>
</body></html>`;

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: `IO BILL <${FROM_EMAIL}>`,
        to: [email],
        subject: `${firm.legal_name} demande à superviser votre comptabilité`,
        html
      })
    }).catch(() => {});
  }

  return json(res, 200, { ok: true, invite_id: inviteId });
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
