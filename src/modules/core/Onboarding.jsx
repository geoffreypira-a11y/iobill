import React, { useState } from "react";
import { sb } from "../../lib/supabase.js";
import { LogoMark } from "../../components/Logo.jsx";

// 3 questions => active automatiquement les bons modules
// 1. Statut juridique => regle URSSAF / TVA / compta
// 2. Assujetti TVA ?
// 3. Activite (BNC / BIC services / BIC vente) => seuil franchise

const STATUTS = [
  { code: "micro", label: "Auto-entrepreneur / Micro" },
  { code: "ei", label: "Entreprise individuelle (EI)" },
  { code: "eurl", label: "EURL" },
  { code: "sasu", label: "SASU" },
  { code: "sarl", label: "SARL" },
  { code: "sas", label: "SAS" },
  { code: "association", label: "Association" },
  { code: "autre", label: "Autre" }
];

const ACTIVITES = [
  { code: "bnc", label: "Profession libérale (BNC)", threshold: 39100 },
  { code: "bic_services", label: "Prestations de services (BIC)", threshold: 39100 },
  { code: "bic_vente", label: "Vente de marchandises (BIC)", threshold: 101000 }
];

export function Onboarding({ token, user, onDone }) {
  const [step, setStep] = useState(1);
  const [legalName, setLegalName] = useState(user?.user_metadata?.legal_name || "");
  const [legalForm, setLegalForm] = useState("micro");
  const [vatRegime, setVatRegime] = useState("franchise");
  const [activity, setActivity] = useState("bic_services");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  function modulesFromAnswers() {
    const isMicro = legalForm === "micro";
    const assujetti = vatRegime !== "franchise";
    return {
      invoicing: true,
      quotes: true,
      credit_notes: true,
      purchases: true,
      vat: assujetti,
      urssaf: isMicro,
      accounting: !isMicro || assujetti,
      banking: false,                  // active manuellement (PSD2)
      client_portal: true,
      esign: true
    };
  }

  function thresholdFor(activityCode) {
    return ACTIVITES.find((a) => a.code === activityCode)?.threshold || null;
  }

  async function finish() {
    setErr("");
    setSaving(true);
    const company = {
      user_id: user.id,
      legal_name: legalName.trim(),
      legal_form: legalForm,
      email: user.email,
      vat_regime: vatRegime,
      micro_activity: activity,
      micro_threshold: legalForm === "micro" ? thresholdFor(activity) : null,
      modules: modulesFromAnswers(),
      trial_ends_at: new Date(Date.now() + 7 * 86400000).toISOString(),
      sub_status: "trialing"
    };
    const created = await sb.insert(token, "companies", company);
    setSaving(false);
    if (!created || !created[0]) {
      setErr("Erreur d'enregistrement. Réessayez.");
      return;
    }
    onDone(created[0]);
  }

  return (
    <div className="auth-wrap">
      <div className="auth-box" style={{ maxWidth: 520 }}>
        <div className="auth-logo">
          <LogoMark size={48} />
          <div style={{ fontFamily: "Syne, sans-serif", fontSize: 20, fontWeight: 700, letterSpacing: 1, color: "var(--text)" }}>
            Bienvenue sur IO BILL
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            3 questions pour configurer votre espace
          </div>
        </div>

        {err && <div className="auth-error">{err}</div>}

        <div style={{ display: "flex", gap: 6, marginBottom: 22 }}>
          {[1, 2, 3].map((n) => (
            <div
              key={n}
              style={{
                flex: 1,
                height: 4,
                borderRadius: 2,
                background: n <= step ? "var(--gold)" : "var(--card2)"
              }}
            />
          ))}
        </div>

        {step === 1 && (
          <div>
            <div style={{ fontSize: 14, color: "var(--text)", marginBottom: 6, fontWeight: 600 }}>
              Quel est votre statut juridique ?
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 16 }}>
              Cela détermine vos obligations fiscales et sociales.
            </div>
            <div className="form-row">
              <label className="form-label">Nom de votre activité</label>
              <input
                className="form-input"
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
                placeholder="Ex : Marie Dupont Conseil"
              />
            </div>
            <div className="form-row">
              <label className="form-label">Statut</label>
              <select
                className="form-input"
                value={legalForm}
                onChange={(e) => setLegalForm(e.target.value)}
              >
                {STATUTS.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
              </select>
            </div>
            <button
              className="btn btn-primary"
              onClick={() => {
                if (!legalName.trim()) { setErr("Nom requis"); return; }
                setErr("");
                if (legalForm === "micro") setStep(3);   // micro: pas de question TVA assujettie au depart
                else setStep(2);
              }}
              style={{ width: "100%", justifyContent: "center" }}
            >
              Continuer →
            </button>
          </div>
        )}

        {step === 2 && (
          <div>
            <div style={{ fontSize: 14, color: "var(--text)", marginBottom: 6, fontWeight: 600 }}>
              Êtes-vous assujetti à la TVA ?
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 16 }}>
              Si vous facturez avec TVA, choisissez votre fréquence de déclaration.
            </div>
            {[
              { code: "franchise", label: "Non — franchise en base de TVA" },
              { code: "normal_monthly", label: "Oui — déclaration mensuelle (CA3)" },
              { code: "normal_quarterly", label: "Oui — déclaration trimestrielle (CA3)" },
              { code: "simplified", label: "Oui — régime simplifié (CA12 annuelle)" }
            ].map((opt) => (
              <label
                key={opt.code}
                className="form-input"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 8,
                  cursor: "pointer",
                  borderColor: vatRegime === opt.code ? "var(--gold)" : "var(--border2)"
                }}
              >
                <input
                  type="radio"
                  checked={vatRegime === opt.code}
                  onChange={() => setVatRegime(opt.code)}
                  style={{ accentColor: "var(--gold)" }}
                />
                {opt.label}
              </label>
            ))}
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button className="btn btn-ghost" onClick={() => setStep(1)}>← Retour</button>
              <button className="btn btn-primary" onClick={() => setStep(3)} style={{ flex: 1, justifyContent: "center" }}>
                Continuer →
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <div style={{ fontSize: 14, color: "var(--text)", marginBottom: 6, fontWeight: 600 }}>
              Quel type d'activité exercez-vous ?
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 16 }}>
              {legalForm === "micro"
                ? "Cela détermine votre seuil de franchise TVA."
                : "Pour ajuster les calculs et déclarations."}
            </div>
            {ACTIVITES.map((a) => (
              <label
                key={a.code}
                className="form-input"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 8,
                  cursor: "pointer",
                  borderColor: activity === a.code ? "var(--gold)" : "var(--border2)"
                }}
              >
                <input
                  type="radio"
                  checked={activity === a.code}
                  onChange={() => setActivity(a.code)}
                  style={{ accentColor: "var(--gold)" }}
                />
                <div style={{ flex: 1 }}>
                  <div>{a.label}</div>
                  {legalForm === "micro" && (
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>
                      Seuil franchise TVA : {a.threshold.toLocaleString("fr-FR")} €
                    </div>
                  )}
                </div>
              </label>
            ))}
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button
                className="btn btn-ghost"
                onClick={() => setStep(legalForm === "micro" ? 1 : 2)}
              >
                ← Retour
              </button>
              <button
                className="btn btn-primary"
                onClick={finish}
                disabled={saving}
                style={{ flex: 1, justifyContent: "center" }}
              >
                {saving ? "Création..." : "Démarrer →"}
              </button>
            </div>
          </div>
        )}

        <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 22, textAlign: "center", letterSpacing: 1, textTransform: "uppercase" }}>
          Vous pourrez ajuster tous les modules dans Paramètres
        </div>
      </div>
    </div>
  );
}
