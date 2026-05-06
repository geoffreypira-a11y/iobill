import React, { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { isEmail } from "../../lib/helpers.js";

/**
 * FirmInviteClientPage — Inviter une societe a accepter le suivi par un cabinet.
 * Le cabinet envoie une demande, la societe doit l'accepter (consent obligatoire).
 */
export function FirmInviteClientPage({ token, user }) {
  const navigate = useNavigate();
  const [firm, setFirm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState({ email: "", access_level: "viewer" });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const fu = await sb.select(token, "firm_users", {
        filter: `user_id=eq.${user.id}&role=eq.partner`,
        select: "firm_id",
        limit: 1
      });
      if (!alive) return;
      if (!fu || fu.length === 0) {
        setErr("Vous devez être partner d'un cabinet pour inviter des clients");
        setLoading(false);
        return;
      }
      const f = await sb.selectOne(token, "firms", `id=eq.${fu[0].firm_id}`);
      setFirm(f);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, user.id]);

  function update(k, v) { setData((d) => ({ ...d, [k]: v })); }

  async function sendInvite() {
    setErr("");
    if (!isEmail(data.email)) { setErr("Email invalide"); return; }

    setSaving(true);
    try {
      const r = await fetch("/api/firm-invite-client", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          firm_id: firm.id,
          email: data.email.toLowerCase().trim(),
          access_level: data.access_level
        })
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "Erreur lors de l'invitation");
      }
      setSuccess(true);
    } catch (e) {
      setErr(e.message);
    }
    setSaving(false);
  }

  if (loading) {
    return <div className="page"><div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Chargement...</div></div>;
  }

  if (err && !firm) {
    return (
      <div className="page">
        <div className="card card-pad" style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div>
          <div style={{ marginBottom: 16 }}>{err}</div>
          <Link to="/firm" className="btn btn-primary">Retour au cabinet</Link>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="page" style={{ maxWidth: 600 }}>
        <div className="card card-pad" style={{ textAlign: "center", padding: 50 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>✉️</div>
          <h2 style={{ fontFamily: "Syne, sans-serif", fontSize: 18, marginBottom: 12, fontWeight: 700 }}>
            Invitation envoyée à {data.email}
          </h2>
          <div style={{ fontSize: 13, color: "var(--muted2)", lineHeight: 1.7, marginBottom: 22 }}>
            Le client recevra un email pour accepter la mise en supervision par votre cabinet.<br />
            Vous verrez ses dossiers dès qu'il aura accepté.
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
            <button className="btn btn-ghost" onClick={() => { setSuccess(false); setData({ email: "", access_level: "viewer" }); }}>
              + Inviter un autre client
            </button>
            <Link to="/firm" className="btn btn-primary">Retour au cabinet</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page" style={{ maxWidth: 600 }}>
      <div style={{ marginBottom: 12 }}>
        <Link to="/firm" style={{ fontSize: 12, color: "var(--gold)", textDecoration: "none" }}>
          ← Retour au cabinet
        </Link>
      </div>

      <div className="page-header">
        <div>
          <div className="page-title">INVITER UN CLIENT</div>
          <div className="page-sub">{firm.legal_name}</div>
        </div>
      </div>

      <div className="card card-pad">
        {err && <div className="auth-error" style={{ marginBottom: 14 }}>{err}</div>}

        <div style={{ fontSize: 13, color: "var(--muted2)", lineHeight: 1.7, marginBottom: 18 }}>
          Saisissez l'email du dirigeant ou de l'utilisateur principal de l'entreprise cliente.
          Il recevra un email avec un lien pour accepter la mise en supervision.
        </div>

        <div className="form-row">
          <label className="form-label">Email du client</label>
          <input
            className="form-input"
            type="email"
            value={data.email}
            onChange={(e) => update("email", e.target.value)}
            placeholder="dirigeant@societe-client.fr"
          />
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
            L'email doit correspondre à un compte IO BILL existant ou à venir.
          </div>
        </div>

        <div className="form-row">
          <label className="form-label">Niveau d'accès</label>
          <div style={{ display: "flex", gap: 8 }}>
            <label
              className="form-input"
              style={{
                flex: 1, display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: 14,
                borderColor: data.access_level === "viewer" ? "var(--gold)" : "var(--border2)"
              }}
            >
              <input
                type="radio"
                checked={data.access_level === "viewer"}
                onChange={() => update("access_level", "viewer")}
                style={{ accentColor: "var(--gold)", marginTop: 3 }}
              />
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>👁️ Lecture seule</div>
                <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>
                  Consultation des factures, devis, TVA, URSSAF.<br />Aucune modification possible.
                </div>
              </div>
            </label>
            <label
              className="form-input"
              style={{
                flex: 1, display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: 14,
                borderColor: data.access_level === "editor" ? "var(--gold)" : "var(--border2)"
              }}
            >
              <input
                type="radio"
                checked={data.access_level === "editor"}
                onChange={() => update("access_level", "editor")}
                style={{ accentColor: "var(--gold)", marginTop: 3 }}
              />
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>✏️ Édition</div>
                <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>
                  Idem + créer des factures, lancer des relances, valider des achats.
                </div>
              </div>
            </label>
          </div>
        </div>

        <div style={{ background: "rgba(212, 168, 67, 0.08)", padding: 12, borderRadius: 7, fontSize: 11, color: "var(--muted2)", marginTop: 8, lineHeight: 1.6 }}>
          <strong style={{ color: "var(--gold)" }}>RGPD :</strong> le client doit accepter explicitement
          la supervision. Il peut révoquer l'accès à tout moment depuis son interface.
          Toutes vos actions sur ses dossiers sont tracées dans son audit log.
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 18 }}>
          <Link to="/firm" className="btn btn-ghost">Annuler</Link>
          <button className="btn btn-primary" onClick={sendInvite} disabled={saving || !data.email}>
            {saving ? "Envoi..." : "Envoyer l'invitation"}
          </button>
        </div>
      </div>
    </div>
  );
}
