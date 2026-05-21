import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { fmtDate } from "../../lib/helpers.js";

/**
 * MySignalsPage — v8.27.3
 * Page /signals côté abonné Pro : liste tous les signalements du cabinet
 */
export function MySignalsPage({ token, user, company }) {
  const [signals, setSignals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("open");
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewTitle, setPreviewTitle] = useState("");

  async function load() {
    if (!company?.id) { setLoading(false); return; }
    setLoading(true);
    const rows = await sb.select(token, "firm_signals", {
      filter: `company_id=eq.${company.id}&visible_to_client=eq.true`,
      select: "*",
      order: "created_at.desc",
      limit: 100
    });
    // Hydrater nom cabinet + libellé du document cible
    const out = [];
    for (const s of (rows || [])) {
      const firm = await sb.selectOne(token, "accounting_firms", `id=eq.${s.firm_id}`, "name");
      let targetDoc = null;
      if (s.target_id) {
        if (s.target_type === "invoice") {
          targetDoc = await sb.selectOne(token, "invoices", `id=eq.${s.target_id}`, "number,total_ttc_cents,issue_date,pdf_url,facturx_pdf_url");
        } else if (s.target_type === "purchase") {
          targetDoc = await sb.selectOne(token, "purchases", `id=eq.${s.target_id}`, "number,vendor_name,total_ttc_cents,issue_date,pdf_url");
        }
      }
      out.push({ ...s, _firmName: firm?.name, _targetDoc: targetDoc });
    }
    setSignals(out);
    setLoading(false);
  }

  useEffect(() => { load(); }, [company?.id]);

  async function action(signalId, act, response = null) {
    const labels = { 
      signal_resolve: "Marquer comme résolu ?",
      signal_respond: null  // utilisé en interne, pas confirm
    };
    if (labels[act] && !confirm(labels[act])) return;
    const r = await fetch("/api/firm-invitation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: act, payload: { signal_id: signalId, ...(response ? { response } : {}) } })
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); alert(d.error || "Échec"); return; }
    load();
  }

  if (loading) return <div style={loadingStyle}>Chargement...</div>;

  const filtered = signals.filter((s) => filter === "all" || s.status === filter);
  const counts = {
    open: signals.filter((s) => s.status === "open").length,
    resolved: signals.filter((s) => s.status === "resolved").length,
    dismissed: signals.filter((s) => s.status === "dismissed").length
  };

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "20px 24px" }}>
      <h1 style={{ fontFamily: "Syne, sans-serif", fontSize: 32, fontWeight: 700, margin: "0 0 8px 0", letterSpacing: "-0.02em" }}>
        SIGNALEMENTS
      </h1>
      <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 24 }}>
        Anomalies et demandes signalées par votre cabinet comptable
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        <button className={"btn btn-sm " + (filter === "open" ? "btn-gold" : "btn-ghost")} onClick={() => setFilter("open")}>
          ⏳ Ouverts ({counts.open})
        </button>
        <button className={"btn btn-sm " + (filter === "resolved" ? "btn-gold" : "btn-ghost")} onClick={() => setFilter("resolved")}>
          ✅ Résolus ({counts.resolved})
        </button>
        <button className={"btn btn-sm " + (filter === "dismissed" ? "btn-gold" : "btn-ghost")} onClick={() => setFilter("dismissed")}>
          🚫 Classés ({counts.dismissed})
        </button>
        <button className={"btn btn-sm " + (filter === "all" ? "btn-gold" : "btn-ghost")} onClick={() => setFilter("all")}>
          Tous
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="card card-pad" style={{ textAlign: "center", padding: 60, color: "var(--muted)" }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>{filter === "open" ? "✨" : "—"}</div>
          <div style={{ fontSize: 14 }}>
            {filter === "open" ? "Aucune anomalie ouverte. Tout est à jour." : "Aucun signalement dans ce filtre."}
          </div>
        </div>
      ) : (
        filtered.map((s) => (
          <SignalCard 
            key={s.id} 
            signal={s} 
            onAction={action}
            onPreview={(url, title) => { setPreviewUrl(url); setPreviewTitle(title); }}
          />
        ))
      )}

      {previewUrl && (
        <PdfPreviewModal url={previewUrl} title={previewTitle} onClose={() => setPreviewUrl(null)} />
      )}
    </div>
  );
}

