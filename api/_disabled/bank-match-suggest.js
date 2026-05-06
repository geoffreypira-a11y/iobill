// IO BILL - Auto-lettrage bancaire (matching IA)
// Analyse les bank_transactions non rapprochees et suggere des matches avec
// les invoices ou purchases. Utilise Mistral pour les cas complexes (libelle ambigu).
//
// Strategie hybride :
//   1) Match exact : meme montant + date proche -> confidence 0.95+ direct
//   2) Match flou : libelle contient n° facture / nom client -> 0.7-0.95
//   3) IA Mistral : pour les transactions ambigues (10-20 plus probables)
//
// Stocke les suggestions dans bank_match_suggestions (status = pending).
// L'utilisateur valide via /api/bank-match-confirm.

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { company } = auth;

  // 1) Recuperer les transactions non rapprochees (90 derniers jours)
  const since = new Date(Date.now() - 90 * 86400 * 1000).toISOString().slice(0, 10);
  const txs = await sbAdmin.select("bank_transactions", {
    filter: `company_id=eq.${company.id}&matched_invoice_id=is.null&matched_purchase_id=is.null&transaction_date=gte.${since}`,
    order: "transaction_date.desc",
    limit: 500
  });

  if (!txs || txs.length === 0) {
    return json(res, 200, { ok: true, suggestions: 0, scanned: 0 });
  }

  // 2) Recuperer les factures/achats candidats (impayes ou payes recemment)
  const [invoices, purchases] = await Promise.all([
    sbAdmin.select("invoices", {
      filter: `company_id=eq.${company.id}&status=in.(issued,sent,partial,overdue)`,
      select: "id,number,total_ttc_cents,paid_cents,issue_date,due_date,client_snapshot",
      limit: 500
    }),
    sbAdmin.select("purchases", {
      filter: `company_id=eq.${company.id}&status=in.(validated,draft)`,
      select: "id,document_number,supplier_name,total_ttc_cents,issue_date",
      limit: 500
    })
  ]);

  // 3) Pour chaque transaction, calculer les meilleurs matches
  let suggestionsCreated = 0;
  for (const tx of txs) {
    // Skip si on a deja une suggestion pending
    const existing = await sbAdmin.selectOne(
      "bank_match_suggestions",
      `bank_transaction_id=eq.${tx.id}&status=eq.pending`
    );
    if (existing) continue;

    const candidates = scoreMatches(tx, invoices || [], purchases || []);
    if (candidates.length === 0) continue;

    const top = candidates[0];

    // Insert suggestion
    await sbAdmin.insert("bank_match_suggestions", {
      company_id: company.id,
      bank_transaction_id: tx.id,
      match_type: top.type,
      match_id: top.id,
      confidence_score: top.score,
      reasoning: top.reasoning,
      status: "pending"
    });
    suggestionsCreated++;
  }

  return json(res, 200, { ok: true, suggestions: suggestionsCreated, scanned: txs.length });
}

// ──────────────────────────────────────────────────────────────
// Scoring algorithmique (sans IA pour V1.3)
// ──────────────────────────────────────────────────────────────
function scoreMatches(tx, invoices, purchases) {
  const candidates = [];
  const txAmount = Math.abs(tx.amount_cents);
  const txDate = new Date(tx.transaction_date);
  const txLabel = (tx.label || "").toLowerCase();

  // Sens : credit (tx.amount > 0) -> facture cliente | debit (< 0) -> achat
  const isCredit = tx.amount_cents > 0;

  if (isCredit) {
    for (const inv of invoices) {
      const remaining = (inv.total_ttc_cents || 0) - (inv.paid_cents || 0);
      if (remaining <= 0) continue;

      let score = 0;
      const reasons = [];

      // Match montant exact
      if (txAmount === remaining) { score += 0.5; reasons.push("Montant exact (reste à payer)"); }
      else if (txAmount === inv.total_ttc_cents) { score += 0.4; reasons.push("Montant exact (TTC)"); }
      else if (Math.abs(txAmount - remaining) < 100) { score += 0.3; reasons.push("Montant très proche"); }
      else if (txAmount < remaining * 1.05 && txAmount > remaining * 0.5) { score += 0.1; reasons.push("Acompte plausible"); }

      // Match date (proche de l'echeance ou de l'emission)
      const dueDate = inv.due_date ? new Date(inv.due_date) : null;
      const issueDate = inv.issue_date ? new Date(inv.issue_date) : null;
      if (dueDate && Math.abs(txDate - dueDate) < 30 * 86400 * 1000) {
        score += 0.15; reasons.push("Près de l'échéance");
      } else if (issueDate && Math.abs(txDate - issueDate) < 60 * 86400 * 1000) {
        score += 0.1;
      }

      // Match libelle : numero facture ou nom client
      if (inv.number && txLabel.includes(String(inv.number).toLowerCase())) {
        score += 0.3; reasons.push(`Numéro de facture ${inv.number} dans le libellé`);
      }
      const clientName = clientNameOf(inv.client_snapshot);
      if (clientName && txLabel.includes(clientName.toLowerCase().slice(0, 8))) {
        score += 0.2; reasons.push(`Nom client "${clientName}" dans le libellé`);
      }

      if (score >= 0.4) {
        candidates.push({
          type: "invoice",
          id: inv.id,
          score: Math.min(score, 1.0),
          reasoning: reasons.join(" · ")
        });
      }
    }
  } else {
    // Debit -> achat fournisseur
    for (const p of purchases) {
      let score = 0;
      const reasons = [];

      if (txAmount === p.total_ttc_cents) { score += 0.5; reasons.push("Montant exact"); }
      else if (Math.abs(txAmount - p.total_ttc_cents) < 100) { score += 0.3; reasons.push("Montant proche"); }

      const issueDate = p.issue_date ? new Date(p.issue_date) : null;
      if (issueDate && Math.abs(txDate - issueDate) < 60 * 86400 * 1000) {
        score += 0.15; reasons.push("Date proche émission");
      }

      const supplier = (p.supplier_name || "").toLowerCase();
      if (supplier && txLabel.includes(supplier.slice(0, 8))) {
        score += 0.3; reasons.push(`Fournisseur "${p.supplier_name}" dans le libellé`);
      }

      if (score >= 0.4) {
        candidates.push({
          type: "purchase",
          id: p.id,
          score: Math.min(score, 1.0),
          reasoning: reasons.join(" · ")
        });
      }
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

function clientNameOf(snapshot) {
  if (!snapshot) return "";
  if (snapshot.legal_name) return snapshot.legal_name;
  return `${snapshot.first_name || ""} ${snapshot.last_name || ""}`.trim();
}
