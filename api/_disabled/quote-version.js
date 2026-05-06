// IO BILL - Dupliquer un devis pour creer une version v2/v3...
// Strategie : copier le devis original avec version+1, lier via root_quote_id,
// marquer l'original comme superseded_by_id.

import { authenticate, sbAdmin, json } from "./_lib/supabase-admin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });
  const { company } = auth;

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }

  const { quote_id } = body || {};
  if (!quote_id) return json(res, 400, { error: "quote_id required" });

  // 1) Charger le devis source
  const source = await sbAdmin.selectOne(
    "quotes",
    `id=eq.${quote_id}&company_id=eq.${company.id}`
  );
  if (!source) return json(res, 404, { error: "Quote not found" });

  // Verifier qu'on peut le versionner (pas un devis converti en facture)
  if (source.status === "converted") {
    return json(res, 400, { error: "Un devis converti en facture ne peut pas être versionné" });
  }

  // 2) Determiner le root et la prochaine version
  const rootId = source.root_quote_id || source.id;

  // Trouver le numero de version max dans la chaine
  const versions = await sbAdmin.select("quotes", {
    filter: `root_quote_id=eq.${rootId}`,
    select: "version",
    order: "version.desc",
    limit: 1
  });
  const maxVersion = (versions && versions[0]?.version) || source.version || 1;
  const newVersion = maxVersion + 1;

  // 3) Allouer un nouveau numero de devis
  const newNumber = await sbAdmin.rpc("allocate_document_number", {
    p_company_id: company.id,
    p_doc_type: "quote"
  });

  // 4) Copier les lignes du devis source
  const sourceLines = await sbAdmin.select("document_lines", {
    filter: `document_type=eq.quote&document_id=eq.${quote_id}`,
    order: "sort_order.asc"
  });

  // 5) Creer le nouveau devis (statut draft)
  const todayISO = new Date().toISOString().slice(0, 10);
  const expiresAt = new Date(Date.now() + (source.validity_days || 30) * 86400 * 1000)
    .toISOString().slice(0, 10);

  const newQuoteData = {
    company_id: company.id,
    client_id: source.client_id,
    client_snapshot: source.client_snapshot,
    company_snapshot: source.company_snapshot,
    number: newNumber,
    version: newVersion,
    root_quote_id: rootId,
    status: "draft",
    issue_date: todayISO,
    validity_days: source.validity_days,
    expires_at: expiresAt,
    subtotal_ht_cents: source.subtotal_ht_cents,
    vat_total_cents: source.vat_total_cents,
    total_ttc_cents: source.total_ttc_cents,
    vat_breakdown: source.vat_breakdown,
    currency: source.currency,
    vat_category: source.vat_category,
    vat_legal_mention: source.vat_legal_mention,
    notes: source.notes,
    terms: source.terms
  };

  const created = await sbAdmin.insert("quotes", newQuoteData);
  if (!created || !created[0]) return json(res, 500, { error: "Insert failed" });
  const newQuote = created[0];

  // 6) Copier les lignes
  if (sourceLines && sourceLines.length > 0) {
    const newLines = sourceLines.map((l) => ({
      company_id: company.id,
      document_type: "quote",
      document_id: newQuote.id,
      sort_order: l.sort_order,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unit_price_ht_cents: l.unit_price_ht_cents,
      vat_rate: l.vat_rate,
      discount_pct: l.discount_pct,
      line_ht_cents: l.line_ht_cents,
      line_vat_cents: l.line_vat_cents,
      line_ttc_cents: l.line_ttc_cents
    }));
    await sbAdmin.insert("document_lines", newLines);
  }

  // 7) Marquer la version source comme remplacee
  // (uniquement si statut est sent/refused — pas si signed/converted)
  if (["draft", "sent", "refused", "expired"].includes(source.status)) {
    await sbAdmin.update("quotes", `id=eq.${quote_id}`, {
      superseded_by_id: newQuote.id,
      superseded_at: new Date().toISOString()
    });
  }

  return json(res, 200, {
    ok: true,
    new_quote_id: newQuote.id,
    new_quote_number: newQuote.number,
    version: newVersion
  });
}
