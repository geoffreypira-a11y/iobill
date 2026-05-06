// IO BILL - VIES TVA intracom validation
// Documentation: https://ec.europa.eu/taxation_customs/vies/

import { authenticate, json } from "./_lib/supabase-admin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const vatNumber = (body?.vat_number || "").replace(/\s/g, "").toUpperCase();
  if (!vatNumber || vatNumber.length < 4) {
    return json(res, 400, { error: "VAT number required" });
  }

  const country = vatNumber.slice(0, 2);
  const number = vatNumber.slice(2);

  // VIES public REST endpoint (Commission europeenne)
  try {
    const r = await fetch(
      "https://ec.europa.eu/taxation_customs/vies/rest-api/ms/" + country + "/vat/" + number,
      { headers: { Accept: "application/json" } }
    );
    if (!r.ok) {
      return json(res, 200, { valid: false, error: "VIES service unavailable" });
    }
    const data = await r.json();
    return json(res, 200, {
      valid: !!data.isValid,
      country,
      number,
      name: data.name || null,
      address: data.address || null,
      checked_at: new Date().toISOString()
    });
  } catch (e) {
    return json(res, 200, { valid: false, error: "VIES network error" });
  }
}
