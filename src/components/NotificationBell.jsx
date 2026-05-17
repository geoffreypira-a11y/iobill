import React, { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { sb } from "../lib/supabase.js";
import { subscribe } from "../lib/realtime.js";
import { fmtDate } from "../lib/helpers.js";

/**
 * NotificationBell — cloche de notifications.
 *
 * Lit la table public.notifications (alimentee par triggers SQL et l'API).
 * Le dropdown est rendu en position:fixed avec calcul de coordonnees pour
 * passer par-dessus n'importe quel parent ayant overflow:hidden.
 */
export function NotificationBell({ token, company, user }) {
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  // Position fixed du dropdown (calculee au clic)
  const [pos, setPos] = useState(null);
  const buttonRef = useRef(null);

  // ── Chargement initial + Realtime WebSocket ──
  // 1) On charge la liste une fois au montage (fetch HTTP)
  // 2) On s'abonne via WebSocket aux changements sur la table notifications
  //    → toute INSERT/UPDATE arrive en <1s, sans polling
  // 3) Backup : refresh quand l'onglet redevient visible
  useEffect(() => {
    let alive = true;

    async function loadInitial() {
      try {
        const rows = await sb.select(token, "notifications", {
          filter: `company_id=eq.${company.id}`,
          select: "id,notif_type,title,body,url,severity,icon,metadata,read_at,created_at",
          order: "created_at.desc",
          limit: 20
        });
        if (!alive) return;
        const list = rows || [];
        setItems(list);
        setUnreadCount(list.filter((n) => !n.read_at).length);
      } catch {
        // silent
      }
    }

    loadInitial();

    // ── Abonnement WebSocket : INSERT et UPDATE en temps reel ──
    const unsubscribe = subscribe(
      token,
      "notifications",
      `company_id=eq.${company.id}`,
      (payload) => {
        if (!alive) return;
        const row = payload?.record || payload?.new || payload?.data;
        const eventType = payload?.type || payload?.eventType || (payload?.record ? "INSERT" : null);
        if (!row) {
          // Cas ou Supabase envoie un format different : on refresh complet
          loadInitial();
          return;
        }
        if (eventType === "INSERT") {
          setItems((prev) => {
            // Eviter doublons si already there
            if (prev.some((n) => n.id === row.id)) return prev;
            return [row, ...prev].slice(0, 20);
          });
          if (!row.read_at) setUnreadCount((c) => c + 1);
        } else if (eventType === "UPDATE") {
          setItems((prev) => prev.map((n) => n.id === row.id ? row : n));
          // Recalcul du compteur unread
          setItems((curr) => {
            setUnreadCount(curr.filter((n) => !n.read_at).length);
            return curr;
          });
        } else if (eventType === "DELETE") {
          setItems((prev) => prev.filter((n) => n.id !== (row.id || payload?.old?.id)));
        } else {
          // Type inconnu : refresh complet
          loadInitial();
        }
      }
    );

    // Refresh aussi quand l'onglet redevient visible (au cas ou WS down)
    function onVisibility() {
      if (document.visibilityState === "visible") loadInitial();
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      alive = false;
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [token, company.id]);

  // ── Fermeture sur clic exterieur / scroll / resize ──
  useEffect(() => {
    if (!open) return;
    function close() { setOpen(false); }
    const t = setTimeout(() => {
      document.addEventListener("mousedown", close);
      window.addEventListener("scroll", close, true);
      window.addEventListener("resize", close);
    }, 50);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function toggleOpen(e) {
    e.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const dropdownW = 360;
    let left = rect.left;
    // Si on est dans la sidebar (gauche), on aligne le bord gauche du dropdown
    // sur le bord droit du bouton + un peu d'espace pour ne pas chevaucher
    if (rect.left < 200) {
      left = rect.right + 12;
    }
    // Clip pour pas deborder a droite
    if (left + dropdownW > window.innerWidth - 12) {
      left = window.innerWidth - dropdownW - 12;
    }
    setPos({
      top: rect.top + window.scrollY,
      left
    });
    setOpen(true);
  }

  async function markAllRead() {
    if (unreadCount === 0) return;
    try {
      await sb.rpc(token, "mark_all_notifications_read");
      setItems((prev) => prev.map((n) => n.read_at ? n : { ...n, read_at: new Date().toISOString() }));
      setUnreadCount(0);
    } catch {
      // silent
    }
  }

  async function markOneRead(id) {
    try {
      await sb.update(token, "notifications", `id=eq.${id}`, {
        read_at: new Date().toISOString()
      });
      setItems((prev) => prev.map((n) => n.id === id ? { ...n, read_at: new Date().toISOString() } : n));
      setUnreadCount((c) => Math.max(0, c - 1));
    } catch {
      // silent
    }
  }

  const severityColor = {
    info: "var(--gold)",
    success: "var(--green)",
    warning: "var(--orange)",
    critical: "var(--red)"
  };

  return (
    <>
      <button
        ref={buttonRef}
        onClick={toggleOpen}
        title="Notifications"
        style={{
          position: "relative", background: "transparent", border: "1px solid var(--border2)",
          borderRadius: "50%", width: 36, height: 36, cursor: "pointer", color: "var(--text)",
          display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16,
          transition: "background 0.15s"
        }}
        onMouseEnter={(e) => e.currentTarget.style.background = "var(--card2)"}
        onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
      >
        🔔
        {unreadCount > 0 && (
          <span style={{
            position: "absolute", top: -2, right: -2,
            background: "var(--red)", color: "#fff",
            fontSize: 9, fontWeight: 700,
            minWidth: 16, height: 16, borderRadius: 8,
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: "0 4px",
            border: "2px solid var(--bg)"
          }}>
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && pos && (
        <div
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            top: pos.top,
            left: pos.left,
            background: "var(--card)", border: "1px solid var(--border2)", borderRadius: 10,
            zIndex: 9999, width: 360, maxHeight: 480, overflow: "hidden",
            boxShadow: "0 12px 32px rgba(0,0,0,0.6)",
            display: "flex", flexDirection: "column"
          }}
        >
          <div style={{
            padding: "10px 14px", borderBottom: "1px solid var(--border)",
            display: "flex", justifyContent: "space-between", alignItems: "center",
            flexShrink: 0
          }}>
            <div style={{
              fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase",
              color: "var(--muted)", fontWeight: 600
            }}>
              Notifications {unreadCount > 0 && <span style={{ color: "var(--gold)" }}>· {unreadCount} non lues</span>}
            </div>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                style={{
                  background: "transparent", border: "none", color: "var(--gold)",
                  fontSize: 10, cursor: "pointer", padding: "2px 6px",
                  fontFamily: "inherit", textDecoration: "underline"
                }}
              >
                Tout marquer lu
              </button>
            )}
          </div>
          <div style={{ flex: 1, overflow: "auto" }}>
            {items.length === 0 ? (
              <div style={{ padding: 36, textAlign: "center", color: "var(--muted)" }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>✨</div>
                <div style={{ fontSize: 12 }}>Tout est à jour</div>
              </div>
            ) : (
              items.map((it) => {
                const isUnread = !it.read_at;
                const color = severityColor[it.severity] || "var(--text)";
                const Inner = (
                  <div style={{
                    padding: "12px 14px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex", gap: 10, alignItems: "flex-start",
                    cursor: it.url ? "pointer" : "default",
                    transition: "background 0.15s",
                    background: isUnread ? "rgba(212,168,67,0.05)" : "transparent",
                    position: "relative"
                  }}
                    onMouseEnter={(e) => e.currentTarget.style.background = "var(--card2)"}
                    onMouseLeave={(e) => e.currentTarget.style.background = isUnread ? "rgba(212,168,67,0.05)" : "transparent"}
                  >
                    {isUnread && (
                      <div style={{
                        position: "absolute", left: 4, top: "50%", transform: "translateY(-50%)",
                        width: 6, height: 6, borderRadius: "50%", background: "var(--gold)"
                      }} />
                    )}
                    <div style={{ fontSize: 18, flexShrink: 0, marginTop: -2, marginLeft: 4 }}>
                      {it.icon || "🔔"}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: 12, fontWeight: 600, color,
                        marginBottom: 2
                      }}>
                        {it.title}
                      </div>
                      {it.body && (
                        <div style={{
                          fontSize: 11, color: "var(--muted2)", lineHeight: 1.5,
                          overflow: "hidden", textOverflow: "ellipsis"
                        }}>
                          {it.body}
                        </div>
                      )}
                      <div style={{ fontSize: 9, color: "var(--muted)", marginTop: 4 }}>
                        {fmtRelative(it.created_at)}
                      </div>
                    </div>
                  </div>
                );
                return it.url ? (
                  <Link
                    key={it.id}
                    to={it.url}
                    onClick={() => { markOneRead(it.id); setOpen(false); }}
                    style={{ textDecoration: "none", color: "inherit", display: "block" }}
                  >
                    {Inner}
                  </Link>
                ) : (
                  <div key={it.id} onClick={() => isUnread && markOneRead(it.id)}>{Inner}</div>
                );
              })
            )}
          </div>
          <div style={{
            padding: "8px 14px", borderTop: "1px solid var(--border)",
            textAlign: "center", flexShrink: 0
          }}>
            <Link
              to="/settings"
              onClick={() => setOpen(false)}
              style={{
                fontSize: 10, color: "var(--muted)", textDecoration: "none",
                letterSpacing: 1, textTransform: "uppercase"
              }}
            >
              ⚙ Préférences notifications
            </Link>
          </div>
        </div>
      )}
    </>
  );
}

function fmtRelative(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "à l'instant";
  if (sec < 3600) return `il y a ${Math.floor(sec / 60)} min`;
  if (sec < 86400) return `il y a ${Math.floor(sec / 3600)} h`;
  return fmtDate(iso);
}
