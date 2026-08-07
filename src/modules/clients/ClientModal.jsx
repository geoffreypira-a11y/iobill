import React, { useState } from "react";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { CLIENT_STATUTS, CLIENT_SOURCES } from "./constants.js";
import { isEmail, isSiret, isSiretOrSiren, formatSiret } from "../../lib/helpers.js";
import { capture, bumpModuleUsage } from "../../lib/telemetry.js";

export function ClientModal({ token, company, client, onSave, onClose }) {
  const isEdit = Boolean(client);
  const [type, setType] = useState(client?.client_type || "company");
  const [data, setData] = useState({
    legal_name: client?.legal_name || "",
    first_name: client?.first_name || "",
    last_name: client?.last_name || "",
    siret: client?.siret || "",
    vat_number: client?.vat_number || "",
    email: client?.email || "",
    phone: client?.phone || "",
    contact_person: client?.contact_person || "",
    address_line1: client?.address_line1 || "",
    address_line2: client?.address_line2 || "",
    postal_code: client?.postal_code || "",
    city: client?.city || "",
    country: client?.country || "FR",
    status: client?.status || "prospect",
    source: client?.source || "",
    notes: client?.notes || "",
    payment_terms_days: client?.payment_terms_days ?? 30,
    discount_pct: client?.discount_pct ?? 0,
    default_vat_rate: client?.default_vat_rate ?? "",
    tags: (client?.tags || []).join(", ")
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  function update(k, v) { setData((d) => ({ ...d, [k]: v })); }

  async function save() {
    setErr("");
    if (type === "company" && !data.legal_name.trim()) { setErr("Raison sociale requise"); return; }
    if (type === "individual" && !data.last_name.trim()) { setErr("Nom requis"); return; }
    if (data.email && !isEmail(data.email)) { setErr("Email invalide"); return; }
    if (data.siret && !isSiretOrSiren(data.siret)) {
      setErr("SIRET (14 chiffres) ou SIREN (9 chiffres) attendu");
      return;
    }

    setSaving(true);
    const payload = {
      client_type: type,
      legal_name: type === "company" ? data.legal_name.trim() : null,
      first_name: type === "individual" ? data.first_name.trim() : null,
      last_name: type === "individual" ? data.last_name.trim() : null,
      siret: data.siret.replace(/\s/g, "") || null,
      vat_number: data.vat_number.trim() || null,
      email: data.email.trim() || null,
      phone: data.phone.trim() || null,
      contact_person: data.contact_person.trim() || null,
      address_line1: data.address_line1.trim() || null,
      address_line2: data.address_line2.trim() || null,
      postal_code: data.postal_code.trim() || null,
      city: data.city.trim() || null,
      country: data.country || "FR",
      status: data.status,
      source: data.source || null,
      notes: data.notes || null,
      payment_terms_days: Number(data.payment_terms_days) || 30,
      discount_pct: Number(data.discount_pct) || 0,
      default_vat_rate: data.default_vat_rate ? Number(data.default_vat_rate) : null,
      tags: data.tags ? data.tags.split(",").map((t) => t.trim()).filter(Boolean) : []
    };

    let result;
    if (isEdit) {
      result = await sb.update(token, "clients", `id=eq.${client.id}`, payload);
    } else {
      result = await sb.insert(token, "clients", { ...payload, company_id: company.id });
    }
    setSaving(false);
    if (!result || !result[0]) { setErr("Erreur d'enregistrement"); return; }
    if (!isEdit) {
      capture("client_created", {
        client_type: result[0].client_type,
        country: result[0].country,
        has_vat: !!result[0].vat_number
      });
      bumpModuleUsage(token, company.id, "crm");
    }
    onSave(result[0]);
  }

  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 720 }}>
        <div className="modal-hd">
          <div className="modal-title">{isEdit ? "Modifier le client" : "Nouveau client"}</div>
          <button className="close-btn" onClick={onClose} aria-label="Fermer">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="modal-body">
          {err && <div className="auth-error" style={{ marginBottom: 14 }}>{err}</div>}

          {/* Type B2B / B2C */}
          <div className="tabs" style={{ marginBottom: 16 }}>
            <button className={"tab" + (type === "company" ? " active" : "")} onClick={() => setType("company")}>Société</button>
            <button className={"tab" + (type === "individual" ? " active" : "")} onClick={() => setType("individual")}>Particulier</button>
          </div>

          {/* Identité */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 6 }}>
            {type === "company" ? (
              <>
                <Field label="Raison sociale *" value={data.legal_name} onChange={(v) => update("legal_name", v)} full />
                <Field label="Personne contact" value={data.contact_person} onChange={(v) => update("contact_person", v)} />
                <Field label="SIRET (14 chiffres) ou SIREN (9)" value={data.siret} onChange={(v) => update("siret", formatSiret(v))} />
                <Field label="N° TVA intracom." value={data.vat_number} onChange={(v) => update("vat_number", v.toUpperCase())} />
              </>
            ) : (
              <>
                <Field label="Prénom" value={data.first_name} onChange={(v) => update("first_name", v)} />
                <Field label="Nom *" value={data.last_name} onChange={(v) => update("last_name", v)} />
              </>
            )}
            <Field label="Email" value={data.email} onChange={(v) => update("email", v)} />
            <Field label="Téléphone" value={data.phone} onChange={(v) => update("phone", v)} />
          </div>

          {/* Adresse */}
          <div style={{ fontFamily: "Syne, sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--muted)", marginTop: 14, marginBottom: 8 }}>
            Adresse de facturation
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Adresse" value={data.address_line1} onChange={(v) => update("address_line1", v)} full />
            <Field label="Complément" value={data.address_line2} onChange={(v) => update("address_line2", v)} full />
            <Field label="Code postal" value={data.postal_code} onChange={(v) => update("postal_code", v)} />
            <Field label="Ville" value={data.city} onChange={(v) => update("city", v)} />
            <Field label="Pays" value={data.country} onChange={(v) => update("country", v.toUpperCase())} />
          </div>

          {/* CRM */}
          <div style={{ fontFamily: "Syne, sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--muted)", marginTop: 18, marginBottom: 8 }}>
            Statut & suivi
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <SelectField
              label="Statut CRM"
              value={data.status}
              onChange={(v) => update("status", v)}
              options={Object.entries(CLIENT_STATUTS).map(([k, s]) => ({ value: k, label: s.label }))}
            />
            <SelectField
              label="Source"
              value={data.source}
              onChange={(v) => update("source", v)}
              options={[{ value: "", label: "—" }, ...CLIENT_SOURCES.map((s) => ({ value: s.code, label: s.label }))]}
            />
            <Field label="Tags (séparés par virgule)" value={data.tags} onChange={(v) => update("tags", v)} full />
          </div>

          {/* Conditions commerciales */}
          <div style={{ fontFamily: "Syne, sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--muted)", marginTop: 18, marginBottom: 8 }}>
            Conditions commerciales par défaut
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            <Field label="Délai paiement (jours)" value={data.payment_terms_days} onChange={(v) => update("payment_terms_days", v)} type="number" />
            <Field label="Remise %" value={data.discount_pct} onChange={(v) => update("discount_pct", v)} type="number" />
            <Field label="TVA par défaut %" value={data.default_vat_rate} onChange={(v) => update("default_vat_rate", v)} type="number" placeholder="20" />
          </div>

          {/* Notes */}
          <div className="form-row" style={{ marginTop: 14 }}>
            <label className="form-label">Notes</label>
            <textarea
              className="form-input"
              value={data.notes}
              onChange={(e) => update("notes", e.target.value)}
              rows={3}
              style={{ resize: "vertical", fontFamily: "DM Sans, sans-serif" }}
            />
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 18, justifyContent: "flex-end" }}>
            <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Annuler</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? "Enregistrement..." : (isEdit ? "Mettre à jour" : "Créer le client")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, type = "text", placeholder, full }) {
  return (
    <div className="form-row" style={full ? { gridColumn: "1 / -1" } : undefined}>
      <label className="form-label">{label}</label>
      <input
        type={type}
        className="form-input"
        value={value}
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
