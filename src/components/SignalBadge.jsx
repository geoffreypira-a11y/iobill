import React, { useState } from "react";
import { fmtDate } from "../lib/helpers.js";

/**
 * SignalBadge — v8.27 (côté client)
 * Affiche les signalements ouverts sur un document.
 * Click → panneau de détail avec bouton "Marquer comme résolu" / "Répondre"
 */
export function SignalBadge({ signals, token, onAction }) {
  const [open, setOpen] = useState(false);
  const openSignals = (signals || []).filter((s) => s.status === "open" && s.visible_to_client);

  if (openSignals.length === 0) return null;

  // Sévérité max
  const maxSev = openSignals.some((s) => s.severity === "critical") ? "critical"
    : openSignals.some((s) => s.severity === "warning") ? "warning" : "info";

  return (
    <>
      <button
        className="btn btn-icon"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        title={`${openSignals.length} signalement${openSignals.length > 1 ? "s" : ""} ouvert${openSignals.length > 1 ? "s" : ""}`}
        style={{ padding: "2px 6px", fontSize: 14, background: "transparent", border: "none", cursor: "pointer" }}
      >
        {SEV_EMOJI[maxSev]}
        {openSignals.length > 1 && (
          <span style={{ fontSize: 9, color: "var(--muted)", marginLeft: 2 }}>×{openSignals.length}</span>
        )}
      </button>

      {open && (
        <SignalDetailPanel
          signals={openSignals}
          token={token}
          onClose={() => setOpen(false)}
          onAction={() => { setOpen(false); onAction?.(); }}
        />
      )}
    </>
  );
}

function SignalDetailPanel({ signals, token, onClose, onAction }) {
  const [responding, setResponding] = useState(null); // id du signal en cours de réponse
  const [responseText, setResponseText] = useState("");

  async function resolve(id) {
    if (!confirm("Marquer ce signalement comme résolu ?")) return;
    const r = await fetch("/api/firm-signal", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "resolve", payload: { signal_id: id } })
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); alert(d.error || "Échec"); return; }
    onAction();
  }

  async function respond(id) {
    if (!responseText.trim()) return;
    const r = await fetch("/api/firm-signal", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "respond", payload: { signal_id: id, response: responseText.trim() } })
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); alert(d.error || "Échec"); return; }
    setResponding(null);
    setResponseText("");
    onAction();
  }

  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div className="card card-pad" style={modalBox} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 12px 0", fontSize: 16 }}>
          🚩 Signalement{signals.length > 1 ? `s (${signals.length})` : ""} de votre cabinet
        </h3>

        {signals.map((s) => (
          <div key={s.id} className="card" style={{ padding: 12, marginBottom: 10, border: `1px solid ${SEV_BORDER[s.severity]}` }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
              <span>{SEV_EMOJI[s.severity]}</span>
              <strong style={{ fontSize: 13 }}>{s.title}</strong>
            </div>
            <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 8 }}>
              Le {fmtDate(s.created_at)}
            </div>
            {s.content && (
              <div style={{ fontSize: 12, color: "var(--muted2)", whiteSpace: "pre-wrap", marginBottom: 8 }}>
                {s.content}
              </div>
            )}
            {s.client_response && (
              <div style={{ marginTop: 8, padding: "6px 10px", background: "rgba(62,207,122,0.08)", borderRadius: 4, fontSize: 11 }}>
                💬 Vous avez répondu le {fmtDate(s.client_responded_at)} : {s.client_response}
              </div>
            )}

            {responding === s.id ? (
              <div style={{ marginTop: 10 }}>
                <textarea
                  className="form-input"
                  rows={3}
                  value={responseText}
                  onChange={(e) => setResponseText(e.target.value.slice(0, 2000))}
                  placeholder="Votre réponse au cabinet..."
                  style={{ resize: "vertical", minHeight: 60, marginBottom: 6 }}
                />
                <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setResponding(null); setResponseText(""); }}>Annuler</button>
                  <button className="btn btn-primary btn-sm" onClick={() => respond(s.id)} disabled={!responseText.trim()}>Envoyer</button>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", marginTop: 8 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setResponding(s.id)}>💬 Répondre</button>
                <button className="btn btn-primary btn-sm" onClick={() => resolve(s.id)}>✅ Résoudre</button>
              </div>
            )}
          </div>
        ))}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Fermer</button>
        </div>
      </div>
    </div>
  );
}

const SEV_EMOJI = { info: "🟦", warning: "🟧", critical: "🟥" };
const SEV_BORDER = {
  info: "rgba(91, 159, 255, 0.3)",
  warning: "rgba(229,151,60,0.3)",
  critical: "rgba(229,73,73,0.5)"
};
const modalBackdrop = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300, backdropFilter: "blur(4px)" };
const modalBox = { maxWidth: 600, width: "100%", margin: 20, maxHeight: "85vh", overflow: "auto" };
