import React, { useState } from "react";
import { useNavigate, Navigate } from "react-router-dom";
import { useMyFirm } from "../../components/FirmMode.jsx";
import { useIsComptableMode } from "../../components/AdminModeToggle.jsx";

/**
 * FirmInviteClientPage — Sprint 2 v8.26
 * Formulaire d'invitation client par SIRET + email
 */
export function FirmInviteClientPage({ token, user, company }) {
  const navigate = useNavigate();
  const isComptableMode = useIsComptableMode(!!company?.is_admin);
  const { loading, firm } = useMyFirm(token, user?.id);

  if (loading) return <div style={loadingStyle}>Chargement...</div>;

  if (isComptableMode && !firm) {
    return <PreviewBanner onBack={() => navigate("/firm/clients")} />;
  }
  if (!firm) return <Navigate to="/firm" replace />;

  return <InviteForm token={token} firm={firm} onBack={() => navigate("/firm/clients")} />;
}

function InviteForm({ token, firm, onBack }) {
  const [siret, setSiret] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [lookup, setLookup] = useState(null); // résultat du lookup SIRET
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [success, setSuccess] = useState(false);

  // Lookup live quand SIRET = 14 chiffres
  React.useEffect(() => {
    const clean = siret.replace(/\s/g, "");
    if (clean.length !== 14) { setLookup(null); return; }
    let alive = true;
    (async () => {
      const r = await fetch("/api/firm-invitation", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "lookup", payload: { siret: clean } })
      });
      if (!alive) return;
      const data = await r.json();
      setLookup(data);
    })();
    return () => { alive = false; };
  }, [siret, token]);

  async function submit() {
    setErr(null);
    const cleanSiret = siret.replace(/\s/g, "");
    if (cleanSiret.length !== 14) { setErr("Le SIRET doit contenir 14 chiffres"); return; }
    if (!email.trim() || !email.includes("@")) { setErr("Email invalide"); return; }

    setLoading(true);
    const r = await fetch("/api/firm-invitation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action: "create_from_firm",
        payload: { firm_id: firm.id, siret: cleanSiret, email: email.trim(), message: message.trim() }
      })
    });
    const data = await r.json();
    setLoading(false);

    if (!r.ok) { setErr(data.error || "Échec invitation"); return; }
    setSuccess(true);
    setTimeout(() => onBack(), 2000);
  }

  if (success) {
    return (
      <div style={pageStyle}>
        <div className="card card-pad" style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>Invitation envoyée</div>
          <div style={{ fontSize: 13, color: "var(--muted)" }}>
            {lookup?.company 
              ? "Le client a reçu une notification in-app et un email."
              : "Un email d'invitation a été envoyé. Le client recevra le lien pour créer son compte ou accepter."}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={pageStyle}>
      <div style={{ marginBottom: 20 }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← Retour</button>
      </div>

      <h1 style={{ fontFamily: "Syne, sans-serif", fontSize: 32, fontWeight: 700, margin: "0 0 8px 0", letterSpacing: "-0.02em" }}>
        INVITER UN CLIENT
      </h1>
      <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 24 }}>
        Cabinet {firm.name}
      </div>

      <div className="card card-pad" style={{ maxWidth: 600 }}>
        <div style={{ marginBottom: 16 }}>
          <label className="form-label">SIRET du client *</label>
          <input
            type="text"
            className="form-input"
            value={siret}
            onChange={(e) => setSiret(e.target.value.replace(/[^\d\s]/g, "").slice(0, 17))}
            placeholder="14 chiffres"
            style={{ fontFamily: "monospace", letterSpacing: 1 }}
          />
          {lookup && lookup.company && (
            <div style={{ marginTop: 8, padding: "8px 12px", background: "rgba(62,207,122,0.1)", borderRadius: 6, fontSize: 12, color: "var(--green)" }}>
              ✅ Entreprise trouvée sur IO BILL : <strong>{lookup.company.legal_name}</strong>
            </div>
          )}
          {siret.replace(/\s/g, "").length === 14 && lookup && !lookup.company && (
            <div style={{ marginTop: 8, padding: "8px 12px", background: "rgba(212,168,67,0.1)", borderRadius: 6, fontSize: 12, color: "var(--gold)" }}>
              ℹ Aucun compte IO BILL trouvé. Le client recevra une invitation par email pour s'inscrire.
            </div>
          )}
        </div>

        <div style={{ marginBottom: 16 }}>
          <label className="form-label">Email du contact *</label>
          <input
            type="email"
            className="form-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="contact@entreprise.com"
          />
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
            L'email où sera envoyée l'invitation.
          </div>
        </div>

        <div style={{ marginBottom: 16 }}>
          <label className="form-label">Message (optionnel)</label>
          <textarea
            className="form-input"
            rows={4}
            value={message}
            onChange={(e) => setMessage(e.target.value.slice(0, 500))}
            placeholder="Ex : Bonjour, suite à notre échange, je vous propose de gérer votre comptabilité via IO BILL..."
            style={{ resize: "vertical", minHeight: 80 }}
          />
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
            {message.length}/500 — Ce message apparaîtra dans l'email et la notification.
          </div>
        </div>

        {err && (
          <div className="alert-danger" style={{ marginBottom: 16, fontSize: 13 }}>
            {err}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-ghost" onClick={onBack}>Annuler</button>
          <button className="btn btn-primary" onClick={submit} disabled={loading}>
            {loading ? "Envoi..." : "Envoyer l'invitation →"}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 20, fontSize: 11, color: "var(--muted)", maxWidth: 600 }}>
        💡 Le client recevra un email + une notification (s'il a déjà un compte IO BILL).
        Il pourra accepter ou refuser. L'invitation reste <strong>en attente</strong> tant qu'il n'a pas validé,
        et vos données restent privées tant qu'il n'a pas accepté.
      </div>
    </div>
  );
}

function PreviewBanner({ onBack }) {
  return (
    <div style={pageStyle}>
      <div style={{ marginBottom: 20 }}>
        <button className="btn btn-ghost btn-sm" onClick={onBack}>← Retour</button>
      </div>
      <div className="card card-pad" style={{ textAlign: "center", padding: 40 }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>📋</div>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>Mode aperçu admin</div>
        <div style={{ fontSize: 13, color: "var(--muted)" }}>
          Cette fonctionnalité nécessite un vrai compte cabinet rattaché à un firm_member réel.
          Inscris-toi avec un compte cabinet pour tester l'invitation.
        </div>
      </div>
    </div>
  );
}

const pageStyle = { maxWidth: 800, margin: "0 auto", padding: "20px 24px" };
const loadingStyle = { minHeight: 400, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 13 };
