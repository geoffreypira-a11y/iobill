// IO BILL — Sauvegarde des données
// ═══════════════════════════════════════════════════════════════════
// Module partagé par deux appelants :
//   • api/admin.js action `backup_save` — déclenchement manuel par l'admin
//   • api/backup-cron.js               — déclenchement quotidien par Vercel
//
// Le plan Supabase gratuit n'offre AUCUNE sauvegarde automatique
// restaurable. Ces fichiers sont donc la seule protection des données.
//
// Rotation plutôt qu'écrasement : un fichier daté par jour, les 30
// derniers conservés. Une sauvegarde qui écrase ne protège que des
// pannes remarquées sous 24 h — or une perte silencieuse (ligne effacée,
// champ vidé par un bug) se découvre des jours plus tard, quand la bonne
// copie a déjà été remplacée par l'état abîmé.

import { sbAdmin } from "./supabase-admin.js";

const SUPA_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SR_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const srHeaders = () => ({
  apikey: SR_KEY,
  Authorization: `Bearer ${SR_KEY}`,
  "Content-Type": "application/json"
});

export const KEEP_DAYS = 30;

// Tables rattachées à une société, sauvegardées société par société.
//
// `document_lines` est VITALE : les lignes des factures, devis et avoirs
// n'existent QUE là — `invoices` ne porte aucun instantané des lignes.
// Sans elle, une facture restaurée a un numéro, une date et un total,
// mais pas une seule désignation. Elle n'est alors plus une facture au
// sens de l'art. 242 nonies A CGI.
export const COMPANY_TABLES = [
  "invoices",
  "credit_notes",
  "quotes",
  "document_lines",      // lignes des trois documents ci-dessus
  "clients",
  "purchases",
  "payments",            // encaissements — sans eux, on ne sait plus qui a payé
  "vat_returns",
  "urssaf_returns",
  "bank_statements",
  "pa_events",           // piste d'audit des transmissions PDP
  "pa_inbound_invoices",
  "support_tickets"
];

// Tables non rattachées à une société : cabinets comptables et liens.
// Sans elles, une restauration perdrait tous les rattachements
// cabinet ↔ client.
export const GLOBAL_TABLES = [
  "accounting_firms",
  "firm_members",
  "firm_client_links"
];

/**
 * Construit l'objet de sauvegarde complet.
 *
 * Chaque table est lue via le service_role (RLS contournée). Une table
 * absente ou en erreur renvoie [] plutôt que de faire échouer la
 * sauvegarde — mais le manifeste enregistre le compte réel, pour qu'une
 * table vide se voie au lieu de passer inaperçue.
 */
export async function buildBackup(backupType = "manual") {
  const companies = await sbAdmin.select("companies", { order: "created_at.asc" });
  const manifest = {};
  const bump = (t, n) => { manifest[t] = (manifest[t] || 0) + n; };

  const backup = {
    version: "2.0",
    platform: "iobill",
    backup_date: new Date().toISOString(),
    backup_type: backupType,
    total_companies: (companies || []).length,
    companies: [],
    global: {},
    manifest: {}
  };

  for (const c of companies || []) {
    // v8.184 — La ligne `companies` est copiée EN ENTIER. Elle ne l'était
    // qu'en 8 champs : adresse, n° de TVA, IBAN, mentions légales, régime
    // de TVA et compteurs de numérotation étaient perdus à la
    // restauration — la société repartait sans son identité de facturation.
    const cData = { ...c, data: {} };
    for (const t of COMPANY_TABLES) {
      const rows = await sbAdmin.select(t, {
        filter: `company_id=eq.${c.id}`,
        order: "created_at.asc"
      }) || [];
      cData.data[t] = rows;
      bump(t, rows.length);
    }
    backup.companies.push(cData);
  }

  for (const t of GLOBAL_TABLES) {
    const rows = await sbAdmin.select(t, { order: "created_at.asc" }) || [];
    backup.global[t] = rows;
    bump(t, rows.length);
  }

  bump("companies", (companies || []).length);
  backup.manifest = manifest;
  return backup;
}

/** Liste les fichiers du bucket `backups`. */
export async function listBackups(limit = 200) {
  const r = await fetch(`${SUPA_URL}/storage/v1/object/list/backups`, {
    method: "POST",
    headers: srHeaders(),
    body: JSON.stringify({ prefix: "", limit, sortBy: { column: "name", order: "desc" } })
  });
  if (!r.ok) return [];
  const files = await r.json();
  return Array.isArray(files) ? files : [];
}

/**
 * Supprime les sauvegardes datées de plus de KEEP_DAYS jours.
 * `backup_latest.json` n'est jamais touché.
 */
export async function purgeOldBackups(keepDays = KEEP_DAYS) {
  const files = await listBackups(1000);
  const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString().slice(0, 10);
  const doomed = files
    .map((f) => f.name)
    .filter((name) => {
      const m = /^backup_(\d{4}-\d{2}-\d{2})/.exec(name || "");
      return m && m[1] < cutoff;
    });

  const purged = [];
  for (const name of doomed) {
    const r = await fetch(`${SUPA_URL}/storage/v1/object/backups/${name}`, {
      method: "DELETE",
      headers: srHeaders()
    });
    if (r.ok) purged.push(name);
  }
  return purged;
}

/**
 * Construit, dépose et fait tourner la sauvegarde.
 * Écrit deux objets : le fichier daté du jour (conservé KEEP_DAYS jours)
 * et `backup_latest.json` (écrasé à chaque passage, pour l'affichage et
 * le téléchargement rapide).
 */
export async function saveBackup(backupType = "manual") {
  const backup = await buildBackup(backupType);
  const jsonStr = JSON.stringify(backup);
  const filename = `backup_${new Date().toISOString().slice(0, 10)}.json`;

  const upR = await fetch(`${SUPA_URL}/storage/v1/object/backups/${filename}`, {
    method: "POST",
    headers: { ...srHeaders(), "x-upsert": "true" },
    body: jsonStr
  });
  if (!upR.ok) {
    const t = await upR.text().catch(() => "");
    throw new Error("Backup upload failed: " + t);
  }

  await fetch(`${SUPA_URL}/storage/v1/object/backups/backup_latest.json`, {
    method: "POST",
    headers: { ...srHeaders(), "x-upsert": "true" },
    body: jsonStr
  });

  const purged = await purgeOldBackups();

  return {
    ok: true,
    filename,
    backup_type: backupType,
    total_companies: backup.total_companies,
    size_kb: Math.round(jsonStr.length / 1024),
    manifest: backup.manifest,
    purged: purged.length
  };
}
