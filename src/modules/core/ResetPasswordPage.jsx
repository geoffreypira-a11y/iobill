import React, { useState } from "react";
import { sb } from "../../lib/supabase.js";
import { LogoMark } from "../../components/Logo.jsx";

/**
 * v8.51 — ResetPasswordPage IOBILL
 *
 * Écran affiché quand l'user arrive sur /reset-password depuis un lien
 * email Supabase (avec #access_token=xxx&type=recovery dans le hash).
 *
 * Détecte le token dans l'URL, propose un formulaire nouveau mot de passe,
 * appelle sb.updateUserPassword() puis redirige vers l'accueil.
 */
export function ResetPasswordPage({ accessToken }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function handleSubmit(e) {
    if (e) e.preventDefault();
    setError(""); setSuccess("");

    if (password.length < 6) {
      setError("Le mot de passe doit faire au moins 6 caractères.");
      return;
    }
    if (password !== confirm) {
      setError("Les mots de passe ne correspondent pas.");
      return;
    }

    setLoading(true);
    try {
      const r = await sb.updateUserPassword(accessToken, password);
      setLoading(false);
      if (!r.ok) {
        const msg = r.data?.error_description || r.data?.msg || r.data?.error?.message || "";
        if (/same as/i.test(msg)) {
          setError("Le nouveau mot de passe doit être différent de l'ancien.");
        } else if (/expired|invalid/i.test(msg)) {
          setError("Ce lien de réinitialisation a expiré ou est invalide. Demandez-en un nouveau depuis la page de connexion.");
        } else {
          setError(msg || "Erreur lors de la mise à jour du mot de passe.");
        }
        return;
      }
      setSuccess("✅ Mot de passe modifié ! Redirection…");
      setTimeout(() => {
        window.location.hash = "";
        window.location.href = "/";
      }, 1500);
    } catch (err) {
      setLoading(false);
      setError("Erreur réseau. Réessayez.");
    }
  }

  return (
    <div style={{
      minHeight: "100vh",
      background: "var(--bg, #0e0f12)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 20,
    }}>
      <div style={{
        maxWidth: 420,
        width: "100%",
        background: "var(--card, #1a1d22)",
        border: "1px solid var(--border, rgba(255,255,255,0.08))",
        borderRadius: 14,
        padding: 32,
        boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
      }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <LogoMark size={48} />
        </div>

        <h1 style={{ fontSize: 22, margin: "0 0 6px 0", textAlign: "center", color: "var(--text)" }}>
          Nouveau mot de passe
        </h1>
        <p style={{ color: "var(--muted)", fontSize: 13, textAlign: "center", marginBottom: 24 }}>
          Choisissez votre nouveau mot de passe
        </p>

        {error && (
          <div style={{
            padding: "10px 12px",
            marginBottom: 14,
            background: "rgba(224,85,106,0.1)",
            border: "1px solid rgba(224,85,106,0.3)",
            borderRadius: 8,
            color: "var(--red, #e0556a)",
            fontSize: 13,
          }}>⚠️ {error}</div>
        )}
        {success && (
          <div style={{
            padding: "10px 12px",
            marginBottom: 14,
            background: "rgba(62,207,122,0.1)",
            border: "1px solid rgba(62,207,122,0.3)",
            borderRadius: 8,
            color: "var(--green, #3ecf7a)",
            fontSize: 13,
          }}>{success}</div>
        )}

        {!success && (
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>
                Nouveau mot de passe
              </label>
              <input
                type="password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimum 6 caractères"
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  background: "var(--card2, rgba(255,255,255,0.03))",
                  border: "1px solid var(--border, rgba(255,255,255,0.08))",
                  borderRadius: 8,
                  color: "var(--text)",
                  fontSize: 14,
                  boxSizing: "border-box",
                }}
              />
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 1 }}>
                Confirmez
              </label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Retapez le même mot de passe"
                style={{
                  width: "100%",
                  padding: "10px 12px",
                  background: "var(--card2, rgba(255,255,255,0.03))",
                  border: "1px solid var(--border, rgba(255,255,255,0.08))",
                  borderRadius: 8,
                  color: "var(--text)",
                  fontSize: 14,
                  boxSizing: "border-box",
                }}
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              style={{
                width: "100%",
                padding: "12px 20px",
                background: "var(--gold, #d4a843)",
                color: "#1a1d22",
                border: 0,
                borderRadius: 10,
                fontSize: 14,
                fontWeight: 600,
                cursor: loading ? "default" : "pointer",
                opacity: loading ? 0.6 : 1,
              }}
            >
              {loading ? "⏳ Mise à jour..." : "🔐 Mettre à jour mon mot de passe"}
            </button>

            <div style={{ textAlign: "center", marginTop: 18 }}>
              <a
                href="/"
                onClick={(e) => {
                  e.preventDefault();
                  window.location.hash = "";
                  window.location.href = "/";
                }}
                style={{ color: "var(--muted)", fontSize: 12, textDecoration: "none" }}
              >
                ← Retour à la connexion
              </a>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
