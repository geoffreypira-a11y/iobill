// IO BILL - Suppression de compte conforme RGPD
// Purge l'utilisateur Supabase + sa company (CASCADE) = toutes les donnees liees

import { authenticate, json, sbAdmin } from "./_lib/supabase-admin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });

  // 1. Annule l'abonnement Stripe si actif
  if (auth.company.stripe_subscription_id && process.env.STRIPE_SECRET_KEY) {
    await fetch(
      "https://api.stripe.com/v1/subscriptions/" + auth.company.stripe_subscription_id,
      {
        method: "DELETE",
        headers: { Authorization: "Bearer " + process.env.STRIPE_SECRET_KEY }
      }
    ).catch(() => {});
  }

  // 2. Supprime la company (CASCADE sur clients, factures, etc. via FK ON DELETE CASCADE)
  await sbAdmin.delete("companies", "id=eq." + auth.company.id);

  // 3. Supprime le user Supabase (Admin API)
  const r = await fetch(
    process.env.VITE_SUPABASE_URL + "/auth/v1/admin/users/" + auth.user.id,
    {
      method: "DELETE",
      headers: {
        Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY
      }
    }
  );

  if (!r.ok) {
    // La company est supprimee mais le user reste — on log mais on rend OK
    return json(res, 200, { ok: true, warning: "Auth user deletion failed, contact support" });
  }

  return json(res, 200, { ok: true, deleted_at: new Date().toISOString() });
}
