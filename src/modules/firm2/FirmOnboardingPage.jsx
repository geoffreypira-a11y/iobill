import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { sb } from "../../lib/supabase.js";

/**
 * FirmOnboardingPage — Création du cabinet comptable.
 *
 * Appelée juste après inscription Comptable, ou via "Créer mon cabinet"
 * depuis Settings. L'user devient automatiquement owner du cabinet créé.
 */
export function FirmOnboardingPage({ token, user, onCreated }) {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const [form, setForm] = useState({
    name: "",           // nom commercial du cabinet
    legal_name: "",     // raison sociale
    siret: "",
    email: user?.email || "",
    phone: "",
    address_line1: "",
    postal_code: "",
    city: "",
    country: "FR"
  });

  function update(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErr("");
    if (!form.name.trim()) { setErr("Le nom du cabinet est requis"); return; }
    setSaving(true);

    try {
      // 1) Créer le cabinet
      const created = await sb.insert(token, "accounting_firms", {
        name: form.name.trim(),
        legal_name: form.legal_name.trim() || null,
        siret: (form.siret || "").replace(/\s+/g, "") || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        address_line1: form.address_line1.trim() || null,
        postal_code: form.postal_code.trim() || null,
        city: form.city.trim() || null,
        country: form.country || "FR"
      });

      if (!created || created.length === 0) {
        setErr("Erreur de création du cabinet (réponse vide)");
        setSaving(false);
        return;
      }

      const firm = Array.isArray(created) ? created[0] : created;

      // 2) S'ajouter en tant qu'owner
      await sb.insert(token, "firm_members", {
        firm_id: firm.id,
        user_id: user.id,
        role: "owner",
        receive_email_notifications: true
      });

      setSaving(false);
      if (onCreated) onCreated(firm);
      // Rediriger vers le dashboard cabinet
      navigate("/firm");
    } catch (e) {
      setErr("Erreur : " + (e?.message || "création impossible"));
      setSaving(false);
    }
  }

  return (
    <div className="page" style={{ maxWidth: 680, margin: "0 auto" }}>
      <div className="page-header">
        <div>
          <div className="page-title">CRÉER MON CABINET</div>
          <div className="page-sub">Plan Cabinet — Gratuit et illimité</div>
        </div>
      </div>

      <div className="card" style={{
        padding: 14,
        marginBottom: 22,
        fontSize: 12,
        color: "var(--muted2)",
        lineHeight: 1.6
      }}>
        ✓ Gestion illimitée de sociétés clientes<br />
        ✓ Membres du cabinet illimités<br />
        ✓ Aucune carte bancaire requise<br />
        ✓ Vos clients payent leur propre abonnement (9,90 €/mois)
      </div>

      <form onSubmit={handleSubmit}>
        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontSize: 11, color: "var(--muted)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 14 }}>
            Informations du cabinet
          </div>

          {err && (
            <div style={{
              padding: 10,
              background: "rgba(220,38,38,0.1)",
              border: "1px solid rgba(220,38,38,0.3)",
              borderRadius: 6,
              fontSize: 12,
              color: "#fca5a5",
              marginBottom: 14
            }}>
              {err}
            </div>
          )}

          <div className="form-row">
            <label className="form-label">Nom du cabinet *</label>
            <input
              className="form-input"
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder="Ex : Cabinet Dupont & Associés"
              required
            />
          </div>

          <div className="form-row">
            <label className="form-label">Raison sociale</label>
            <input
              className="form-input"
              value={form.legal_name}
              onChange={(e) => update("legal_name", e.target.value)}
              placeholder="Ex : DUPONT & ASSOCIÉS SARL"
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div className="form-row">
              <label className="form-label">SIRET</label>
              <input
                className="form-input"
                value={form.siret}
                onChange={(e) => update("siret", e.target.value)}
                placeholder="14 chiffres"
              />
            </div>
            <div className="form-row">
              <label className="form-label">Téléphone</label>
              <input
                className="form-input"
                value={form.phone}
                onChange={(e) => update("phone", e.target.value)}
                placeholder="+33..."
              />
            </div>
          </div>

          <div className="form-row">
            <label className="form-label">Email du cabinet</label>
            <input
              type="email"
              className="form-input"
              value={form.email}
              onChange={(e) => update("email", e.target.value)}
            />
          </div>

          <div className="form-row">
            <label className="form-label">Adresse</label>
            <input
              className="form-input"
              value={form.address_line1}
              onChange={(e) => update("address_line1", e.target.value)}
              placeholder="Numéro et rue"
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "120px 1fr 80px", gap: 12 }}>
            <div className="form-row">
              <label className="form-label">CP</label>
              <input
                className="form-input"
                value={form.postal_code}
                onChange={(e) => update("postal_code", e.target.value)}
              />
            </div>
            <div className="form-row">
              <label className="form-label">Ville</label>
              <input
                className="form-input"
                value={form.city}
                onChange={(e) => update("city", e.target.value)}
              />
            </div>
            <div className="form-row">
              <label className="form-label">Pays</label>
              <input
                className="form-input"
                value={form.country}
                onChange={(e) => update("country", e.target.value)}
              />
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={saving}
              style={{ flex: 1, justifyContent: "center" }}
            >
              {saving ? "Création..." : "Créer mon cabinet →"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
