import React from "react";
import { Link } from "react-router-dom";

/**
 * LegalFooter — Footer minimal avec les liens légaux obligatoires.
 * Affiché en bas de chaque page authentifiée.
 */
export function LegalFooter() {
  return (
    <footer style={{
      marginTop: 40,
      padding: "20px 16px",
      borderTop: "1px solid var(--border, rgba(255,255,255,0.06))",
      fontSize: 11,
      color: "var(--muted)",
      textAlign: "center",
      display: "flex",
      justifyContent: "center",
      gap: 16,
      flexWrap: "wrap"
    }}>
      <span>© {new Date().getFullYear()} OWL'S INDUSTRY — IO BILL</span>
      <Link to="/legal/cgu" style={{ color: "var(--muted)", textDecoration: "none" }}>CGU</Link>
      <Link to="/legal/cgv" style={{ color: "var(--muted)", textDecoration: "none" }}>CGV</Link>
      <Link to="/legal/mentions" style={{ color: "var(--muted)", textDecoration: "none" }}>Mentions légales</Link>
      <Link to="/legal/privacy" style={{ color: "var(--muted)", textDecoration: "none" }}>Confidentialité</Link>
      <a href="mailto:contact@iobill.online" style={{ color: "var(--muted)", textDecoration: "none" }}>Contact</a>
    </footer>
  );
}
