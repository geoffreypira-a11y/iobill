// IO BILL — Helper de synchronisation automatique de la déclaration TVA
// du mois en cours.
//
// À appeler dès qu'une facture/achat est créé, validé, ou modifié.
// Fait un fetch des montants actuels + un upsert sur vat_returns.

import { sb } from "./supabase.js";

/**
 * Calcule la période TVA en cours pour un régime donné.
 */
export function computeCurrentVatPeriod(regime) {
  const now = new Date();
  if (regime === "normal_monthly") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  if (regime === "normal_quarterly") {
    const m = now.getMonth();
    const qStartMonth = m < 3 ? 0 : m < 6 ? 3 : m < 9 ? 6 : 9;
    const start = new Date(now.getFullYear(), qStartMonth, 1);
    const end = new Date(now.getFullYear(), qStartMonth + 3, 0);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  if (regime === "simplified") {
    const start = new Date(now.getFullYear(), 0, 1);
    const end = new Date(now.getFullYear(), 11, 31);
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  return null;
}

/**
 * Synchronise la ligne vat_returns "in_progress" du mois en cours pour
 * une company. Doit être appelé après chaque création/validation/édition
 * d'une facture ou d'un achat.
 *
 * - Si rien dans le mois → ne fait rien.
 * - Si la ligne du mois existe en in_progress → MAJ avec les nouveaux montants.
 * - Si elle n'existe pas → crée une nouvelle ligne in_progress.
 * - Si elle existe en ready/declared/paid → ne touche pas (mois clos/transmis).
 *
 * Tolérant aux erreurs : log + return null en cas de souci, sans bloquer
 * le flow appelant.
 */
export async function syncVatCurrentPeriod(token, company) {
  try {
    if (!token || !company?.id || !company.vat_regime || company.vat_regime === "franchise") {
      return null;
    }
    const period = computeCurrentVatPeriod(company.vat_regime);
    if (!period) return null;

    // 1) Charger factures + achats de la période
    const [invoices, purchases] = await Promise.all([
      sb.select(token, "invoices", {
        filter: `company_id=eq.${company.id}&status=in.(issued,sent,partial,paid,overdue)&issue_date=gte.${period.start}&issue_date=lte.${period.end}`,
        order: "issue_date.desc",
        limit: 500
      }),
      sb.select(token, "purchases", {
        filter: `company_id=eq.${company.id}&status=in.(validated,paid,partial,pending)&issue_date=gte.${period.start}&issue_date=lte.${period.end}`,
        order: "issue_date.desc",
        limit: 500
      })
    ]);

    // 2) Calculs
    const invs = invoices || [];
    const purs = purchases || [];
    const collectedVAT = invs.reduce((s, i) => s + (i.vat_total_cents || 0), 0);
    const collectedHT = invs.reduce((s, i) => s + (i.subtotal_ht_cents || 0), 0);

    let deductibleVAT = 0;
    purs.forEach((p) => {
      if (p.status === "paid") {
        deductibleVAT += p.vat_total_cents || 0;
      } else if (p.status === "partial" && p.total_ttc_cents > 0) {
        const ratio = (p.paid_amount_cents || 0) / p.total_ttc_cents;
        deductibleVAT += Math.round((p.vat_total_cents || 0) * ratio);
      }
    });

    // Breakdown par taux
    const breakdownMap = {};
    invs.forEach((i) => {
      (i.vat_breakdown || []).forEach((br) => {
        const k = `${br.rate}`;
        if (!breakdownMap[k]) breakdownMap[k] = { rate: br.rate, base_cents: 0, vat_cents: 0 };
        breakdownMap[k].base_cents += br.base_cents || 0;
        breakdownMap[k].vat_cents += br.vat_cents || 0;
      });
    });
    const breakdown = Object.values(breakdownMap).sort((a, b) => a.rate - b.rate);

    // 3) Skip si rien dans la période
    if (collectedHT === 0 && deductibleVAT === 0) return null;

    // 4) Vérifier si une ligne existe pour cette période
    const existing = await sb.select(token, "vat_returns", {
      filter: `company_id=eq.${company.id}&period_start=eq.${period.start}&period_end=eq.${period.end}`,
      limit: 1
    });
    const existingRow = existing && existing[0];

    // Ne pas toucher si déjà declared/paid (transmis irrévocablement)
    // Si la ligne est en "ready" mais que la période est encore en cours,
    // on la rebascule en "in_progress" et on MAJ les montants.
    if (
      existingRow &&
      (existingRow.status === "declared" || existingRow.status === "paid")
    ) {
      return existingRow;
    }

    const formType = company.vat_regime === "simplified" ? "CA12" : "CA3";
    const payload = {
      company_id: company.id,
      period_start: period.start,
      period_end: period.end,
      form_type: formType,
      collected_vat_cents: collectedVAT,
      deductible_vat_cents: deductibleVAT,
      net_vat_cents: collectedVAT - deductibleVAT,
      taxable_base_cents: collectedHT,
      breakdown,
      status: "in_progress",
      snapshot: {
        invoices_count: invs.length,
        purchases_count: purs.length,
        updated_at: new Date().toISOString()
      }
    };

    let result;
    if (existingRow) {
      result = await sb.update(token, "vat_returns", `id=eq.${existingRow.id}`, payload);
    } else {
      result = await sb.insert(token, "vat_returns", payload);
    }
    return (result && result[0]) || null;
  } catch (e) {
    // On ne bloque jamais le flow appelant
    console.warn("[syncVatCurrentPeriod] erreur:", e?.message || e);
    return null;
  }
}
