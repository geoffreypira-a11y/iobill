import React, { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { useMyFirm } from "../../components/FirmMode.jsx";
import { fmtDate } from "../../lib/helpers.js";
import { ThreadView } from "../../components/ThreadView.jsx";

/**
 * FirmMessagesPage — v8.29
 * 3 colonnes : clients | threads du client (filtrés) | conversation
 * Filtres statuts : open (défaut) | closed | archived | all
 */
export function FirmMessagesPage({ token, user, company }) {
  const { loading: firmLoading, firm } = useMyFirm(token, user?.id);
  const [searchParams, setSearchParams] = useSearchParams();
  const [clients, setClients] = useState([]); // [{link, company, unreadCount, lastThreadAt}]
  const [selectedClient, setSelectedClient] = useState(null);
  const [threads, setThreads] = useState([]); // tous les threads du client (tous statuts)
  const [selectedThread, setSelectedThread] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showNewThread, setShowNewThread] = useState(false);
  const [statusFilter, setStatusFilter] = useState("open"); // 'open' | 'closed' | 'archived' | 'all'

  async function loadClients() {
    if (!firm?.id) return;
    setLoading(true);
    const links = await sb.select(token, "firm_client_links", {
      filter: `firm_id=eq.${firm.id}&status=eq.accepted`,
      select: "*",
      order: "created_at.desc",
      limit: 200
    });
    const out = [];
    for (const l of (links || [])) {
      const c = await sb.selectOne(token, "companies", `id=eq.${l.company_id}`, "id,legal_name,siret");
      if (!c) continue;
      // Compter unread
      const unread = await sb.select(token, "firm_messages", {
        filter: `firm_id=eq.${firm.id}&company_id=eq.${l.company_id}&author_side=eq.client&read_by_firm=eq.false`,
        select: "id",
        limit: 100
      });
      // Dernier thread activity
      const lastThread = await sb.select(token, "firm_threads", {
        filter: `firm_id=eq.${firm.id}&company_id=eq.${l.company_id}`,
        select: "last_message_at",
        order: "last_message_at.desc",
        limit: 1
      });
      out.push({
        link: l,
        company: c,
        unreadCount: (unread || []).length,
        lastThreadAt: lastThread?.[0]?.last_message_at
      });
    }
    // Trier par unread d'abord puis par dernière activité
    out.sort((a, b) => {
      if (a.unreadCount !== b.unreadCount) return b.unreadCount - a.unreadCount;
      return new Date(b.lastThreadAt || 0) - new Date(a.lastThreadAt || 0);
    });
    setClients(out);
    setLoading(false);

    // Sélectionner par défaut le premier client (ou celui dans l'URL)
    const threadIdFromUrl = searchParams.get("thread");
    if (threadIdFromUrl && out.length > 0) {
      // Chercher le client qui a ce thread
      for (const c of out) {
        const ts = await sb.select(token, "firm_threads", {
          filter: `id=eq.${threadIdFromUrl}&firm_id=eq.${firm.id}&company_id=eq.${c.company.id}`,
          select: "id,status",
          limit: 1
        });
        if (ts && ts.length > 0) {
          setSelectedClient(c);
          // Si le thread n'est pas dans le filtre courant, on bascule le filtre
          if (ts[0].status && ts[0].status !== statusFilter && statusFilter !== "all") {
            setStatusFilter(ts[0].status);
          }
          await loadThreads(c, threadIdFromUrl);
          return;
        }
      }
    }
    if (out.length > 0 && !selectedClient) {
      setSelectedClient(out[0]);
      await loadThreads(out[0]);
    }
  }

  async function loadThreads(client, preselectThreadId = null) {
    if (!client || !firm?.id) return;
    const rows = await sb.select(token, "firm_threads", {
      filter: `firm_id=eq.${firm.id}&company_id=eq.${client.company.id}`,
      select: "*",
      order: "last_message_at.desc",
      limit: 200
    });
    setThreads(rows || []);

    if (preselectThreadId) {
      const t = (rows || []).find((tr) => tr.id === preselectThreadId);
      if (t) setSelectedThread(t);
    }
    // Note: la sélection automatique du premier thread se fait dans un useEffect
    // pour rester cohérente avec le filtre courant
  }

  // Threads filtrés selon le statut courant
  const visibleThreads = threads.filter((t) => {
    if (statusFilter === "all") return true;
    return t.status === statusFilter;
  });

  // Compteurs par statut pour les onglets
  const counts = threads.reduce((acc, t) => {
    acc[t.status] = (acc[t.status] || 0) + 1;
    return acc;
  }, { open: 0, closed: 0, archived: 0 });

  // Sélection automatique du premier thread visible (ou désélection si vide)
  useEffect(() => {
    if (visibleThreads.length === 0) {
      setSelectedThread(null);
      return;
    }
    // Si le thread courant n'est plus visible (changement de filtre ou archivage), on en choisit un autre
    const stillVisible = selectedThread && visibleThreads.some((t) => t.id === selectedThread.id);
    if (!stillVisible) {
      setSelectedThread(visibleThreads[0]);
    }
  }, [visibleThreads, statusFilter]);

  // Callback appelé par ThreadView quand le statut change (fermer / archiver / rouvrir)
  // → on met à jour le thread dans la liste locale immédiatement (pas besoin d'attendre un reload)
  function handleThreadStatusChange(threadId, newStatus) {
    setThreads((prev) => prev.map((t) => t.id === threadId ? { ...t, status: newStatus } : t));
  }

  useEffect(() => { loadClients(); }, [firm?.id]);

  if (firmLoading || loading) return <div style={loadingStyle}>Chargement...</div>;
  if (!firm) return <Navigate to="/firm" replace />;

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto", padding: "12px 16px" }}>
      <h1 style={{ fontFamily: "Syne, sans-serif", fontSize: 28, fontWeight: 700, margin: "0 0 16px 0", letterSpacing: "-0.02em" }}>
        MESSAGES
      </h1>

      <div style={{ display: "grid", gridTemplateColumns: "260px 280px 1fr", gap: 12, height: "calc(100vh - 180px)", minHeight: 500 }}>
        {/* Colonne 1 : Clients */}
        <div className="card" style={colStyle}>
          <div style={colHeaderStyle}>CLIENTS ({clients.length})</div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {clients.length === 0 ? (
              <div style={emptyStyle}>Aucun client lié</div>
            ) : (
              clients.map((c) => (
                <button
                  key={c.link.id}
                  onClick={() => {
                    setSelectedClient(c);
                    setSelectedThread(null);
                    setStatusFilter("open"); // reset filtre quand on change de client
                    loadThreads(c);
                  }}
                  style={{
                    ...rowStyle,
                    background: selectedClient?.link.id === c.link.id ? "rgba(212,168,67,0.12)" : "transparent",
                    borderLeft: selectedClient?.link.id === c.link.id ? "3px solid var(--gold)" : "3px solid transparent"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {c.company.legal_name}
                    </span>
                    {c.unreadCount > 0 && (
                      <span style={badgeStyle}>{c.unreadCount}</span>
                    )}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--muted)" }}>
                    {c.lastThreadAt ? fmtDate(c.lastThreadAt) : "—"}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Colonne 2 : Threads du client sélectionné — avec filtre par statut */}
        <div className="card" style={colStyle}>
          <div style={{ ...colHeaderStyle, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{selectedClient ? `SUJETS · ${visibleThreads.length}` : "SUJETS"}</span>
            {selectedClient && (
              <button className="btn btn-primary btn-sm" onClick={() => setShowNewThread(true)} style={{ padding: "2px 6px", fontSize: 10 }}>
                + Nouveau
              </button>
            )}
          </div>

          {/* Onglets de filtre par statut */}
          {selectedClient && (
            <div style={tabsRowStyle}>
              <FilterTab label="En cours" active={statusFilter === "open"} count={counts.open} onClick={() => setStatusFilter("open")} />
              <FilterTab label="Fermés" active={statusFilter === "closed"} count={counts.closed} onClick={() => setStatusFilter("closed")} />
              <FilterTab label="Archivés" active={statusFilter === "archived"} count={counts.archived} onClick={() => setStatusFilter("archived")} />
              <FilterTab label="Tous" active={statusFilter === "all"} count={threads.length} onClick={() => setStatusFilter("all")} />
            </div>
          )}

          <div style={{ flex: 1, overflowY: "auto" }}>
            {!selectedClient ? (
              <div style={emptyStyle}>Sélectionne un client</div>
            ) : visibleThreads.length === 0 ? (
              <div style={emptyStyle}>
                {threads.length === 0
                  ? "Aucun sujet avec ce client"
                  : `Aucun sujet ${statusFilter === "open" ? "en cours" : statusFilter === "closed" ? "fermé" : "archivé"}`}
              </div>
            ) : (
              visibleThreads.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setSelectedThread(t)}
                  style={{
                    ...rowStyle,
                    background: selectedThread?.id === t.id ? "rgba(212,168,67,0.12)" : "transparent",
                    borderLeft: selectedThread?.id === t.id ? "3px solid var(--gold)" : "3px solid transparent"
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t.subject}
                  </div>
                  <div style={{ fontSize: 10, color: "var(--muted)" }}>
                    {t.status === "open" ? "🟢" : t.status === "closed" ? "🔒" : "📦"} {fmtDate(t.last_message_at)}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Colonne 3 : Conversation */}
        <div className="card" style={{ ...colStyle, padding: 0 }}>
          {selectedThread ? (
            <ThreadView
              key={selectedThread.id}
              token={token}
              user={user}
              threadId={selectedThread.id}
              side="firm"
              onBack={null}
              onStatusChange={handleThreadStatusChange}
            />
          ) : (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 12 }}>
              {selectedClient ? "Sélectionne un sujet ou crée-en un nouveau" : "Sélectionne un client pour commencer"}
            </div>
          )}
        </div>
      </div>

      {showNewThread && selectedClient && (
        <NewThreadModal
          token={token}
          firm={firm}
          company={selectedClient.company}
          onCreated={async (newThread) => {
            setShowNewThread(false);
            await loadThreads(selectedClient);
            // Forcer le filtre sur "open" pour voir le nouveau thread
            setStatusFilter("open");
            if (newThread) setSelectedThread(newThread);
          }}
          onClose={() => setShowNewThread(false)}
        />
      )}
    </div>
  );
}

function FilterTab({ label, active, count, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: "6px 4px",
        border: "none",
        background: active ? "rgba(212,168,67,0.15)" : "transparent",
        color: active ? "var(--gold)" : "var(--muted)",
        fontSize: 10,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.3,
        cursor: "pointer",
        borderBottom: active ? "2px solid var(--gold)" : "2px solid transparent"
      }}
    >
      {label} {count > 0 && <span style={{ opacity: 0.7 }}>({count})</span>}
    </button>
  );
}

function NewThreadModal({ token, firm, company, onCreated, onClose }) {
  const [subject, setSubject] = useState("");
  const [firstMessage, setFirstMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState(null);

  async function submit() {
    setErr(null);
    if (!subject.trim() || !firstMessage.trim()) { setErr("Sujet et message requis"); return; }
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
    const data = await r.json();
    setSending(false);
    if (!r.ok) { setErr(data.error || "Échec"); return; }
    onCreated?.(data.thread);
  }

  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div className="card card-pad" style={modalBox} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 12px 0", fontSize: 15 }}>✏ Nouveau sujet avec {company.legal_name}</h3>

        <label style={labelStyle}>Sujet *</label>
        <input
          className="form-input"
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value.slice(0, 200))}
          placeholder="Ex : TVA Q1 2026"
          style={{ marginBottom: 10 }}
        />

        <label style={labelStyle}>Premier message *</label>
        <textarea
          className="form-input"
          rows={4}
          value={firstMessage}
          onChange={(e) => setFirstMessage(e.target.value.slice(0, 5000))}
          placeholder="Bonjour, j'aurais besoin de..."
          style={{ resize: "vertical", marginBottom: 10 }}
        />

        {err && <div className="alert-danger" style={{ marginBottom: 10, fontSize: 12 }}>{err}</div>}

        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Annuler</button>
          <button className="btn btn-primary btn-sm" onClick={submit} disabled={sending}>
            {sending ? "..." : "📤 Créer & envoyer"}
          </button>
        </div>
      </div>
    </div>
  );
}

const colStyle = { display: "flex", flexDirection: "column", overflow: "hidden", padding: 0, minHeight: 0 };
const colHeaderStyle = { padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,0.08)", fontSize: 10, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 1 };
const tabsRowStyle = { display: "flex", borderBottom: "1px solid rgba(255,255,255,0.08)" };
const rowStyle = { width: "100%", padding: "10px 12px", border: "none", borderBottom: "1px solid rgba(255,255,255,0.04)", cursor: "pointer", textAlign: "left", color: "var(--text)" };
const emptyStyle = { padding: 20, textAlign: "center", color: "var(--muted)", fontSize: 11 };
const badgeStyle = { background: "#e54949", color: "#fff", fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 8, minWidth: 16, textAlign: "center" };
const loadingStyle = { minHeight: 400, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 13 };
const labelStyle = { display: "block", fontSize: 10, fontWeight: 600, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 };
const modalBackdrop = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300, backdropFilter: "blur(4px)" };
const modalBox = { maxWidth: 540, width: "100%", margin: 20, maxHeight: "85vh", overflow: "auto" };
