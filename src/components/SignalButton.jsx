import React, { useState } from "react";

/**
 * SignalButton — v8.27
 * Bouton 🚩 réutilisable avec modal sévérité + commentaire
 * 
 * Props:
 *   token, firm_id, company_id, target_type, target_id
 *   targetLabel (ex: "Facture #FA-2026-001")
 *   compact (bool) → version icône seule
 *   onCreated (callback)
 */
export function SignalButton({ token, firm_id, company_id, target_type, target_id, targetLabel, compact, onCreated }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className={"btn " + (compact ? "btn-icon btn-ghost" : "btn-ghost btn-sm")}
        onClick={() => setOpen(true)}
        title="Signaler une anomalie"
        style={compact ? { padding: "4px 8px", fontSize: 14 } : {}}
      >
        🚩{!compact && " Signaler"}
      </button>

      {open && (
        <SignalModal
          token={token}
          firm_id={firm_id}
          company_id={company_id}
          target_type={target_type}
          target_id={target_id}
          targetLabel={targetLabel}
          onClose={() => setOpen(false)}
          onCreated={() => { setOpen(false); onCreated?.(); }}
        />
      )}
    </>
  );
}

function SignalModal({ token, firm_id, company_id, target_type, target_id, targetLabel, onClose, onCreated }) {
  const [severity, setSeverity] = useState("warning");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [visibleToClient, setVisibleToClient] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  async function submit() {
    setErr(null);
    if (!title.trim()) { setErr("Le titre est requis"); return; }
    setLoading(true);
    const r = await fetch("/api/firm-invitation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action: "signal_create",
        payload: {
          firm_id,
          company_id,
          target_type,
          target_id: target_id || null,
          severity,
          title: title.trim(),
          content: content.trim(),
          visible_to_client: visibleToClient
        }
      })
    });
    const data = await r.json();
    setLoading(false);
    if (!r.ok) { setErr(data.error || "Échec"); return; }
    onCreated?.();
  }

  const SEVERITIES = [
    { key: "info", label: "🟦 Info", desc: "Information / Note" },
    { key: "warning", label: "🟧 Warning", desc: "Anomalie à traiter" },
    { key: "critical", label: "🟥 Urgent", desc: "Bloquant / risque légal" }
  ];

  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div className="card card-pad" style={modalBox} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 4px 0", fontSize: 16 }}>🚩 Nouveau signalement</h3>
        {targetLabel && (
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 16 }}>
            Cible : <strong>{targetLabel}</strong>
          </div>
        )}

        {/* Sévérité */}
        <label className="form-label">Sévérité *</label>
        <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
          {SEVERITIES.map((s) => (
            <button
              key={s.key}
              className={"btn btn-sm " + (severity === s.key ? "btn-gold" : "btn-ghost")}
              onClick={() => setSeverity(s.key)}
              title={s.desc}
              type="button"
            >
              {s.label}
            </button>
          ))}
        </div>

        {/* Titre */}
        <label className="form-label">Titre *</label>
        <input
          type="text"
          className="form-input"
          value={title}
          onChange={(e) => setTitle(e.target.value.slice(0, 200))}
          placeholder="Ex : TVA manquante sur cette facture"
          style={{ marginBottom: 12 }}
        />

        {/* Commentaire */}
        <label className="form-label">Commentaire (optionnel)</label>
        <textarea
          className="form-input"
          rows={4}
          value={content}
          onChange={(e) => setContent(e.target.value.slice(0, 2000))}
          placeholder="Détails, contexte, action attendue du client..."
          style={{ resize: "vertical", minHeight: 80, marginBottom: 12 }}
        />
        <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 16, textAlign: "right" }}>
          {content.length}/2000
        </div>

        {/* Visibilité */}
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, fontSize: 12, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={visibleToClient}
            onChange={(e) => setVisibleToClient(e.target.checked)}
          />
          Visible par le client (sinon : note interne cabinet uniquement)
        </label>

        {err && <div className="alert-danger" style={{ marginBottom: 12, fontSize: 12 }}>{err}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Annuler</button>
          <button className="btn btn-primary btn-sm" onClick={submit} disabled={loading}>
            {loading ? "Envoi..." : "🚩 Créer le signalement"}
          </button>
        </div>
      </div>
    </div>
  );
}

const modalBackdrop = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300, backdropFilter: "blur(4px)" };
const modalBox = { maxWidth: 540, width: "100%", margin: 20, maxHeight: "90vh", overflow: "auto" };
