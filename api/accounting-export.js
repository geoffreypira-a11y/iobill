// IO BILL - Export comptable FEC (Fichier des Ecritures Comptables)
// Format normalise selon l'arrete du 29 juillet 2013 (art. A.47 A-1 LPF)

import { authenticate, json, sbAdmin } from "./_lib/supabase-admin.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

  const auth = await authenticate(req);
  if (auth.error) return json(res, auth.status, { error: auth.error });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { format = "fec", period_start, period_end } = body || {};
  if (!period_start || !period_end) return json(res, 400, { error: "Period required" });

  // Recupere factures + paiements + achats sur la periode
  const [invoices, payments, purchases] = await Promise.all([
    sbAdmin.select("invoices", {
      filter:
        "company_id=eq." + auth.company.id +
        "&status=in.(issued,sent,partial,paid,overdue,canceled)" +
        "&issue_date=gte." + period_start +
        "&issue_date=lte." + period_end,
      order: "issue_date.asc"
    }),
    sbAdmin.select("payments", {
      filter:
        "company_id=eq." + auth.company.id +
        "&paid_at=gte." + period_start +
        "&paid_at=lte." + period_end,
      order: "paid_at.asc"
    }),
    sbAdmin.select("purchases", {
      filter:
        "company_id=eq." + auth.company.id +
        "&status=in.(validated,paid)" +
        "&issue_date=gte." + period_start +
        "&issue_date=lte." + period_end,
      order: "issue_date.asc"
    })
  ]);

  let content = "";
  let rowCount = 0;
  let mime = "text/plain";
  let filename = "";

  if (format === "fec") {
    const fec = generateFEC(auth.company, invoices || [], payments || [], purchases || []);
    content = fec.content;
    rowCount = fec.rowCount;
    mime = "text/plain; charset=utf-8";
    filename = (auth.company.siret || auth.company.id) + "FEC" + period_end.replace(/-/g, "") + ".txt";
  } else if (format === "csv") {
    const csv = generateCSV(invoices || [], payments || [], purchases || []);
    content = csv.content;
    rowCount = csv.rowCount;
    mime = "text/csv";
    filename = "iobill-export-" + period_start + "-to-" + period_end + ".csv";
  } else if (format === "sage") {
    const r = generateSage(invoices || [], payments || [], purchases || []);
    // Sage requiert UTF-8 BOM + CRLF
    content = "\ufeff" + r.content;
    rowCount = r.rowCount;
    mime = "text/csv; charset=utf-8";
    filename = "sage-" + period_start + "-to-" + period_end + ".csv";
  } else if (format === "cegid") {
    const r = generateCegid(invoices || [], payments || [], purchases || []);
    content = r.content;
    rowCount = r.rowCount;
    mime = "text/csv; charset=utf-8";
    filename = "cegid-" + period_start + "-to-" + period_end + ".csv";
  } else if (format === "pennylane") {
    const r = generatePennylane(invoices || [], payments || [], purchases || []);
    content = r.content;
    rowCount = r.rowCount;
    mime = "text/csv; charset=utf-8";
    filename = "pennylane-" + period_start + "-to-" + period_end + ".csv";
  } else if (format === "pennylane_api" || format === "tiime_api") {
    return json(res, 503, { error: "API connector " + format + " not yet implemented. Coming soon." });
  } else {
    return json(res, 400, { error: "Unknown format: " + format });
  }

  // Upload dans le bucket Supabase Storage
  const path = auth.company.id + "/" + filename;
  const uploadRes = await fetch(
    process.env.VITE_SUPABASE_URL + "/storage/v1/object/accounting-exports/" + path,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        "x-upsert": "true",
        "Content-Type": mime
      },
      body: content
    }
  );

  // Crée signed URL (valable 1h)
  let fileUrl = null;
  if (uploadRes.ok) {
    const signRes = await fetch(
      process.env.VITE_SUPABASE_URL + "/storage/v1/object/sign/accounting-exports/" + path,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.SUPABASE_SERVICE_ROLE_KEY,
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ expiresIn: 3600 })
      }
    );
    if (signRes.ok) {
      const j = await signRes.json();
      fileUrl = process.env.VITE_SUPABASE_URL + "/storage/v1" + j.signedURL;
    }
  }

  // Enregistre dans accounting_exports
  const created = await sbAdmin.insert("accounting_exports", {
    company_id: auth.company.id,
    format,
    period_start,
    period_end,
    file_url: fileUrl,
    file_size: Buffer.byteLength(content),
    row_count: rowCount,
    status: fileUrl ? "ready" : "pending",
    generated_at: new Date().toISOString()
  });

  return json(res, 200, created?.[0] || { ok: true, file_url: fileUrl, row_count: rowCount });
}

