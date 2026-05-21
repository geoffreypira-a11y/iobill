import React, { useState, useEffect } from "react";

/**
 * TrialBanner — Bandeau de rappel des jours d'essai restants.
 *
 * Affiché en haut du Dashboard quand sub_status === "trialing".
 * Plus discret quand il reste >3 jours, plus alerte quand ≤3 jours.
 *
 * Cliquable → ouvre Stripe Checkout direct.
 */
export function TrialBanner({ token, company }) {
  const [loading, setLoading] = useState(false);

  if (!company || company.sub_status !== "trialing" || !company.trial_ends_at) {
    return null;
  }

  const now = Date.now();
  const endTime = new Date(company.trial_ends_at).getTime();
  const msRemaining = endTime - now;
  const daysRemaining = Math.max(0, Math.ceil(msRemaining / 86400000));

  // Si expiré, on ne montre pas le banner (la route Index redirige vers TrialExpired)
  if (daysRemaining === 0 && msRemaining <= 0) return null;

  const isUrgent = daysRemaining <= 3;

  async function startCheckout() {
    setLoading(true);
    try {
      const r = await fetch("/api/stripe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ plan: "pro_monthly" })
      });
      const j = await r.json();
      if (j?.url) window.location.href = j.url;
      else alert(j?.error || "Erreur Stripe");
    } catch {
      alert("Erreur réseau");
    }
    setLoading(false);
  }

  return (
    <div style={{
      marginBottom: 18,
      padding: "12px 16px",
      background: isUrgent ? "rgba(232,150,61,0.08)" : "rgba(212,168,67,0.06)",
      border: `1px solid ${isUrgent ? "rgba(232,150,61,0.3)" : "rgba(212,168,67,0.25)"}`,
      borderRadius: 8,
      display: "flex",
      alignItems: "center",
      gap: 14,
      flexWrap: "wrap"
    }}>
      <span style={{ fontSize: 22 }}>{isUrgent ? "⚠️" : "⏳"}</span>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>
          {daysRemaining === 1
            ? "Dernier jour de votre essai gratuit"
            : `Il vous reste ${daysRemaining} jours d'essai gratuit`}
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
          Souscrivez à IO BILL Pro pour ne pas perdre l'accès à vos données.
        </div>
      </div>
      <button
        onClick={startCheckout}
        disabled={loading}
        style={{
          padding: "8px 14px",
          background: isUrgent ? "var(--orange, #e8963d)" : "var(--gold, #d4a843)",
          color: "#1a1d22",
          border: 0,
          borderRadius: 6,
          fontSize: 12,
          fontWeight: 600,
          cursor: loading ? "default" : "pointer",
          opacity: loading ? 0.6 : 1,
          whiteSpace: "nowrap"
        }}
      >
        {loading ? "..." : "💳 Souscrire maintenant"}
      </button>
    </div>
  );
}

/**
 * Utilitaire : vérifie si le trial est expiré.
 * Utilisé par IndexRoute dans App.jsx pour rediriger vers TrialExpiredPage.
 */
export function isTrialExpired(company) {
  if (!company) return false;
  if (company.sub_status !== "trialing") return false;
  if (!company.trial_ends_at) return false;
  return new Date(company.trial_ends_at).getTime() < Date.now();
}
