import React, { useEffect, useState, useRef } from "react";
import { sb } from "../lib/supabase.js";
import { fmtDate } from "../lib/helpers.js";
import { ThreadView } from "./ThreadView.jsx";

/**
 * ChatBubble — v8.28
 * Bulle chat flottante en bas à droite (côté abonné Pro)
 * - Si pas de cabinet rattaché → ne s'affiche pas
 * - Click bulle → panneau ouvre avec liste threads
 * - Click thread → conversation
 * - Compteur unread sur la bulle
 */
export function ChatBubble({ token, user, company }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState("list"); // 'list' | 'thread' | 'new'
  const [firm, setFirm] = useState(null);
  const [threads, setThreads] = useState([]);
  const [activeThread, setActiveThread] = useState(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const pollRef = useRef(null);

  async function loadFirm() {
    console.log("[ChatBubble:debug] loadFirm called, company =", company);
    if (!company?.id) {
      console.log("[ChatBubble:debug] STOP: no company.id");
      return null;
    }
    const links = await sb.select(token, "firm_client_links", {
      filter: `company_id=eq.${company.id}&status=eq.accepted`,
      select: "firm_id",
      limit: 1
    });
    console.log("[ChatBubble:debug] links for company", company.id, "=", links);
    if (!links || links.length === 0) {
      console.log("[ChatBubble:debug] STOP: no accepted link → bubble hidden");
      setFirm(null);
      setLoading(false);
      return null;
    }
    const f = await sb.selectOne(token, "accounting_firms", `id=eq.${links[0].firm_id}`, "*");
    console.log("[ChatBubble:debug] firm loaded =", f);
    setFirm(f);
    return f;
  }

  async function loadThreads(targetFirm) {
    const fm = targetFirm || firm;
    if (!fm?.id || !company?.id) { setLoading(false); return; }
    const rows = await sb.select(token, "firm_threads", {
      filter: `firm_id=eq.${fm.id}&company_id=eq.${company.id}`,
      select: "*",
      order: "last_message_at.desc",
      limit: 50
    });
    setThreads(rows || []);

    // Compter unread
    const unread = await sb.select(token, "firm_messages", {
      filter: `company_id=eq.${company.id}&author_side=eq.firm&read_by_client=eq.false`,
      select: "id",
      limit: 100
    });
    setUnreadCount((unread || []).length);
    setLoading(false);
  }

  useEffect(() => {
    (async () => {
      const f = await loadFirm();
      if (f) await loadThreads(f);
    })();
    // Polling 10s pour les unread
    pollRef.current = setInterval(() => {
      if (firm?.id) loadThreads();
    }, 10000);
    return () => clearInterval(pollRef.current);
  }, [company?.id]);

  // Quand on ouvre, reload
  useEffect(() => {
    if (open && firm) loadThreads();
  }, [open]);

  if (loading || !firm) return null; // pas de bulle si pas de cabinet

  return (
    <>
      {/* Bulle flottante */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          aria-label="Ouvrir messagerie cabinet"
          style={bubbleStyle}
        >
          💬
          {unreadCount > 0 && (
            <span style={{
              position: "absolute", top: -2, right: -2,
              minWidth: 20, height: 20, borderRadius: "50%",
              background: "#e54949", color: "#fff",
              fontSize: 11, fontWeight: 700,
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 0 0 2px var(--bg, #0b0c10)",
              padding: "0 5px"
            }}>
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </button>
      )}

      {/* Panneau ouvert */}
      {open && (
        <div style={panelStyle}>
          {/* Header */}
          <div style={panelHeaderStyle}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              {view !== "list" && (
                <button className="btn btn-ghost btn-sm" onClick={() => { setView("list"); setActiveThread(null); }} style={{ padding: "3px 8px" }}>←</button>
              )}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{firm.name}</div>
                <div style={{ fontSize: 10, color: "var(--muted)" }}>Cabinet comptable</div>
              </div>
            </div>
            <button onClick={() => setOpen(false)} style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", fontSize: 18, padding: 4 }} aria-label="Fermer">×</button>
          </div>

          {/* Contenu */}
          {view === "list" && (
            <ThreadList
              threads={threads}
              token={token}
              onSelect={(t) => { setActiveThread(t); setView("thread"); }}
              onNew={() => setView("new")}
            />
          )}
          {view === "new" && (
            <NewThreadForm
              token={token}
              firm={firm}
              company={company}
              onCreated={async () => {
                await loadThreads();
                setView("list");
              }}
              onCancel={() => setView("list")}
            />
          )}
          {view === "thread" && activeThread && (
            <ThreadView
              token={token}
              user={user}
              threadId={activeThread.id}
              side="client"
              compact
              onBack={() => { setView("list"); setActiveThread(null); loadThreads(); }}
            />
          )}
        </div>
      )}
    </>
  );
}

function ThreadList({ threads, token, onSelect, onNew }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <button className="btn btn-primary btn-sm" onClick={onNew} style={{ width: "100%", fontSize: 12 }}>
          ✏ Nouveau sujet
        </button>
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {threads.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--muted)", fontSize: 11 }}>
            Aucune conversation.<br/>Démarre un nouveau sujet pour échanger avec ton cabinet.
          </div>
        ) : (
          threads.map((t) => (
            <button
              key={t.id}
              onClick={() => onSelect(t)}
              style={threadRowStyle}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 2 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                  {t.subject}
                </span>
                <span style={{ fontSize: 9, color: "var(--muted)", marginLeft: 6, flexShrink: 0 }}>
                  {fmtDate(t.last_message_at)}
                </span>
              </div>
              <div style={{ fontSize: 10, color: "var(--muted)" }}>
                {t.status === "open" ? "🟢" : t.status === "closed" ? "🔒" : "📦"} {t.status === "open" ? "Ouvert" : t.status === "closed" ? "Fermé" : "Archivé"}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function NewThreadForm({ token, firm, company, onCreated, onCancel }) {
  const [subject, setSubject] = useState("");
  const [firstMessage, setFirstMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState(null);

  async function submit() {
    setErr(null);
    if (!subject.trim() || !firstMessage.trim()) {
      setErr("Sujet et message requis");
      return;
    }
    setSending(true);
    const r = await fetch("/api/firm-invitation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action: "thread_create",
        payload: {
          firm_id: firm.id,
          company_id: company.id,
          subject: subject.trim(),
          first_message: firstMessage.trim()
        }
      })
    });
    setSending(false);
    if (!r.ok) { const d = await r.json().catch(() => ({})); setErr(d.error || "Échec"); return; }
    onCreated?.();
  }

  return (
    <div style={{ padding: 12, flex: 1, overflowY: "auto" }}>
      <label style={labelStyle}>Sujet *</label>
      <input
        className="form-input"
        type="text"
        value={subject}
        onChange={(e) => setSubject(e.target.value.slice(0, 200))}
        placeholder="Ex : Question TVA Q1 2026"
        style={{ marginBottom: 10, fontSize: 12 }}
      />

      <label style={labelStyle}>Premier message *</label>
      <textarea
        className="form-input"
        rows={4}
        value={firstMessage}
        onChange={(e) => setFirstMessage(e.target.value.slice(0, 5000))}
        placeholder="Bonjour, j'ai une question concernant..."
        style={{ resize: "vertical", marginBottom: 10, fontSize: 12 }}
      />

      {err && <div className="alert-danger" style={{ marginBottom: 10, fontSize: 11, padding: "4px 8px" }}>{err}</div>}

      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button className="btn btn-ghost btn-sm" onClick={onCancel}>Annuler</button>
        <button className="btn btn-primary btn-sm" onClick={submit} disabled={sending}>
          {sending ? "..." : "📤 Envoyer"}
        </button>
      </div>
    </div>
  );
}

const bubbleStyle = {
  position: "fixed",
  bottom: 20,
  right: 20,
  width: 56,
  height: 56,
  borderRadius: "50%",
  background: "var(--gold)",
  color: "#0b0c10",
  border: "none",
  fontSize: 24,
  cursor: "pointer",
  boxShadow: "0 4px 12px rgba(0,0,0,0.3), 0 0 0 1px rgba(212,168,67,0.4)",
  zIndex: 500,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "transform 0.2s"
};

const panelStyle = {
  position: "fixed",
  bottom: 20,
  right: 20,
  width: 360,
  height: 540,
  maxHeight: "calc(100vh - 40px)",
  background: "var(--bg, #0b0c10)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 12,
  boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
  zIndex: 500,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden"
};

const panelHeaderStyle = {
  padding: "10px 12px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
  background: "rgba(212,168,67,0.08)",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center"
};

const threadRowStyle = {
  width: "100%",
  padding: "10px 12px",
  background: "transparent",
  border: "none",
  borderBottom: "1px solid rgba(255,255,255,0.04)",
  cursor: "pointer",
  textAlign: "left",
  color: "var(--text)"
};

const labelStyle = {
  display: "block",
  fontSize: 10,
  fontWeight: 600,
  color: "var(--muted)",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginBottom: 4
};
