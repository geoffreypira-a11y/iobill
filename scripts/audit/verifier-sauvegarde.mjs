#!/usr/bin/env node
// Vérifie qu'un fichier de sauvegarde IO BILL est exploitable.
//
//   node scripts/audit/verifier-sauvegarde.mjs ~/Téléchargements/iobill_backup_2026-09-10.json
//
// Ne restaure rien, n'écrit rien : il lit et il juge. À passer sur un
// fichier téléchargé depuis l'admin, avant de considérer qu'on est
// couvert. Le plan Supabase gratuit n'offrant aucune sauvegarde
// automatique restaurable, ce fichier est la seule protection —
// autant savoir ce qu'il contient AVANT d'en avoir besoin.

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("Usage: node scripts/audit/verifier-sauvegarde.mjs <fichier.json>");
  process.exit(2);
}

let backup;
try {
  backup = JSON.parse(readFileSync(path, "utf8"));
} catch (e) {
  console.error(`❌ Fichier illisible : ${e.message}`);
  process.exit(1);
}

const problemes = [];
const alertes = [];

console.log(`\nFichier   : ${path}`);
console.log(`Version   : ${backup.version || "?"} · ${backup.platform || "?"}`);
console.log(`Daté du   : ${backup.backup_date || "?"} (${backup.backup_type || "type inconnu"})`);

// Âge — une sauvegarde de plus d'une semaine sur un cron quotidien
// signifie que le cron ne tourne plus.
if (backup.backup_date) {
  const jours = Math.floor((Date.now() - new Date(backup.backup_date)) / 86400000);
  console.log(`Âge       : ${jours} jour(s)`);
  if (jours > 7) problemes.push(`La sauvegarde a ${jours} jours — le cron quotidien ne tourne plus.`);
  else if (jours > 2) alertes.push(`La sauvegarde a ${jours} jours.`);
}

const companies = backup.companies || [];
console.log(`Abonnés   : ${companies.length}`);
if (companies.length === 0) problemes.push("Aucun abonné dans la sauvegarde.");

// ── Contenu réel, table par table ──────────────────────────────────
const total = {};
for (const c of companies) {
  for (const [t, rows] of Object.entries(c.data || {})) {
    total[t] = (total[t] || 0) + (Array.isArray(rows) ? rows.length : 0);
  }
}
for (const [t, rows] of Object.entries(backup.global || {})) {
  total[t] = (total[t] || 0) + (Array.isArray(rows) ? rows.length : 0);
}

console.log("\nContenu :");
for (const t of Object.keys(total).sort()) {
  console.log(`  ${t.padEnd(22)} ${String(total[t]).padStart(6)}`);
}

// ── Les vérifications qui comptent ─────────────────────────────────

// 1. Une facture sans ses lignes n'est pas une facture (art. 242 nonies A).
const nbDocs = (total.invoices || 0) + (total.credit_notes || 0) + (total.quotes || 0);
if (nbDocs > 0 && !(total.document_lines > 0)) {
  problemes.push(
    `${nbDocs} document(s) sauvegardé(s) mais AUCUNE ligne (document_lines). ` +
    `Les factures restaurées seraient vides de contenu.`
  );
}

// 2. La ligne `companies` doit être complète, pas un extrait.
for (const c of companies) {
  const champs = Object.keys(c).filter((k) => k !== "data");
  if (champs.length < 15) {
    problemes.push(
      `La société « ${c.legal_name || c.id} » n'a que ${champs.length} champs sauvegardés : ` +
      `adresse, TVA, IBAN et compteurs de numérotation sont probablement absents.`
    );
    break;
  }
  if (!c.siret) alertes.push(`La société « ${c.legal_name || c.id} » n'a pas de SIRET.`);
}

// 3. Cohérence : des factures payées sans aucun encaissement.
const payees = companies.flatMap((c) => c.data?.invoices || [])
  .filter((i) => i.status === "paid" || (i.paid_cents || 0) > 0).length;
if (payees > 0 && !(total.payments > 0)) {
  alertes.push(`${payees} facture(s) marquée(s) payée(s) mais aucun encaissement (payments) sauvegardé.`);
}

// 4. Chaîne de hachage anti-fraude : présente sur les documents émis ?
const emises = companies.flatMap((c) => c.data?.invoices || [])
  .filter((i) => i.status && i.status !== "draft");
const sansHash = emises.filter((i) => !i.content_hash).length;
if (emises.length > 0 && sansHash > 0) {
  alertes.push(`${sansHash}/${emises.length} facture(s) émise(s) sans content_hash.`);
}

// 5. Manifeste cohérent avec le contenu réellement présent.
if (backup.manifest) {
  for (const [t, n] of Object.entries(backup.manifest)) {
    if (t === "companies") continue;
    if ((total[t] || 0) !== n) {
      alertes.push(`Manifeste incohérent pour ${t} : annoncé ${n}, trouvé ${total[t] || 0}.`);
    }
  }
} else {
  alertes.push("Pas de manifeste — sauvegarde antérieure à la version 2.0.");
}

// ── Verdict ────────────────────────────────────────────────────────
console.log("");
for (const a of alertes)  console.log(`⚠️  ${a}`);
for (const p of problemes) console.log(`❌ ${p}`);

if (problemes.length === 0 && alertes.length === 0) {
  console.log("✅ Sauvegarde exploitable — rien à signaler.");
} else if (problemes.length === 0) {
  console.log(`\n✅ Sauvegarde exploitable, ${alertes.length} point(s) de vigilance.`);
} else {
  console.log(`\n❌ Sauvegarde NON exploitable en l'état — ${problemes.length} problème(s).`);
}
process.exit(problemes.length ? 1 : 0);
