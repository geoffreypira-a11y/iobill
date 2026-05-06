import React, { useState } from "react";
import { sb } from "../../lib/supabase.js";
import { LogoMark } from "../../components/Logo.jsx";
import { isEmail } from "../../lib/helpers.js";

export function AuthPage({ onAuthed }) {
  const [mode, setMode] = useState("signin"); // signin, signup, reset
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [legalName, setLegalName] = useState("");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");
  const [loading, setLoading] = useState(false);

  const reset = () => { setErr(""); setOk(""); };

  async function handleSignIn(e) {
    e.preventDefault();
    reset();
    if (!isEmail(email)) { setErr("Email invalide"); return; }
    if (!password) { setErr("Mot de passe requis"); return; }
    setLoading(true);
    const r = await sb.signIn({ email, password });
    setLoading(false);
    if (!r.ok) {
      setErr(r.data?.error_description || r.data?.msg || "Identifiants incorrects");
      return;
    }
    onAuthed({
      token: r.data.access_token,
      refresh: r.data.refresh_token,
      user: r.data.user
    });
  }

  async function handleSignUp(e) {
    e.preventDefault();
    reset();
    if (!isEmail(email)) { setErr("Email invalide"); return; }
    if (!password || password.length < 8) { setErr("Mot de passe : 8 caractères minimum"); return; }
    if (!legalName.trim()) { setErr("Nom de votre activité requis"); return; }
    setLoading(true);
    const r = await sb.signUp({
      email,
      password,
      metadata: { legal_name: legalName.trim() }
    });
    setLoading(false);
    if (!r.ok) {
      setErr(r.data?.msg || r.data?.error_description || "Inscription impossible");
      return;
    }
    setOk("Inscription réussie. Vérifiez votre email pour confirmer votre compte, puis connectez-vous.");
    setMode("signin");
  }

  async function handleReset(e) {
    e.preventDefault();
    reset();
    if (!isEmail(email)) { setErr("Email invalide"); return; }
    setLoading(true);
    const r = await sb.resetPassword(email);
    setLoading(false);
    if (!r.ok) { setErr("Erreur. Vérifiez votre adresse."); return; }
    setOk("Email de réinitialisation envoyé. Pensez à vérifier vos spams.");
  }

  return (
    <div className="auth-wrap">
      <div className="auth-box">
        <div className="auth-logo">
          <LogoMark size={56} />
          <div className="auth-logo-text">IO<span>BILL</span></div>
          <div style={{ fontSize: 11, letterSpacing: 1.5, color: "var(--muted)", textTransform: "uppercase" }}>
            Le bijou de l'entrepreneur
          </div>
        </div>

        {err && <div className="auth-error">{err}</div>}
        {ok && <div className="auth-success">{ok}</div>}

        {mode === "signin" && (
          <form onSubmit={handleSignIn}>
            <div className="form-row">
              <label className="form-label">Email</label>
              <input
                type="email"
                className="form-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="vous@entreprise.fr"
                autoComplete="email"
              />
            </div>
            <div className="form-row">
              <label className="form-label">Mot de passe</label>
              <input
                type="password"
                className="form-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={loading} style={{ width: "100%", justifyContent: "center" }}>
              {loading ? "Connexion..." : "Se connecter"}
            </button>
            <div className="auth-switch">
              <a onClick={() => { reset(); setMode("reset"); }}>Mot de passe oublié ?</a>
              <span style={{ margin: "0 8px" }}>·</span>
              <a onClick={() => { reset(); setMode("signup"); }}>Créer un compte</a>
            </div>
          </form>
        )}

        {mode === "signup" && (
          <form onSubmit={handleSignUp}>
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
              <label className="form-label">Email</label>
              <input
                type="email"
                className="form-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="vous@entreprise.fr"
                autoComplete="email"
              />
            </div>
            <div className="form-row">
              <label className="form-label">Mot de passe (8 caractères min)</label>
              <input
                type="password"
                className="form-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={loading} style={{ width: "100%", justifyContent: "center" }}>
              {loading ? "Création..." : "Créer mon compte"}
            </button>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 12, textAlign: "center" }}>
              30 jours d'essai gratuit, sans CB requise
            </div>
            <div className="auth-switch">
              <a onClick={() => { reset(); setMode("signin"); }}>← Déjà un compte ? Se connecter</a>
            </div>
          </form>
        )}

        {mode === "reset" && (
          <form onSubmit={handleReset}>
            <div className="form-row">
              <label className="form-label">Email</label>
              <input
                type="email"
                className="form-input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="vous@entreprise.fr"
                autoComplete="email"
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={loading} style={{ width: "100%", justifyContent: "center" }}>
              {loading ? "Envoi..." : "Envoyer le lien"}
            </button>
            <div className="auth-switch">
              <a onClick={() => { reset(); setMode("signin"); }}>← Retour</a>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
