// IO BILL — Sauvegarde quotidienne automatique
// ═══════════════════════════════════════════════════════════════════
// Déclenché par le cron Vercel déclaré dans vercel.json.
//
// Pourquoi un endpoint séparé de `api/admin.js` : l'action `backup_save`
// y est protégée par `authenticate()`, qui exige le jeton d'un admin
// CONNECTÉ. Un cron n'a pas de session — il ne peut structurellement pas
// appeler cette action. D'où cette route, authentifiée autrement.
//
// Deux authentifications acceptées, comme api/cron-reminders.js :
//   • header `x-vercel-cron: 1`, injecté par Vercel sur ses propres appels
//   • `Authorization: Bearer <CRON_SECRET>`, pour un déclenchement manuel

import { saveBackup } from "./_lib/backup.js";

const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  const isVercelCron = req.headers["x-vercel-cron"] === "1";
  const auth = req.headers.authorization || "";
  const hasSecret = CRON_SECRET && auth === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !hasSecret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const result = await saveBackup(isVercelCron ? "cron" : "manual_secret");
    console.log("[backup-cron] OK", JSON.stringify({
      filename: result.filename,
      size_kb: result.size_kb,
      companies: result.total_companies,
      purged: result.purged,
      manifest: result.manifest
    }));
    return res.status(200).json(result);
  } catch (e) {
    // Un échec doit être bruyant : c'est la seule protection des données
    // sur le plan Supabase gratuit.
    console.error("[backup-cron] ÉCHEC", e?.stack || e?.message);
    return res.status(500).json({ error: e?.message || "Échec de la sauvegarde" });
  }
}
