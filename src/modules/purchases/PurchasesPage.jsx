import React, { useEffect, useState } from "react";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { CameraCapture } from "../../components/CameraCapture.jsx";
import { fmtEUR, fmtDate, todayISO, toCents, fromCents, uid } from "../../lib/helpers.js";
import { capture, bumpModuleUsage } from "../../lib/telemetry.js";

const PURCHASE_STATUTS = {
  pending:   { label: "En attente",  cls: "badge-muted",  icon: "📥" },
  validated: { label: "Validée",     cls: "badge-gold",   icon: "✅" },
  paid:      { label: "Payée",       cls: "badge-green",  icon: "💰" },
  archived:  { label: "Archivée",    cls: "badge-muted",  icon: "📦" }
};

const ACCOUNTING_CODES = [
  { code: "606300", label: "Petites fournitures" },
  { code: "606400", label: "Fournitures administratives" },
  { code: "611000", label: "Sous-traitance" },
  { code: "613200", label: "Locations immobilières" },
  { code: "613300", label: "Hébergement web / cloud" },
  { code: "613500", label: "Locations mobilières" },
  { code: "615000", label: "Entretien et réparations" },
  { code: "616000", label: "Primes d'assurances" },
  { code: "618000", label: "Documentation, formation" },
  { code: "622600", label: "Honoraires" },
  { code: "623000", label: "Publicité, communication" },
  { code: "624000", label: "Transports" },
  { code: "625100", label: "Voyages, déplacements" },
  { code: "626000", label: "Frais postaux, télécoms" },
  { code: "627000", label: "Services bancaires" }
];

