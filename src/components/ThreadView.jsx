import React, { useEffect, useState, useRef } from "react";
import { sb } from "../lib/supabase.js";
import { fmtDate } from "../lib/helpers.js";
import { ThreadComposer } from "./ThreadComposer.jsx";

/**
 * ThreadView — v8.28
 * Vue détail d'un thread : liste messages + composer
 * Realtime via polling 5s (simple et fiable)
 */
export function ThreadView({ token, user, threadId, side, onBack, compact, onStatusChange }) {
  const [thread, setThread] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const messagesEndRef = useRef(null);
  const pollRef = useRef(null);

  async function load(silent = false) {
    if (!threadId) return;
    if (!silent) setLoading(true);
    const t = await sb.selectOne(token, "firm_threads", `id=eq.${threadId}`, "*");
    setThread(t);
    if (t) {
      const msgs = await sb.select(token, "firm_messages", {
        filter: `thread_id=eq.${threadId}`,
        select: "*",
        order: "created_at.asc",
        limit: 500
      });
      setMessages(msgs || []);
      // Marquer comme lus
      await fetch("/api/firm-invitation", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "message_mark_read", payload: { thread_id: threadId } })
      });
    }
    if (!silent) setLoading(false);
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: silent ? "instant" : "smooth" }), 100);
  }

  // Polling toutes les 5s
  useEffect(() => {
    if (!threadId) return;
    load();
    pollRef.current = setInterval(() => load(true), 5000);
    return () => clearInterval(pollRef.current);
  }, [threadId]);

  if (loading) return <div style={loadingStyle}>Chargement...</div>;
  if (!thread) return <div style={loadingStyle}>Thread introuvable</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Header */}
      <div style={{ padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
          {onBack && <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ padding: "4px 8px" }}>←</button>}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{thread.subject}</div>
            <div style={{ fontSize: 10, color: "var(--muted)" }}>
              {thread.status === "open" ? "🟢 Ouvert" : thread.status === "closed" ? "🔒 Fermé" : "📦 Archivé"}
            </div>
          </div>
        </div>
        {!compact && <ThreadActions thread={thread} token={token} onChanged={() => load(true)} onStatusChange={onStatusChange} />}
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: 10, minHeight: 0 }}>
        {messages.length === 0 ? (
          <div style={{ textAlign: "center", padding: 30, color: "var(--muted)", fontSize: 11 }}>
            Aucun message
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} mySide={side} token={token} />)
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Composer */}
      {thread.status === "open" && (
        <ThreadComposer token={token} threadId={threadId} onSent={() => load(true)} compact={compact} />
      )}
      {thread.status !== "open" && (
        <div style={{ padding: 10, textAlign: "center", color: "var(--muted)", fontSize: 11, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
          {thread.status === "closed" ? "Sujet fermé" : "Sujet archivé"}
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message, mySide, token }) {
  const isMine = message.author_side === mySide;
  const time = new Date(message.created_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const day = fmtDate(message.created_at);
  const atts = Array.isArray(message.attachments) ? message.attachments : [];

  return (
    <div style={{ display: "flex", justifyContent: isMine ? "flex-end" : "flex-start", marginBottom: 8 }}>
      <div style={{
        maxWidth: "78%",
        padding: "8px 12px",
        background: isMine ? "rgba(212,168,67,0.15)" : "rgba(255,255,255,0.05)",
        border: `1px solid ${isMine ? "rgba(212,168,67,0.3)" : "rgba(255,255,255,0.08)"}`,
        borderRadius: 8
      }}>
        <div style={{ fontSize: 9, color: "var(--muted)", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>
          {isMine
            ? "👤 Vous"
            : message.author_side === "firm"
              ? "🏢 Cabinet"
              : "👤 Client"} · {day} {time}
        </div>
        <div style={{ fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{message.content}</div>
        {atts.length > 0 && (
          <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 4 }}>
            {atts.map((a, i) => (
              <AttachmentLink key={i} attachment={a} threadId={message.thread_id} token={token} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * AttachmentLink — demande une URL signée à la volée au clic,
 * puis ouvre dans un nouvel onglet. Compatible avec les anciens messages
 * qui n'avaient qu'une `url` publique (fallback).
 */
function AttachmentLink({ attachment, threadId, token }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function handleClick(e) {
    e.preventDefault();
    if (busy) return;
    setErr(null);

    // Si on a un path, on demande une URL signée
    if (attachment.path) {
      setBusy(true);
      try {
        const r = await fetch("/api/firm-invitation", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            action: "attachment_signed_url",
            payload: { thread_id: threadId, path: attachment.path }
          })
        });
        const j = await r.json();
        setBusy(false);
        if (!r.ok || !j.url) {
          setErr(j.error || "Lien indisponible");
          return;
        }
        window.open(j.url, "_blank", "noopener,noreferrer");
      } catch (e) {
        setBusy(false);
        setErr("Erreur réseau");
      }
      return;
    }

    // Fallback : ancienne URL publique stockée (messages d'avant v8.30)
    if (attachment.url) {
      window.open(attachment.url, "_blank", "noopener,noreferrer");
      return;
    }
    setErr("Pièce jointe inaccessible");
  }

  return (
    <a
      href="#"
      onClick={handleClick}
      title={err || (busy ? "Chargement…" : attachment.name)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 8px",
        background: "rgba(0,0,0,0.2)",
        borderRadius: 4,
        fontSize: 10,
        color: err ? "var(--red)" : "var(--gold)",
        textDecoration: "none",
        opacity: busy ? 0.6 : 1,
        cursor: busy ? "wait" : "pointer"
      }}
    >
      {busy ? "⏳" : iconFor(attachment.type)} {attachment.name}
    </a>
  );
}

function ThreadActions({ thread, token, onChanged, onStatusChange }) {
  async function action(act) {
    if (!confirm(act === "thread_close" ? "Fermer ce sujet ?" : act === "thread_reopen" ? "Réouvrir ?" : "Archiver ?")) return;
    const r = await fetch("/api/firm-invitation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: act, payload: { thread_id: thread.id } })
    });
    if (r.ok) {
      // Notifier le parent du changement de statut pour MAJ immédiate de la liste
      const newStatus = act === "thread_close" ? "closed" : act === "thread_reopen" ? "open" : "archived";
      onStatusChange?.(thread.id, newStatus);
      onChanged?.();
    }
  }
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {thread.status === "open" && (
        <button className="btn btn-ghost btn-sm" onClick={() => action("thread_close")} style={{ padding: "3px 8px", fontSize: 10 }}>🔒 Fermer</button>
      )}
      {thread.status === "closed" && (
        <button className="btn btn-ghost btn-sm" onClick={() => action("thread_reopen")} style={{ padding: "3px 8px", fontSize: 10 }}>🔓 Réouvrir</button>
      )}
      {thread.status !== "archived" && (
        <button className="btn btn-ghost btn-sm" onClick={() => action("thread_archive")} style={{ padding: "3px 8px", fontSize: 10 }}>📦 Archiver</button>
      )}
    </div>
  );
}

function iconFor(type) {
  if (!type) return "📄";
  if (type.startsWith("image/")) return "🖼";
  if (type.includes("pdf")) return "📕";
  if (type.includes("excel") || type.includes("spreadsheet")) return "📊";
  if (type.includes("word") || type.includes("document")) return "📝";
  if (type.includes("zip")) return "🗜";
  return "📄";
}

const loadingStyle = { padding: 30, textAlign: "center", color: "var(--muted)", fontSize: 12 };
