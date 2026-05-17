// Snapshot helpers: a chaque émission de devis/facture/avoir,
// on fige les coordonnées du client et de la société dans le document.
// Si la fiche client est modifiée plus tard, le document reste tel qu'il a été émis.

export function buildClientSnapshot(client) {
  if (!client) return null;
  return {
    client_id: client.id,
    client_type: client.client_type,
    legal_name: client.legal_name,
    first_name: client.first_name,
    last_name: client.last_name,
    siret: client.siret,
    vat_number: client.vat_number,
    email: client.email,
    phone: client.phone,
    contact_person: client.contact_person,
    address_line1: client.address_line1,
    address_line2: client.address_line2,
    postal_code: client.postal_code,
    city: client.city,
    country: client.country,
    snapshot_at: new Date().toISOString()
  };
}

export function buildCompanySnapshot(company) {
  if (!company) return null;
  return {
    company_id: company.id,
    legal_name: company.legal_name,
    trade_name: company.trade_name,
    legal_form: company.legal_form,
    siret: company.siret,
    rcs: company.rcs,
    vat_number: company.vat_number,
    ape_code: company.ape_code,
    address_line1: company.address_line1,
    address_line2: company.address_line2,
    postal_code: company.postal_code,
    city: company.city,
    country: company.country,
    email: company.email,
    phone: company.phone,
    website: company.website,
    iban: company.iban || null,
    bic: company.bic || null,
    bank_name: company.bank_name || null,
    vat_regime: company.vat_regime,
    snapshot_at: new Date().toISOString()
  };
}

export function snapshotDisplayName(snap) {
  if (!snap) return "—";
  if (snap.client_type === "individual") {
    return [snap.first_name, snap.last_name].filter(Boolean).join(" ").trim() || "Client";
  }
  return snap.legal_name || "Client";
}