// ─── FEC : Format Fichier des Ecritures Comptables ──────────
// 18 colonnes obligatoires, separateur tabulation
function generateFEC(company, invoices, payments, purchases) {
  const HEADERS = [
    "JournalCode", "JournalLib", "EcritureNum", "EcritureDate", "CompteNum",
    "CompteLib", "CompAuxNum", "CompAuxLib", "PieceRef", "PieceDate",
    "EcritureLib", "Debit", "Credit", "EcritureLet", "DateLet",
    "ValidDate", "Montantdevise", "Idevise"
  ];
  const lines = [HEADERS.join("\t")];
  let ecritureNum = 1;

  // VENTES (factures)
  for (const inv of invoices) {
    if (inv.status === "draft") continue;
    const date = (inv.issue_date || "").replace(/-/g, "");
    const validDate = (inv.issued_at?.slice(0, 10) || inv.issue_date || "").replace(/-/g, "");
    const num = String(ecritureNum++).padStart(6, "0");
    const clientName = sanitizeFEC(
      inv.client_snapshot?.legal_name ||
      [inv.client_snapshot?.first_name, inv.client_snapshot?.last_name].filter(Boolean).join(" ")
    );

    // Ligne client (411xxx) au debit
    lines.push([
      "VTE", "Ventes", num, date, "411000", "Clients",
      "C" + (inv.client_id || "").slice(0, 8), clientName,
      sanitizeFEC(inv.number), date,
      sanitizeFEC("Facture " + inv.number),
      fmtAmount(inv.total_ttc_cents), "0,00", "", "", validDate,
      "", ""
    ].join("\t"));

    // Vente HT (706000) au credit (par taux TVA)
    const breakdown = inv.vat_breakdown || [];
    if (breakdown.length === 0) {
      lines.push([
        "VTE", "Ventes", num, date, "706000", "Prestations de services",
        "", "", sanitizeFEC(inv.number), date,
        sanitizeFEC("Facture " + inv.number + " HT"),
        "0,00", fmtAmount(inv.subtotal_ht_cents), "", "", validDate,
        "", ""
      ].join("\t"));
    } else {
      for (const br of breakdown) {
        lines.push([
          "VTE", "Ventes", num, date, "706000", "Prestations de services",
          "", "", sanitizeFEC(inv.number), date,
          sanitizeFEC("Facture " + inv.number + " HT TVA " + br.rate + "%"),
          "0,00", fmtAmount(br.base_cents), "", "", validDate,
          "", ""
        ].join("\t"));
      }
      // TVA collectee (44571xxx)
      for (const br of breakdown) {
        if (br.vat_cents > 0) {
          lines.push([
            "VTE", "Ventes", num, date, vatAccount(br.rate), "TVA collectee " + br.rate + "%",
            "", "", sanitizeFEC(inv.number), date,
            sanitizeFEC("TVA Facture " + inv.number),
            "0,00", fmtAmount(br.vat_cents), "", "", validDate,
            "", ""
          ].join("\t"));
        }
      }
    }
  }

  // ENCAISSEMENTS
  for (const p of payments) {
    if (!p.invoice_id) continue;
    const date = (p.paid_at || "").replace(/-/g, "");
    const num = String(ecritureNum++).padStart(6, "0");
    const inv = invoices.find((i) => i.id === p.invoice_id);
    const clientName = inv ? sanitizeFEC(
      inv.client_snapshot?.legal_name ||
      [inv.client_snapshot?.first_name, inv.client_snapshot?.last_name].filter(Boolean).join(" ")
    ) : "";

    lines.push([
      "BNQ", "Banque", num, date, "512000", "Banque",
      "", "", sanitizeFEC(p.reference || (inv?.number || "")), date,
      sanitizeFEC("Encaissement " + (inv?.number || "")),
      fmtAmount(p.amount_cents), "0,00", "", "", date,
      "", ""
    ].join("\t"));
    lines.push([
      "BNQ", "Banque", num, date, "411000", "Clients",
      "C" + (inv?.client_id || "").slice(0, 8), clientName,
      sanitizeFEC(p.reference || (inv?.number || "")), date,
      sanitizeFEC("Encaissement " + (inv?.number || "")),
      "0,00", fmtAmount(p.amount_cents), "", "", date,
      "", ""
    ].join("\t"));
  }

  // ACHATS (factures fournisseurs)
  for (const pu of purchases) {
    const date = (pu.issue_date || "").replace(/-/g, "");
    const num = String(ecritureNum++).padStart(6, "0");
    const account = pu.accounting_code || "606300";

    lines.push([
      "ACH", "Achats", num, date, account, sanitizeFEC(pu.category || "Achat"),
      "", "", sanitizeFEC(pu.number || ""), date,
      sanitizeFEC("Achat " + pu.vendor_name),
      fmtAmount(pu.subtotal_ht_cents), "0,00", "", "", date,
      "", ""
    ].join("\t"));
    if (pu.vat_total_cents > 0) {
      lines.push([
        "ACH", "Achats", num, date, "445660", "TVA deductible",
        "", "", sanitizeFEC(pu.number || ""), date,
        sanitizeFEC("TVA Achat " + pu.vendor_name),
        fmtAmount(pu.vat_total_cents), "0,00", "", "", date,
        "", ""
      ].join("\t"));
    }
    lines.push([
      "ACH", "Achats", num, date, "401000", "Fournisseurs",
      "F" + (pu.vendor_siret || "").slice(0, 8), sanitizeFEC(pu.vendor_name),
      sanitizeFEC(pu.number || ""), date,
      sanitizeFEC("Achat " + pu.vendor_name),
      "0,00", fmtAmount(pu.total_ttc_cents), "", "", date,
      "", ""
    ].join("\t"));
  }

  return { content: lines.join("\n"), rowCount: lines.length - 1 };
}

