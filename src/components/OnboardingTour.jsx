import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

const TOUR_KEY = "iobill_tour_done";

const STEPS = [
  {
    icon: "🦉",
    title: "Bienvenue dans IO BILL",
    body: "Le bijou de l'entrepreneur 2.0. Voici une visite rapide en 30 secondes pour découvrir les essentiels.",
    cta: "Commencer →"
  },
  {
    icon: "👥",
    title: "1. Créez vos clients",
    body: "Allez dans Clients pour ajouter votre premier client. SIRET → l'adresse est récupérée automatiquement, le n° de TVA intracom est vérifié via VIES.",
    cta: "Suivant →",
    targetUrl: "/clients"
  },
  {
    icon: "📝",
    title: "2. Émettez un devis",
    body: "Devis → + Nouveau. Le client est pré-rempli, ajoutez vos lignes, et envoyez pour signature électronique Yousign en un clic.",
    cta: "Suivant →"
  },
  {
    icon: "📩",
    title: "3. Convertissez en facture",
    body: "Une fois le devis signé, un seul clic suffit pour le convertir en facture. Le PDF Factur-X (PDF/A-3 + XML CII) est généré automatiquement, conforme 2026/2027.",
    cta: "Suivant →"
  },
  {
    icon: "💳",
    title: "4. Encaissez en ligne",
    body: "Chaque facture émise dispose automatiquement d'un Stripe Payment Link. Votre client peut régler en CB, et le lettrage est automatique via Bridge (PSD2).",
    cta: "Suivant →"
  },
  {
    icon: "📊",
    title: "5. Pilotez votre activité",
    body: "Le dashboard affiche votre CA, encours, retards, prochaines échéances TVA/URSSAF. Le journal d'audit trace toutes vos actions, conforme à la DGFiP.",
    cta: "C'est parti ! 🚀"
  }
];

export function OnboardingTour({ user, company, onComplete }) {
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);
  const navigate = useNavigate();

  // Affichage : seulement si jamais fait + company existe + pas en mode public
  useEffect(() => {
    try {
      const done = localStorage.getItem(TOUR_KEY);
      if (!done && company?.id) {
        setTimeout(() => setVisible(true), 800); // delai apres bootstrap
      }
    } catch {}
  }, [company?.id]);

  function close(viaCompletion = false) {
    setVisible(false);
    try { localStorage.setItem(TOUR_KEY, viaCompletion ? "done" : "skipped"); } catch {}
    onComplete?.();
  }

  function next() {
    if (step >= STEPS.length - 1) {
      close(true);
      return;
    }
    setStep((s) => s + 1);
  }

  if (!visible) return null;

  const cur = STEPS[step];
  const progress = ((step + 1) / STEPS.length) * 100;

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 9998,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      animation: "fadein 0.25s ease-out"
    }}>
      <div style={{
        background: "var(--card)", border: "1px solid var(--border2)", borderRadius: 14,
        padding: 30, maxWidth: 480, width: "100%", position: "relative",
        boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
        animation: "slideup 0.3s ease-out"
      }}>
        {/* Skip button */}
        <button
          onClick={() => close(false)}
          style={{
            position: "absolute", top: 12, right: 12, background: "transparent",
            border: "none", color: "var(--muted)", cursor: "pointer",
            fontSize: 11, padding: "4px 8px"
          }}
        >
          Ignorer ✕
        </button>

        {/* Progress bar */}
        <div style={{ height: 3, background: "var(--card2)", borderRadius: 2, overflow: "hidden", marginBottom: 24 }}>
          <div style={{
            height: "100%", width: `${progress}%`, background: "var(--gold)",
            transition: "width 0.3s ease"
          }} />
        </div>

        <div style={{ fontSize: 50, textAlign: "center", marginBottom: 18 }}>{cur.icon}</div>

        <h2 style={{
          fontFamily: "Syne, sans-serif", fontSize: 20, fontWeight: 800,
          letterSpacing: 1, textAlign: "center", marginBottom: 14, color: "var(--text)"
        }}>
          {cur.title}
        </h2>

        <p style={{
          fontSize: 14, color: "var(--muted2)", lineHeight: 1.7, textAlign: "center",
          marginBottom: 24
        }}>
          {cur.body}
        </p>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>
            Étape {step + 1} / {STEPS.length}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {step > 0 && (
              <button className="btn btn-ghost" onClick={() => setStep((s) => s - 1)}>
                ← Précédent
              </button>
            )}
            <button className="btn btn-primary" onClick={next}>
              {cur.cta}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Helper pour relancer le tour depuis Settings
export function resetTour() {
  try { localStorage.removeItem(TOUR_KEY); } catch {}
  window.location.reload();
}