export function PurchasesPage({ token, company }) {
  const [purchases, setPurchases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  useEffect(() => {
    let alive = true;
    (async () => {
      const list = await sb.select(token, "purchases", {
        filter: `company_id=eq.${company.id}`,
        order: "issue_date.desc.nullslast"
      });
      if (alive) {
        setPurchases(list || []);
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [token, company.id]);

  const filtered = purchases.filter((p) => {
    const s = search.toLowerCase().trim();
    const matchS = !s || (p.vendor_name || "").toLowerCase().includes(s) || (p.number || "").toLowerCase().includes(s);
    const matchF = statusFilter === "all" || p.status === statusFilter;
    return matchS && matchF;
  });

  const totalHT = purchases
    .filter((p) => ["validated","paid","pending"].includes(p.status))
    .reduce((s, p) => s + (p.subtotal_ht_cents || 0), 0);
  const totalVAT = purchases
    .filter((p) => ["validated","paid"].includes(p.status))
    .reduce((s, p) => s + (p.vat_total_cents || 0), 0);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">ACHATS</div>
          <div className="page-sub">
            {purchases.length} facture{purchases.length !== 1 ? "s" : ""} fournisseur · Total HT : <span className="mono" style={{ color: "var(--gold)" }}>{fmtEUR(totalHT)}</span> · TVA déductible : <span className="mono">{fmtEUR(totalVAT)}</span>
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setEditing("add")}>
          <Icon name="plus" size={14} /> Nouvel achat
        </button>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 18, flexWrap: "wrap", alignItems: "center" }}>
        <input
          className="search-input"
          placeholder="Rechercher fournisseur, numéro..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="tabs" style={{ margin: 0 }}>
          <button className={"tab" + (statusFilter === "all" ? " active" : "")} onClick={() => setStatusFilter("all")}>Tous ({purchases.length})</button>
          {Object.entries(PURCHASE_STATUTS).map(([k, s]) => {
            const count = purchases.filter((p) => p.status === k).length;
            return count > 0 ? (
              <button key={k} className={"tab" + (statusFilter === k ? " active" : "")} onClick={() => setStatusFilter(k)}>
                {s.icon} {s.label} ({count})
              </button>
            ) : null;
          })}
        </div>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: 60, color: "var(--muted)" }}>Chargement...</div>
      ) : filtered.length === 0 ? (
        <div className="card card-pad" style={{ textAlign: "center", padding: "60px 20px" }}>
          {purchases.length === 0 ? (
            <>
              <div style={{ fontSize: 44, marginBottom: 14 }}>🛒</div>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Aucun achat enregistré</div>
              <div style={{ fontSize: 13, color: "var(--muted2)", marginBottom: 18 }}>
                Importez vos factures fournisseurs (PDF, photo) — l'OCR Mistral extrait les données automatiquement.
              </div>
              <button className="btn btn-primary" onClick={() => setEditing("add")}>
                <Icon name="upload" size={14} /> Importer un achat
              </button>
            </>
          ) : (
            <div style={{ color: "var(--muted2)", fontSize: 14 }}>Aucun achat ne correspond à votre recherche.</div>
          )}
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Fournisseur</th>
                <th>N° doc</th>
                <th>Catégorie</th>
                <th style={{ textAlign: "right" }}>HT</th>
                <th style={{ textAlign: "right" }}>TVA</th>
                <th style={{ textAlign: "right" }}>TTC</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id} style={{ cursor: "pointer" }} onClick={() => setEditing(p)}>
                  <td>{fmtDate(p.issue_date)}</td>
                  <td>
                    {p.vendor_name}
                    {p.ocr_status === "done" && (
                      <span style={{ marginLeft: 6, fontSize: 9, color: "var(--green)" }} title="OCR validé">🤖</span>
                    )}
                  </td>
                  <td className="mono">{p.number || "—"}</td>
                  <td>
                    {p.accounting_code && <span className="mono" style={{ fontSize: 11 }}>{p.accounting_code}</span>}
                    {p.category && <span style={{ marginLeft: 6, fontSize: 11, color: "var(--muted)" }}>{p.category}</span>}
                  </td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(p.subtotal_ht_cents)}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(p.vat_total_cents)}</td>
                  <td className="mono" style={{ textAlign: "right", fontWeight: 600 }}>{fmtEUR(p.total_ttc_cents)}</td>
                  <td>
                    <span className={"badge " + PURCHASE_STATUTS[p.status]?.cls}>
                      {PURCHASE_STATUTS[p.status]?.icon} {PURCHASE_STATUTS[p.status]?.label}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <PurchaseModal
          token={token}
          company={company}
          purchase={editing === "add" ? null : editing}
          onSave={(p) => {
            setEditing(null);
            setPurchases((arr) => {
              const exists = arr.find((x) => x.id === p.id);
              return exists ? arr.map((x) => (x.id === p.id ? p : x)) : [p, ...arr];
            });
          }}
          onDelete={(id) => {
            setEditing(null);
            setPurchases((arr) => arr.filter((x) => x.id !== id));
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/* ─── Modal achat (avec upload + OCR) ──────────────────── */
function PurchaseModal({ token, company, purchase, onSave, onDelete, onClose }) {
  const isEdit = Boolean(purchase);
  const [data, setData] = useState({
    vendor_name: purchase?.vendor_name || "",
    vendor_siret: purchase?.vendor_siret || "",
    vendor_vat_number: purchase?.vendor_vat_number || "",
    number: purchase?.number || "",
    issue_date: purchase?.issue_date || todayISO(),
    due_date: purchase?.due_date || "",
    subtotal_ht: fromCents(purchase?.subtotal_ht_cents || 0).toFixed(2),
    vat_total: fromCents(purchase?.vat_total_cents || 0).toFixed(2),
    total_ttc: fromCents(purchase?.total_ttc_cents || 0).toFixed(2),
    category: purchase?.category || "",
    accounting_code: purchase?.accounting_code || "",
    status: purchase?.status || "pending",
    notes: purchase?.notes || ""
  });
  const [file, setFile] = useState(null);
  const [filePreviewUrl, setFilePreviewUrl] = useState(null);
  const [ocring, setOcring] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);

  function onCameraCapture(blob, dataUrl) {
    // On reconstruit un File avec un nom plausible pour l'OCR
    const fileName = `scan-${Date.now()}.jpg`;
    const f = new File([blob], fileName, { type: "image/jpeg" });
    setFile(f);
    setFilePreviewUrl(dataUrl);
    setCameraOpen(false);
  }

  function update(k, v) {
    const next = { ...data, [k]: v };
    // Auto-calcul TTC si HT et TVA bougent
    if (k === "subtotal_ht" || k === "vat_total") {
      const ht = parseFloat(k === "subtotal_ht" ? v : next.subtotal_ht) || 0;
      const tva = parseFloat(k === "vat_total" ? v : next.vat_total) || 0;
      next.total_ttc = (ht + tva).toFixed(2);
    }
    setData(next);
  }

  async function handleFile(f) {
    if (!f) return;
    setFile(f);
    setFilePreviewUrl(URL.createObjectURL(f));
  }

  async function runOCR() {
    if (!file) return;
    setOcring(true);
    setErr("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("company_id", company.id);
      const r = await fetch("/api/ocr-purchase", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        // Message d'erreur cible selon le status code
        const msg = j.error || `Erreur OCR (${r.status})`;
        setErr(msg);
        setOcring(false);
        return;
      }
      // Pré-remplit le formulaire avec les données extraites
      const extracted = {};
      if (j.vendor_name) extracted.vendor_name = j.vendor_name;
      if (j.vendor_siret) extracted.vendor_siret = j.vendor_siret;
      if (j.vendor_vat_number) extracted.vendor_vat_number = j.vendor_vat_number;
      if (j.number) extracted.number = j.number;
      if (j.issue_date) extracted.issue_date = j.issue_date;
      if (j.subtotal_ht !== null && j.subtotal_ht !== undefined) extracted.subtotal_ht = Number(j.subtotal_ht).toFixed(2);
      if (j.vat_total !== null && j.vat_total !== undefined) extracted.vat_total = Number(j.vat_total).toFixed(2);
      if (j.total_ttc !== null && j.total_ttc !== undefined) extracted.total_ttc = Number(j.total_ttc).toFixed(2);
      if (j.category) extracted.category = j.category;
      if (j.accounting_code) extracted.accounting_code = j.accounting_code;

      setData((d) => ({ ...d, ...extracted }));

      // Compter combien de champs ont ete extraits avec succes
      const nbExtracted = Object.keys(extracted).length;
      if (nbExtracted === 0) {
        setErr("Aucune donnee extraite. Verifiez la qualite du document ou saisissez manuellement.");
      }
    } catch (e) {
      setErr("OCR : erreur reseau. Saisissez manuellement.");
    }
    setOcring(false);
  }

  async function save() {
    setErr("");
    if (!data.vendor_name.trim()) { setErr("Nom du fournisseur requis"); return; }
    setSaving(true);

    // 1. Si fichier, on upload vers Storage
    let fileUrl = purchase?.file_url || null;
    if (file) {
      const path = `${company.id}/${uid()}-${file.name}`;
      const uploaded = await sb.uploadFile(token, "purchases-attach", path, file);
      if (uploaded) fileUrl = path;
    }

    const payload = {
      vendor_name: data.vendor_name.trim(),
      vendor_siret: data.vendor_siret.trim() || null,
      vendor_vat_number: data.vendor_vat_number.trim() || null,
      number: data.number.trim() || null,
      issue_date: data.issue_date,
      due_date: data.due_date || null,
      subtotal_ht_cents: toCents(data.subtotal_ht),
      vat_total_cents: toCents(data.vat_total),
      total_ttc_cents: toCents(data.total_ttc),
      category: data.category || null,
      accounting_code: data.accounting_code || null,
      status: data.status,
      notes: data.notes || null,
      file_url: fileUrl,
      file_size: file?.size || purchase?.file_size,
      file_mime: file?.type || purchase?.file_mime,
      source: file && !purchase?.source ? "manual" : (purchase?.source || "manual"),
      ocr_status: purchase?.ocr_status || "pending"
    };

    let result;
    if (isEdit) {
      result = await sb.update(token, "purchases", `id=eq.${purchase.id}`, payload);
    } else {
      result = await sb.insert(token, "purchases", { ...payload, company_id: company.id });
    }
    setSaving(false);
    if (!result || !result[0]) { setErr("Erreur d'enregistrement"); return; }

    // Telemetrie
    if (!isEdit) {
      capture("purchase_added", {
        source: result[0].source || "manual",
        total_ttc: (result[0].total_ttc_cents || 0) / 100,
        ocr_status: result[0].ocr_status
      });
      bumpModuleUsage(token, company.id, "purchases");
    }
    onSave(result[0]);
  }

  async function del() {
    if (!confirm("Supprimer cet achat ?")) return;
    await sb.delete(token, "purchases", `id=eq.${purchase.id}`);
    onDelete(purchase.id);
  }

  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 720 }}>
        <div className="modal-hd">
          <div className="modal-title">{isEdit ? "Modifier l'achat" : "Nouvel achat fournisseur"}</div>
          <button className="close-btn" onClick={onClose}><Icon name="x" size={14} /></button>
        </div>
        <div className="modal-body">
          {err && <div className="auth-error" style={{ marginBottom: 14 }}>{err}</div>}

          {!isEdit && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--muted)", marginBottom: 8, fontWeight: 600 }}>
                Étape 1 — Importer le justificatif
              </div>
              <div
                style={{
                  border: "2px dashed var(--border)",
                  borderRadius: 10,
                  padding: filePreviewUrl ? 14 : 30,
                  textAlign: "center",
                  background: "rgba(212,168,67,0.04)",
                  cursor: "pointer",
                  transition: "all 0.15s"
                }}
                onClick={() => document.getElementById("purchase-file-input").click()}
                onDragOver={(e) => { e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}
              >
                {filePreviewUrl && file?.type?.startsWith("image/") ? (
                  <img src={filePreviewUrl} alt="" style={{ maxHeight: 140, borderRadius: 6 }} />
                ) : file ? (
                  <div style={{ fontSize: 13, color: "var(--gold)" }}>📄 {file.name} ({(file.size / 1024).toFixed(0)} Ko)</div>
                ) : (
                  <>
                    <Icon name="upload" size={28} />
                    <div style={{ fontSize: 13, marginTop: 8 }}>Glissez un PDF / une photo, ou cliquez</div>
                    <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>PDF · JPG · PNG · HEIC</div>
                  </>
                )}
                <input
                  id="purchase-file-input"
                  type="file"
                  accept="application/pdf,image/*"
                  onChange={(e) => handleFile(e.target.files[0])}
                  style={{ display: "none" }}
                />
              </div>

              {/* Bouton camera mobile (mode terrain) */}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={(e) => { e.stopPropagation(); setCameraOpen(true); }}
                style={{ marginTop: 8, width: "100%" }}
              >
                📸 Scanner avec l'appareil photo
              </button>

              {file && (
                <button
                  className="btn btn-primary btn-sm"
                  onClick={runOCR}
                  disabled={ocring}
                  style={{ marginTop: 10 }}
                >
                  {ocring ? "Extraction en cours..." : "🤖 Extraire avec OCR Mistral"}
                </button>
              )}

              {cameraOpen && (
                <CameraCapture
                  onCapture={onCameraCapture}
                  onClose={() => setCameraOpen(false)}
                />
              )}
            </div>
          )}

          <div style={{ fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--muted)", marginBottom: 8, fontWeight: 600 }}>
            {isEdit ? "Informations" : "Étape 2 — Vérifier / Compléter"}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Fournisseur *" value={data.vendor_name} onChange={(v) => update("vendor_name", v)} />
            <Field label="N° de la facture" value={data.number} onChange={(v) => update("number", v)} />
            <Field label="SIRET fournisseur" value={data.vendor_siret} onChange={(v) => update("vendor_siret", v)} />
            <Field label="N° TVA fournisseur" value={data.vendor_vat_number} onChange={(v) => update("vendor_vat_number", v)} />
            <Field label="Date de facture" value={data.issue_date} onChange={(v) => update("issue_date", v)} type="date" />
            <Field label="Échéance paiement" value={data.due_date} onChange={(v) => update("due_date", v)} type="date" />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 4 }}>
            <Field label="Total HT" value={data.subtotal_ht} onChange={(v) => update("subtotal_ht", v)} type="number" step="0.01" />
            <Field label="TVA" value={data.vat_total} onChange={(v) => update("vat_total", v)} type="number" step="0.01" />
            <Field label="Total TTC" value={data.total_ttc} onChange={(v) => update("total_ttc", v)} type="number" step="0.01" />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <SelectField
              label="Compte comptable"
              value={data.accounting_code}
              onChange={(v) => update("accounting_code", v)}
              options={[{ value: "", label: "—" }, ...ACCOUNTING_CODES.map((c) => ({ value: c.code, label: `${c.code} · ${c.label}` }))]}
            />
            <Field label="Catégorie libre" value={data.category} onChange={(v) => update("category", v)} placeholder="Ex : OVH, café client..." />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 12 }}>
            <SelectField
              label="Statut"
              value={data.status}
              onChange={(v) => update("status", v)}
              options={Object.entries(PURCHASE_STATUTS).map(([k, s]) => ({ value: k, label: s.label }))}
            />
            <div className="form-row">
              <label className="form-label">Notes</label>
              <textarea className="form-input" value={data.notes} onChange={(e) => update("notes", e.target.value)} rows={2} style={{ resize: "vertical", fontFamily: "DM Sans, sans-serif" }} />
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 18, justifyContent: "space-between" }}>
            {isEdit && (
              <button className="btn btn-danger btn-sm" onClick={del}>
                <Icon name="trash" size={12} /> Supprimer
              </button>
            )}
            <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
              <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Annuler</button>
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? "Enregistrement..." : (isEdit ? "Mettre à jour" : "Enregistrer")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", placeholder, step }) {
  return (
    <div className="form-row">
      <label className="form-label">{label}</label>
      <input
        type={type}
        step={step}
        className={"form-input" + (type === "number" ? " mono" : "")}
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

function SelectField({ label, value, onChange, options }) {
  return (
    <div className="form-row">
      <label className="form-label">{label}</label>
      <select className="form-input" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