function vatAccount(rate) {
  const r = Number(rate);
  if (r === 20) return "445712";
  if (r === 10) return "445713";
  if (r === 5.5) return "445714";
  if (r === 2.1) return "445715";
  return "445710";
}

function fmtAmount(cents) {
  if (!cents) return "0,00";
  return (cents / 100).toFixed(2).replace(".", ",");
}

function sanitizeFEC(s) {
  if (!s) return "";
  return String(s).replace(/[\t\n\r"]/g, " ").slice(0, 200);
}

function generateCSV(invoices, payments, purchases) {
  const headers = ["Type", "Date", "Numero", "Tiers", "Libelle", "HT", "TVA", "TTC"];
  const rows = [headers.join(";")];
  for (const inv of invoices) {
    if (inv.status === "draft") continue;
    rows.push([
      "Facture", inv.issue_date, inv.number,
      inv.client_snapshot?.legal_name || "",
      "Vente",
      fmtAmount(inv.subtotal_ht_cents),
      fmtAmount(inv.vat_total_cents),
      fmtAmount(inv.total_ttc_cents)
    ].map(csvEscape).join(";"));
  }
  for (const p of purchases) {
    rows.push([
      "Achat", p.issue_date, p.number || "",
      p.vendor_name, p.category || "Achat",
      fmtAmount(p.subtotal_ht_cents),
      fmtAmount(p.vat_total_cents),
      fmtAmount(p.total_ttc_cents)
    ].map(csvEscape).join(";"));
  }
  for (const py of payments) {
    rows.push([
      "Paiement", py.paid_at, py.reference || "",
      "", "Encaissement",
      "", "", fmtAmount(py.amount_cents)
    ].map(csvEscape).join(";"));
  }
  return { content: rows.join("\n"), rowCount: rows.length - 1 };
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(";") || s.includes("\"") || s.includes("\n")) {
    return "\"" + s.replace(/"/g, "\"\"") + "\"";
  }
  return s;
}

// ─── SAGE 100 / Sage Compta — format CSV import ─────────────
// Format Sage classique : Journal, Date, N° pièce, Compte, Libellé, Débit, Crédit, Tiers
// Séparateur ;  Decimal: virgule  Date: JJ/MM/AAAA  Encodage: UTF-8 BOM
function generateSage(invoices, payments, purchases) {
  const headers = ["Journal", "Date", "PieceRef", "Compte", "Tiers", "Libelle", "Debit", "Credit"];
  const rows = [headers.join(";")];

  for (const inv of invoices) {
    if (inv.status === "draft") continue;
    const date = formatSageDate(inv.issue_date);
    const tiers = "C" + (inv.client_id || "").slice(0, 6).toUpperCase();
    const lib = sanitize("Facture " + inv.number);

    // Client (411) au débit
    rows.push(["VTE", date, inv.number || "", "411000", tiers, lib, fmtSageAmount(inv.total_ttc_cents), "0,00"].map(sageEsc).join(";"));
    // Vente HT (706 ou 707) au crédit
    rows.push(["VTE", date, inv.number || "", "706000", "", lib + " HT", "0,00", fmtSageAmount(inv.subtotal_ht_cents)].map(sageEsc).join(";"));
    // TVA collectée par taux
    const breakdown = Array.isArray(inv.vat_breakdown) ? inv.vat_breakdown : [];
    for (const br of breakdown) {
      if (Number(br.vat_cents) > 0) {
        rows.push(["VTE", date, inv.number || "", vatAccount(br.rate), "", "TVA " + br.rate + "% " + lib, "0,00", fmtSageAmount(br.vat_cents)].map(sageEsc).join(";"));
      }
    }
  }

  for (const p of payments) {
    if (!p.invoice_id) continue;
    const date = formatSageDate(p.paid_at);
    const inv = invoices.find((i) => i.id === p.invoice_id);
    const tiers = "C" + (inv?.client_id || "").slice(0, 6).toUpperCase();
    const lib = sanitize("Encaissement " + (inv?.number || ""));
    rows.push(["BNQ", date, p.reference || "", "512000", "", lib, fmtSageAmount(p.amount_cents), "0,00"].map(sageEsc).join(";"));
    rows.push(["BNQ", date, p.reference || "", "411000", tiers, lib, "0,00", fmtSageAmount(p.amount_cents)].map(sageEsc).join(";"));
  }

  for (const pu of purchases) {
    const date = formatSageDate(pu.issue_date);
    const tiers = "F" + (pu.vendor_siret || "").slice(0, 6).toUpperCase();
    const lib = sanitize("Achat " + (pu.vendor_name || ""));
    const acct = pu.accounting_code || "606300";

    rows.push(["ACH", date, pu.number || "", acct, "", lib, fmtSageAmount(pu.subtotal_ht_cents), "0,00"].map(sageEsc).join(";"));
    if (pu.vat_total_cents > 0) {
      rows.push(["ACH", date, pu.number || "", "445660", "", "TVA " + lib, fmtSageAmount(pu.vat_total_cents), "0,00"].map(sageEsc).join(";"));
    }
    rows.push(["ACH", date, pu.number || "", "401000", tiers, lib, "0,00", fmtSageAmount(pu.total_ttc_cents)].map(sageEsc).join(";"));
  }

  return { content: rows.join("\r\n"), rowCount: rows.length - 1 };
}

// ─── CEGID Compta / CEGID Loop — format CSV ─────────────────
// Format Cegid : Code Journal, Date, N°Compte, Sens (D/C), Montant, Libellé, N°pièce, Tiers
// Date: JJMMAAAA  Decimal: point  Séparateur: ;
function generateCegid(invoices, payments, purchases) {
  const headers = ["Journal", "Date", "Compte", "Sens", "Montant", "Libelle", "Piece", "Tiers"];
  const rows = [headers.join(";")];

  for (const inv of invoices) {
    if (inv.status === "draft") continue;
    const date = formatCegidDate(inv.issue_date);
    const tiers = "C" + (inv.client_id || "").slice(0, 6).toUpperCase();
    const lib = sanitize("Fact " + inv.number);

    rows.push(["VTE", date, "411000", "D", fmtCegidAmount(inv.total_ttc_cents), lib, inv.number || "", tiers].map(cegidEsc).join(";"));
    rows.push(["VTE", date, "706000", "C", fmtCegidAmount(inv.subtotal_ht_cents), lib + " HT", inv.number || "", ""].map(cegidEsc).join(";"));
    const breakdown = Array.isArray(inv.vat_breakdown) ? inv.vat_breakdown : [];
    for (const br of breakdown) {
      if (Number(br.vat_cents) > 0) {
        rows.push(["VTE", date, vatAccount(br.rate), "C", fmtCegidAmount(br.vat_cents), "TVA " + br.rate + "%", inv.number || "", ""].map(cegidEsc).join(";"));
      }
    }
  }

  for (const p of payments) {
    if (!p.invoice_id) continue;
    const date = formatCegidDate(p.paid_at);
    const inv = invoices.find((i) => i.id === p.invoice_id);
    const tiers = "C" + (inv?.client_id || "").slice(0, 6).toUpperCase();
    const lib = sanitize("Reglt " + (inv?.number || ""));
    rows.push(["BNQ", date, "512000", "D", fmtCegidAmount(p.amount_cents), lib, p.reference || "", ""].map(cegidEsc).join(";"));
    rows.push(["BNQ", date, "411000", "C", fmtCegidAmount(p.amount_cents), lib, p.reference || "", tiers].map(cegidEsc).join(";"));
  }

  for (const pu of purchases) {
    const date = formatCegidDate(pu.issue_date);
    const tiers = "F" + (pu.vendor_siret || "").slice(0, 6).toUpperCase();
    const lib = sanitize("Achat " + (pu.vendor_name || ""));
    const acct = pu.accounting_code || "606300";
    rows.push(["ACH", date, acct, "D", fmtCegidAmount(pu.subtotal_ht_cents), lib, pu.number || "", ""].map(cegidEsc).join(";"));
    if (pu.vat_total_cents > 0) {
      rows.push(["ACH", date, "445660", "D", fmtCegidAmount(pu.vat_total_cents), "TVA " + lib, pu.number || "", ""].map(cegidEsc).join(";"));
    }
    rows.push(["ACH", date, "401000", "C", fmtCegidAmount(pu.total_ttc_cents), lib, pu.number || "", tiers].map(cegidEsc).join(";"));
  }

  return { content: rows.join("\r\n"), rowCount: rows.length - 1 };
}

// ─── PENNYLANE — format CSV import ──────────────────────────
// Doc Pennylane : https://help.pennylane.com/import-csv
// Colonnes : date, journal_code, account_number, label, partner_name, debit_amount, credit_amount, currency
function generatePennylane(invoices, payments, purchases) {
  const headers = [
    "date", "journal_code", "account_number", "label",
    "partner_name", "debit_amount", "credit_amount", "currency", "reference"
  ];
  const rows = [headers.join(",")];

  function pushRow(date, journal, account, label, partner, debit, credit, ref, currency) {
    rows.push([
      date,
      journal,
      account,
      pennylaneEsc(label),
      pennylaneEsc(partner || ""),
      debit ? (debit / 100).toFixed(2) : "0.00",
      credit ? (credit / 100).toFixed(2) : "0.00",
      currency || "EUR",
      pennylaneEsc(ref || "")
    ].join(","));
  }

  for (const inv of invoices) {
    if (inv.status === "draft") continue;
    const partner = inv.client_snapshot?.legal_name ||
      [inv.client_snapshot?.first_name, inv.client_snapshot?.last_name].filter(Boolean).join(" ") || "";

    pushRow(inv.issue_date, "VTE", "411000", "Facture " + inv.number, partner, inv.total_ttc_cents, 0, inv.number, inv.currency);
    pushRow(inv.issue_date, "VTE", "706000", "Vente HT " + inv.number, partner, 0, inv.subtotal_ht_cents, inv.number, inv.currency);
    const breakdown = Array.isArray(inv.vat_breakdown) ? inv.vat_breakdown : [];
    for (const br of breakdown) {
      if (Number(br.vat_cents) > 0) {
        pushRow(inv.issue_date, "VTE", vatAccount(br.rate), "TVA " + br.rate + "% " + inv.number, partner, 0, br.vat_cents, inv.number, inv.currency);
      }
    }
  }

  for (const p of payments) {
    if (!p.invoice_id) continue;
    const inv = invoices.find((i) => i.id === p.invoice_id);
    const partner = inv ? (inv.client_snapshot?.legal_name ||
      [inv.client_snapshot?.first_name, inv.client_snapshot?.last_name].filter(Boolean).join(" ")) : "";
    pushRow(p.paid_at, "BNQ", "512000", "Encaissement " + (inv?.number || ""), partner, p.amount_cents, 0, p.reference, "EUR");
    pushRow(p.paid_at, "BNQ", "411000", "Encaissement " + (inv?.number || ""), partner, 0, p.amount_cents, p.reference, "EUR");
  }

  for (const pu of purchases) {
    const acct = pu.accounting_code || "606300";
    pushRow(pu.issue_date, "ACH", acct, "Achat " + (pu.vendor_name || ""), pu.vendor_name, pu.subtotal_ht_cents, 0, pu.number, "EUR");
    if (pu.vat_total_cents > 0) {
      pushRow(pu.issue_date, "ACH", "445660", "TVA achat " + (pu.vendor_name || ""), pu.vendor_name, pu.vat_total_cents, 0, pu.number, "EUR");
    }
    pushRow(pu.issue_date, "ACH", "401000", "Achat " + (pu.vendor_name || ""), pu.vendor_name, 0, pu.total_ttc_cents, pu.number, "EUR");
  }

  return { content: rows.join("\n"), rowCount: rows.length - 1 };
}

// ──────────────────────────────────────────────────────────────
// Helpers de formatage
// ──────────────────────────────────────────────────────────────
function formatSageDate(iso) {
  if (!iso) return "";
  const d = String(iso).slice(0, 10);
  const [y, m, dd] = d.split("-");
  return `${dd}/${m}/${y}`;
}
function formatCegidDate(iso) {
  if (!iso) return "";
  const d = String(iso).slice(0, 10).replace(/-/g, "");
  return d.slice(6, 8) + d.slice(4, 6) + d.slice(0, 4);
}
function fmtSageAmount(cents) {
  if (!cents) return "0,00";
  return (Math.abs(cents) / 100).toFixed(2).replace(".", ",");
}
function fmtCegidAmount(cents) {
  if (!cents) return "0.00";
  return (Math.abs(cents) / 100).toFixed(2);
}
function sageEsc(v) {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(";") || s.includes('"') || s.includes("\n")) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function cegidEsc(v) {
  if (v == null) return "";
  const s = String(v);
  if (s.includes(";") || s.includes('"')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function pennylaneEsc(v) {
  if (v == null) return "";
  const s = String(v).slice(0, 200);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function sanitize(s) {
  if (!s) return "";
  return String(s).replace(/[\t\n\r]/g, " ").slice(0, 200);
}
