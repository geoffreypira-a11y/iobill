import React, { useState, useRef } from "react";

const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL || "";
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 5;

/**
 * ThreadComposer — v8.28
 * Textarea + upload PJ Supabase Storage
 */
export function ThreadComposer({ token, threadId, onSent, disabled, compact }) {
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState(null);
  const fileInputRef = useRef(null);

  async function uploadFile(file) {
    if (file.size > MAX_FILE_SIZE) {
      setErr(`Trop volumineux (max 10 MB) : ${file.name}`);
      return null;
    }
    const ext = file.name.split(".").pop();
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const path = `thread_${threadId}/${filename}`;

    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/firm-attachments/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": file.type || "application/octet-stream",
        "x-upsert": "false"
      },
      body: file
    });
    if (!r.ok) {
      console.error("[upload] fail:", await r.text());
      setErr(`Échec upload : ${file.name}`);
      return null;
    }
    return {
      name: file.name,
      path,
      url: `${SUPABASE_URL}/storage/v1/object/public/firm-attachments/${path}`,
      size: file.size,
      type: file.type
    };
  }

  async function handleFiles(e) {
    setErr(null);
    const files = Array.from(e.target.files || []);
    if (attachments.length + files.length > MAX_FILES) {
      setErr(`Max ${MAX_FILES} fichiers`);
      return;
    }
    const placeholders = files.map((f) => ({ name: f.name, size: f.size, type: f.type, uploading: true }));
    setAttachments((prev) => [...prev, ...placeholders]);

    const uploaded = [];
    for (const f of files) {
      const result = await uploadFile(f);
      if (result) uploaded.push(result);
    }
    setAttachments((prev) => [...prev.filter((a) => !a.uploading), ...uploaded]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeAttachment(idx) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  async function send() {
    setErr(null);
    if (!content.trim() && attachments.length === 0) return;
    if (attachments.some((a) => a.uploading)) { setErr("Upload en cours..."); return; }
    setSending(true);
    const r = await fetch("/api/firm-invitation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action: "message_send",
        payload: {
          thread_id: threadId,
          content: content.trim() || "📎 Pièce jointe",
          attachments: attachments.map(({ name, url, size, type, path }) => ({ name, url, size, type, path }))
        }
      })
    });
    setSending(false);
    if (!r.ok) { const d = await r.json().catch(() => ({})); setErr(d.error || "Échec envoi"); return; }
    setContent("");
    setAttachments([]);
    onSent?.();
  }

  const pad = compact ? 8 : 12;

  return (
    <div style={{ padding: pad, borderTop: "1px solid rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.02)" }}>
      {attachments.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}>
          {attachments.map((a, idx) => (
            <div key={idx} style={{ padding: "3px 8px", fontSize: 10, display: "flex", alignItems: "center", gap: 4, background: "rgba(255,255,255,0.05)", borderRadius: 4 }}>
              {a.uploading ? "⏳ " : iconFor(a.type) + " "}{a.name}
              {!a.uploading && (
                <button onClick={() => removeAttachment(idx)} style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", padding: 0, marginLeft: 2 }}>×</button>
              )}
            </div>
          ))}
        </div>
      )}

      <textarea
        className="form-input"
        rows={compact ? 2 : 3}
        value={content}
        onChange={(e) => setContent(e.target.value.slice(0, 5000))}
        placeholder="Écrire un message..."
        disabled={disabled || sending}
        style={{ resize: "vertical", minHeight: compact ? 40 : 60, marginBottom: 6, fontSize: compact ? 12 : 13 }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
        }}
      />

      {err && <div className="alert-danger" style={{ marginBottom: 6, fontSize: 10, padding: "4px 8px" }}>{err}</div>}

      <div style={{ display: "flex", gap: 6, justifyContent: "space-between", alignItems: "center" }}>
        <input
          type="file"
          ref={fileInputRef}
          multiple
          accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.zip,.txt"
          onChange={handleFiles}
          style={{ display: "none" }}
        />
        <button className="btn btn-ghost btn-sm" onClick={() => fileInputRef.current?.click()} disabled={disabled || sending} title="Joindre">
          📎
        </button>
        <button className="btn btn-primary btn-sm" onClick={send} disabled={disabled || sending || (!content.trim() && attachments.length === 0)}>
          {sending ? "..." : "📤 Envoyer"}
        </button>
      </div>
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
