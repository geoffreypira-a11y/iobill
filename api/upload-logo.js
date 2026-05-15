// IO BILL - Upload du logo de l'entreprise
// Pattern repris d'IOcar : recoit une dataURL en POST, valide, upload vers Storage,
// renvoie l'URL signee et le chemin pour stockage en base.

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";

export const config = {
  api: { bodyParser: { sizeLimit: "3mb" } }
};

const BUCKET = "company-logos";
const MAX_BYTES = 2_000_000; // 2 Mo apres compression cote client
const ALLOWED_MIMES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { company } = auth;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const { dataUrl, filename } = body || {};
  if (!dataUrl || typeof dataUrl !== "string") {
    return json(res, 400, { error: "dataUrl requise" });
  }

  // Parse data:image/png;base64,xxxx
  const m = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!m) return json(res, 400, { error: "Format dataURL invalide" });
  const mime = m[1];
  const b64 = m[2];

  if (!ALLOWED_MIMES.includes(mime)) {
    return json(res, 400, { error: `Type d'image non autorise : ${mime}` });
  }

  const buf = Buffer.from(b64, "base64");
  if (buf.length > MAX_BYTES) {
    return json(res, 413, {
      error: `Fichier trop volumineux (${Math.round(buf.length / 1024)} Ko, max ${Math.round(MAX_BYTES / 1024)} Ko)`
    });
  }

  // Chemin : "{company_id}/logo.{ext}"
  const ext = mime.split("/")[1].replace("+xml", "").replace("jpeg", "jpg");
  const safeName = (filename || "logo").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 60);
  const path = `${company.id}/${safeName}-${Date.now()}.${ext}`;

  // Upload via service_role (bypass RLS Storage)
  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      "x-upsert": "true",
      "Content-Type": mime
    },
    body: buf
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text().catch(() => "");
    console.error("[upload-logo] Storage error:", uploadRes.status, errText);
    return json(res, 500, {
      error: "Erreur upload Storage",
      detail: errText.slice(0, 300)
    });
  }

  // Generer une URL signee (1h) pour preview immediate
  const signedRes = await fetch(`${supabaseUrl}/storage/v1/object/sign/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ expiresIn: 3600 })
  });

  let signedUrl = null;
  if (signedRes.ok) {
    const j = await signedRes.json();
    signedUrl = j.signedURL ? `${supabaseUrl}/storage/v1${j.signedURL}` : null;
  }

  // On stocke le path dans companies.logo_url (path Storage, pas URL)
  await sbAdmin.update("companies", `id=eq.${company.id}`, { logo_url: path });

  return json(res, 200, {
    ok: true,
    path,
    bucket: BUCKET,
    signed_url: signedUrl,
    size_bytes: buf.length
  });
}
