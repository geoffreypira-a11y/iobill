import React, { useState } from "react";

/**
 * SupportTicketModal — Modal de création de ticket par un abonné.
 *
 * Usage :
 *   const [open, setOpen] = useState(false);
 *   <button onClick={() => setOpen(true)}>Signaler un problème</button>
 *   {open && <SupportTicketModal token={token} onClose={() => setOpen(false)} />}
 */
export function SupportTicketModal({ token, onClose, onSent }) {
  const [type, setType] = useState("incident");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const [sent, setSent] = useState(false);

  async function send() {
    setErr("");
    if (!message.trim()) { setErr("Décrivez votre problème"); return; }
    setSending(true);
    try {
      const r = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "create_ticket", payload: { type, message: message.trim() } })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Erreur");
      setSent(true);
      onSent && onSent(j.ticket);
      setTimeout(onClose, 2000);
    } catch (e) {
      setErr(e.message || "Erreur réseau");
    }
    setSending(false);
  }

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16
      }}
      onClick={sending ? null : onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--card-bg, #1a1d22)",
          border: "1px solid var(--border, rgba(255,255,255,0.08))",
          borderRadius: 10, padding: 22, maxWidth: 540, width: "100%"
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>🎫 Signaler un problème</div>
          {!sending && (
            <button
              onClick={onClose}
              style={{ background: "transparent", border: 0, color: "var(--muted)", fontSize: 22, cursor: "pointer" }}
            >×</button>
          )}
        </div>

        {sent ? (
          <div style={{ textAlign: "center", padding: 30 }}>
            <div style={{ fontSize: 40, marginBottom: 10 }}>✅</div>
            <div style={{ fontSize: 15, fontWeight: 500 }}>Ticket envoyé !</div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>
              L'équipe IO BILL vous répondra rapidement.
            </div>
          </div>
        ) : (
          <>
            <label className="form-label">Type de demande</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="form-input"
              disabled={sending}
              style={{ marginBottom: 12 }}
            >
              <option value="incident">🔴 Incident technique</option>
              <option value="amelioration">💡 Idée d'amélioration</option>
              <option value="question">❓ Question / Aide</option>
              <option value="facturation">💳 Question de facturation</option>
            </select>

            <label className="form-label">Description</label>
            <textarea
              className="form-input"
              rows={6}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={sending}
              placeholder="Décrivez votre problème ou votre question avec le plus de détails possible (étapes pour reproduire, captures d'écran à venir par mail, etc.)"
              maxLength={5000}
            />
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4, textAlign: "right" }}>
              {message.length} / 5000
            </div>

            {err && (
              <div style={{ marginTop: 10, padding: 10, background: "rgba(224,85,106,0.1)", borderRadius: 6, color: "var(--red, #e0556a)", fontSize: 12 }}>
                {err}
              </div>
            )}

            <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn btn-ghost" onClick={onClose} disabled={sending}>Annuler</button>
              <button className="btn btn-primary" onClick={send} disabled={sending || !message.trim()}>
                {sending ? "Envoi..." : "Envoyer"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