function PdfPreviewModal({ url, title, onClose }) {
  return (
    <div style={pdfModalBackdrop} onClick={onClose}>
      <div className="card" style={pdfModalBox} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          <strong style={{ fontSize: 13 }}>{title}</strong>
          <div style={{ display: "flex", gap: 6 }}>
            <a href={url} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm" style={{ textDecoration: "none" }}>
              ⤴ Ouvrir
            </a>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>✕ Fermer</button>
          </div>
        </div>
        <div style={{ flex: 1, background: "#fff", overflow: "hidden" }}>
          <iframe src={url} title={title} style={{ width: "100%", height: "100%", border: "none" }} />
        </div>
      </div>
    </div>
  );
}

function SignalCard({ signal, onAction, onPreview }) {
  const [responding, setResponding] = useState(false);
  const [responseText, setResponseText] = useState("");

  async function submitResponse() {
    if (!responseText.trim()) return;
    await onAction(signal.id, "signal_respond", responseText.trim());
    setResponding(false);
    setResponseText("");
  }

  const pdfUrl = signal._targetDoc?.facturx_pdf_url || signal._targetDoc?.pdf_url || null;
  const docLabel = signal._targetDoc?.number || signal._targetDoc?.vendor_name || "";
  const targetLabel = signal.target_type === "invoice" 
    ? `Facture ${docLabel}` 
    : signal.target_type === "purchase" 
      ? `Achat ${docLabel}` 
      : "Document";

  return (
    <div className="card" style={{ padding: 14, marginBottom: 8, border: `1px solid ${SEV_BORDER[signal.severity]}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
            <span>{SEV_EMOJI[signal.severity]}</span>
            <strong style={{ fontSize: 14 }}>{signal.title}</strong>
            <StatusBadgeSignal status={signal.status} />
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>
            Cabinet {signal._firmName} · {TARGET_LABEL[signal.target_type] || signal.target_type}
            {signal._targetDoc && (
              <span style={{ marginLeft: 4 }}>
                · <strong>{signal._targetDoc.number || signal._targetDoc.vendor_name || ""}</strong>
              </span>
            )}
            <span> · Créé le {fmtDate(signal.created_at)}</span>
          </div>
          {signal.content && (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted2)", whiteSpace: "pre-wrap" }}>
              {signal.content}
            </div>
          )}
          {signal.client_response && (
            <div style={{ marginTop: 8, padding: "6px 10px", background: "rgba(62,207,122,0.08)", borderRadius: 4, fontSize: 12 }}>
              💬 <strong>Vous avez répondu</strong> ({fmtDate(signal.client_responded_at)}) : {signal.client_response}
            </div>
          )}
        </div>
        {signal.status === "open" && !responding && (
          <div style={{ display: "flex", gap: 4 }}>
            {pdfUrl && (
              <button 
                className="btn btn-ghost btn-sm" 
                onClick={() => onPreview(pdfUrl, targetLabel)}
                title="Voir le document"
              >
                👁 Voir
              </button>
            )}
            <button className="btn btn-ghost btn-sm" onClick={() => setResponding(true)}>💬 Répondre</button>
            <button className="btn btn-primary btn-sm" onClick={() => onAction(signal.id, "signal_resolve")}>✅ Résoudre</button>
          </div>
        )}
        {signal.status !== "open" && pdfUrl && (
          <button 
            className="btn btn-ghost btn-sm" 
            onClick={() => onPreview(pdfUrl, targetLabel)}
            title="Voir le document"
          >
            👁 Voir
          </button>
        )}
      </div>

      {responding && (
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
            <button className="btn btn-ghost btn-sm" onClick={() => { setResponding(false); setResponseText(""); }}>Annuler</button>
            <button className="btn btn-primary btn-sm" onClick={submitResponse} disabled={!responseText.trim()}>Envoyer</button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadgeSignal({ status }) {
  const map = {
    open: { label: "⏳ Ouvert", cls: "badge-orange" },
    resolved: { label: "✅ Résolu", cls: "badge-green" },
    dismissed: { label: "🚫 Classé", cls: "badge-muted" }
  };
  const m = map[status] || { label: status, cls: "badge-muted" };
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

const SEV_EMOJI = { info: "🟦", warning: "🟧", critical: "🟥" };
const SEV_BORDER = {
  info: "rgba(91, 159, 255, 0.3)",
  warning: "rgba(229,151,60,0.3)",
  critical: "rgba(229,73,73,0.5)"
};
const TARGET_LABEL = {
  invoice: "Facture",
  quote: "Devis",
  credit_note: "Avoir",
  purchase: "Achat",
  client: "Client",
  general: "Général"
};
const loadingStyle = { minHeight: 400, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 13 };

const pdfModalBackdrop = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.85)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 400, padding: 20 };
const pdfModalBox = { width: "100%", maxWidth: 1100, height: "92vh", display: "flex", flexDirection: "column", overflow: "hidden", padding: 0 };
