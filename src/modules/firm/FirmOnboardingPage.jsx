import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { isSiret, formatSiret, isEmail } from "../../lib/helpers.js";

/**
 * FirmOnboardingPage — Creer un nouveau cabinet d'expertise comptable.
 * Accessible depuis Settings → "Activer plan Cabinet" ou directement /firm/onboarding.
 */
export function FirmOnboardingPage({ token, user }) {
  const navigate = useNavigate();
  const [data, setData] = useState({
    legal_name: "",
    trade_name: "",
    siret: "",
    email: user?.email || "",
    phone: "",
    address_line1: "",
    postal_code: "",
    city: "",
    country: "FR"
  });
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  function update(k, v) { setData((d) => ({ ...d, [k]: v })); }

  async function createFirm() {
    setErr("");
    if (!data.legal_name?.trim()) { setErr("Raison sociale du cabinet requise"); return; }
    if (data.siret && !isSiret(data.siret.replace(/\s/g, ""))) { setErr("SIRET invalide (14 chiffres)"); return; }
    if (data.email && !isEmail(data.email)) { setErr("Email invalide"); return; }

    setSaving(true);

    // 1) Creer le firm
    const payload = {
      ...data,
      siret: data.siret ? data.siret.replace(/\s/g, "") : null
    };
    const created = await sb.insert(token, "firms", payload);
    if (!created || !created[0]) {
      setErr("Erreur de création du cabinet");
      setSaving(false);
      return;
    }
    const firm = created[0];

    // 2) Creer la ligne firm_users (le createur devient partner)
    await sb.insert(token, "firm_users", {
      firm_id: firm.id,
      user_id: user.id,
      role: "partner"
    });

    setSaving(false);
    navigate("/firm");
  }

  return (
    <div className="page" style={{ maxWidth: 720 }}>
      <div className="page-header">
        <div>
          <div className="page-title">CRÉER UN CABINET</div>
          <div className="page-sub">Plan IO BILL Cabinet — supervisez vos dossiers clients</div>
        </div>
      </div>

      <div className="card card-pad">
        {/* Etape 1 : description */}
        {step === 1 && (
          <>
            <div style={{ fontSize: 40, marginBottom: 14, textAlign: "center" }}>🏛️</div>
            <h2 style={{ fontFamily: "Syne, sans-serif", fontSize: 18, fontWeight: 700, letterSpacing: 1, marginBottom: 14, textAlign: "center" }}>
              Activer le plan Cabinet
            </h2>
            <div style={{ fontSize: 13, color: "var(--muted2)", lineHeight: 1.7, marginBottom: 20 }}>
              <p>
                Le plan <strong style={{ color: "var(--gold)" }}>IO BILL Cabinet</strong> vous permet de superviser
                jusqu'à <strong>50 dossiers clients</strong> depuis une seule interface :
              </p>
              <ul style={{ paddingLeft: 18, marginTop: 10, lineHeight: 2 }}>
                <li>Tableau de bord global multi-clients</li>
                <li>Alertes : retards, TVA à déclarer, URSSAF en attente</li>
                <li>Accès en lecture ou édition selon le contrat avec chaque client</li>
                <li>Multi-utilisateurs (partner / accountant / assistant)</li>
                <li>Export FEC consolidé (V1.2)</li>
              </ul>
              <div style={{ marginTop: 14, padding: 14, background: "var(--card2)", borderRadius: 8, fontSize: 12 }}>
                <strong>19,90 € HT/mois</strong> — facturé indépendamment de votre abonnement company.
                Annulable à tout moment.
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn btn-ghost" onClick={() => navigate("/")}>Annuler</button>
              <button className="btn btn-primary" onClick={() => setStep(2)}>
                Continuer →
              </button>
            </div>
          </>
        )}

        {/* Etape 2 : info cabinet */}
        {step === 2 && (
          <>
            <div style={{ fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--muted)", marginBottom: 12, fontWeight: 600 }}>
              Étape 1/1 — Informations du cabinet
            </div>
            {err && <div className="auth-error" style={{ marginBottom: 14 }}>{err}</div>}

            <div className="form-row">
              <label className="form-label">Raison sociale *</label>
              <input className="form-input" value={data.legal_name} onChange={(e) => update("legal_name", e.target.value)} placeholder="Cabinet Dupont & Associés" />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div className="form-row">
                <label className="form-label">Nom commercial</label>
                <input className="form-input" value={data.trade_name} onChange={(e) => update("trade_name", e.target.value)} placeholder="Cabinet Dupont" />
              </div>
              <div className="form-row">
                <label className="form-label">SIRET</label>
                <input
                  className="form-input mono"
                  value={data.siret}
                  onChange={(e) => update("siret", e.target.value.replace(/[^\d ]/g, ""))}
                  onBlur={(e) => update("siret", formatSiret(e.target.value))}
                  placeholder="123 456 789 00012"
                />
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div className="form-row">
                <label className="form-label">Email</label>
                <input className="form-input" type="email" value={data.email} onChange={(e) => update("email", e.target.value)} />
              </div>
              <div className="form-row">
                <label className="form-label">Téléphone</label>
                <input className="form-input" value={data.phone} onChange={(e) => update("phone", e.target.value)} placeholder="01 23 45 67 89" />
              </div>
            </div>

            <div className="form-row">
              <label className="form-label">Adresse</label>
              <input className="form-input" value={data.address_line1} onChange={(e) => update("address_line1", e.target.value)} placeholder="12 rue de la Paix" />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr 1fr", gap: 12 }}>
              <div className="form-row">
                <label className="form-label">CP</label>
                <input className="form-input mono" value={data.postal_code} onChange={(e) => update("postal_code", e.target.value)} placeholder="75002" />
              </div>
              <div className="form-row">
                <label className="form-label">Ville</label>
                <input className="form-input" value={data.city} onChange={(e) => update("city", e.target.value)} placeholder="Paris" />
              </div>
              <div className="form-row">
                <label className="form-label">Pays</label>
                <input className="form-input mono" value={data.country} onChange={(e) => update("country", e.target.value.toUpperCase())} maxLength={2} />
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "space-between", marginTop: 18 }}>
              <button className="btn btn-ghost" onClick={() => setStep(1)}>← Retour</button>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-ghost" onClick={() => navigate("/")}>Annuler</button>
                <button className="btn btn-primary" onClick={createFirm} disabled={saving}>
                  {saving ? "Création..." : "Créer le cabinet"}
                </button>
              </div>
            </div>

            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 14, lineHeight: 1.6 }}>
              Vous pourrez ensuite inviter vos collaborateurs et vos clients depuis le tableau de bord cabinet.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
