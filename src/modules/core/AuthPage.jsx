import React, { useState } from "react";
import { sb } from "../../lib/supabase.js";
import { LogoMark } from "../../components/Logo.jsx";
import { isEmail } from "../../lib/helpers.js";

export function AuthPage({ onAuthed }) {
  // mode : "signin" | "choose" | "signup" | "reset"
  // accountType : "pro" | "firm" — uniquement pour signup
  const [mode, setMode] = useState("signin");
  const [accountType, setAccountType] = useState("pro");
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
    if (!legalName.trim()) {
      setErr(accountType === "firm" ? "Nom du cabinet requis" : "Nom de votre activité requis");
      return;
    }
    setLoading(true);
    const r = await sb.signUp({
      email,
      password,
      metadata: {
        legal_name: legalName.trim(),
        account_type: accountType  // "pro" ou "firm" — utilisé après confirm email
      }
    });
    setLoading(false);
    if (!r.ok) {
      setErr(r.data?.msg || r.data?.error_description || "Inscription impossible");
      return;
    }
    // Pour le cabinet : on stocke le type pour rediriger après confirmation
    if (accountType === "firm") {
      try { localStorage.setItem("iobill_pending_firm_setup", "1"); } catch {}
      setOk("✅ Inscription réussie ! Vérifiez votre email pour confirmer, puis connectez-vous. Vous serez ensuite redirigé vers la création de votre cabinet.");
    } else {
      setOk("Inscription réussie. Vérifiez votre email pour confirmer votre compte, puis connectez-vous.");
    }
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
              <a onClick={() => { reset(); setMode("choose"); }}>Créer un compte</a>
            </div>
          </form>
        )}

        {mode === "choose" && (
          <div>
            <div style={{ fontSize: 14, color: "var(--muted)", textAlign: "center", marginBottom: 18 }}>
              Quelle est votre activité ?
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {/* CARTE PRO */}
              <button
                onClick={() => { reset(); setAccountType("pro"); setMode("signup"); }}
                style={{
                  background: "rgba(212,168,67,0.04)",
                  border: "1px solid rgba(212,168,67,0.3)",
                  borderRadius: 10,
                  padding: 18,
                  textAlign: "left",
                  cursor: "pointer",
                  color: "var(--text)",
                  transition: "all 0.15s"
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(212,168,67,0.08)";
                  e.currentTarget.style.borderColor = "rgba(212,168,67,0.5)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "rgba(212,168,67,0.04)";
                  e.currentTarget.style.borderColor = "rgba(212,168,67,0.3)";
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                  <span style={{ fontSize: 28 }}>🏢</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 16 }}>Je gère MA société</div>
                    <div style={{ fontSize: 11, color: "var(--gold)" }}>Plan Pro · 9,90 € HT/mois</div>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
                  Auto-entrepreneur, TPE, PME, freelance. Factures, devis, achats,
                  TVA, lettrage bancaire. Conforme Factur-X 2026/2027.
                </div>
                <div style={{ marginTop: 10, fontSize: 11, color: "var(--green, #3ecf7a)" }}>
                  ✓ 14 jours d'essai gratuit, sans CB
                </div>
              </button>

              {/* CARTE CABINET */}
              <button
                onClick={() => { reset(); setAccountType("firm"); setMode("signup"); }}
                style={{
                  background: "rgba(62,207,122,0.04)",
                  border: "1px solid rgba(62,207,122,0.3)",
                  borderRadius: 10,
                  padding: 18,
                  textAlign: "left",
                  cursor: "pointer",
                  color: "var(--text)",
                  transition: "all 0.15s"
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(62,207,122,0.08)";
                  e.currentTarget.style.borderColor = "rgba(62,207,122,0.5)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "rgba(62,207,122,0.04)";
                  e.currentTarget.style.borderColor = "rgba(62,207,122,0.3)";
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                  <span style={{ fontSize: 28 }}>📊</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 16 }}>Cabinet comptable</div>
                    <div style={{ fontSize: 11, color: "var(--green, #3ecf7a)" }}>Plan Cabinet · 49 € HT/mois</div>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>
                  Expert-comptable, comptable indépendant. Gérez plusieurs sociétés
                  clientes depuis un seul espace. Invitez vos collaborateurs.
                </div>
                <div style={{
                  marginTop: 10,
                  padding: "6px 10px",
                  background: "rgba(62,207,122,0.15)",
                  borderRadius: 6,
                  fontSize: 11,
                  color: "var(--green, #3ecf7a)",
                  fontWeight: 600
                }}>
                  🎁 Offre de lancement : 10 PREMIERS CABINETS GRATUITS À VIE
                </div>
              </button>
            </div>

            <div className="auth-switch" style={{ marginTop: 18 }}>
              <a onClick={() => { reset(); setMode("signin"); }}>← Déjà un compte ? Se connecter</a>
            </div>
          </div>
        )}

        {mode === "signup" && (
          <form onSubmit={handleSignUp}>
            <div style={{
              fontSize: 12, color: "var(--muted)", marginBottom: 14,
              padding: "8px 12px",
              background: accountType === "firm" ? "rgba(62,207,122,0.06)" : "rgba(212,168,67,0.06)",
              borderLeft: `3px solid ${accountType === "firm" ? "var(--green, #3ecf7a)" : "var(--gold)"}`,
              borderRadius: 4
            }}>
              {accountType === "firm" ? (
                <>📊 <strong>Compte Cabinet comptable</strong> · 49 €/mois (10 premiers gratuits)</>
              ) : (
                <>🏢 <strong>Compte société</strong> · 9,90 €/mois · 14 jours d'essai</>
              )}
              {" · "}
              <a
                onClick={() => { reset(); setMode("choose"); }}
                style={{ cursor: "pointer", color: "var(--gold)", textDecoration: "underline" }}
              >Changer</a>
            </div>
            <div className="form-row">
              <label className="form-label">
                {accountType === "firm" ? "Nom du cabinet" : "Nom de votre activité"}
              </label>
              <input
                className="form-input"
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
                placeholder={accountType === "firm" ? "Ex : Cabinet Dupont & Associés" : "Ex : Marie Dupont Conseil"}
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
              {accountType === "firm"
                ? "Vous configurerez votre cabinet juste après confirmation par email"
                : "14 jours d'essai gratuit, sans CB requise"}
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
