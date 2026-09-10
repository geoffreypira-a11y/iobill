// IO BILL — Sauvegarde quotidienne automatique
// ═══════════════════════════════════════════════════════════════════
// Déclenchement MANUEL de la sauvegarde, sans session admin.
//
// ⚠️ Cette route n'est PAS déclarée dans les `crons` de vercel.json :
// Vercel a refusé le déploiement de production quand le projet en
// déclarait deux. La sauvegarde quotidienne est donc lancée en fin de
// passage global par api/cron-reminders.js, qui tourne déjà chaque jour.
//
// Elle reste utile pour forcer une sauvegarde à la demande (incident,
// avant une migration) sans passer par l'interface admin :
//
//   curl -X POST https://iobill.vercel.app/api/backup-cron \
//        -H "Authorization: Bearer $CRON_SECRET"
//
// Deux authentifications acceptées :
//   • header `x-vercel-cron: 1`, si la route est un jour re-planifiée
//   • `Authorization: Bearer <CRON_SECRET>`

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
