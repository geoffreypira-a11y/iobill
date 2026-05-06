import React, { useEffect, useState, useRef } from "react";
import { sb } from "../lib/supabase.js";
import { initials } from "../lib/helpers.js";

function displayName(c) {
  if (c.client_type === "individual") {
    return [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "Client";
  }
  return c.legal_name || "Client";
}

export function ClientPicker({ token, company, value, onChange, label = "Client" }) {
  const [open, setOpen] = useState(false);
  const [clients, setClients] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const list = await sb.select(token, "clients", {
        filter: `company_id=eq.${company.id}`,
        order: "updated_at.desc",
        limit: 200
      });
      if (!alive) return;
      setClients(list || []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, company.id]);

  // Fermeture au clic extérieur
  useEffect(() => {
    function onClick(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const selected = clients.find((c) => c.id === value);

  const filtered = clients.filter((c) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      (c.legal_name || "").toLowerCase().includes(s) ||
      (c.first_name || "").toLowerCase().includes(s) ||
      (c.last_name || "").toLowerCase().includes(s) ||
      (c.email || "").toLowerCase().includes(s)
    );
  });

  return (
    <div className="form-row" style={{ position: "relative" }} ref={wrapRef}>
      {label && <label className="form-label">{label}</label>}
      <button
        type="button"
        className="form-input"
        onClick={() => setOpen((o) => !o)}
        style={{
          textAlign: "left",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: "var(--card2)"
        }}
      >
        {selected ? (
          <>
            <div className="avatar" style={{ width: 24, height: 24, fontSize: 9 }}>
              {initials(displayName(selected))}
            </div>
            <span style={{ flex: 1, color: "var(--text)" }}>{displayName(selected)}</span>
          </>
        ) : (
          <span style={{ color: "var(--muted)" }}>— Sélectionner un client —</span>
        )}
        <span style={{ color: "var(--muted)", fontSize: 10 }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            marginTop: 4,
            maxHeight: 280,
            overflowY: "auto",
            zIndex: 20,
            boxShadow: "0 6px 20px rgba(0,0,0,0.4)"
          }}
        >
          <div style={{ padding: 8, borderBottom: "1px solid var(--border2)" }}>
            <input
              className="form-input"
              placeholder="Rechercher..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
              style={{ fontSize: 12 }}
            />
          </div>
          {loading ? (
            <div style={{ padding: 16, color: "var(--muted)", fontSize: 12 }}>Chargement...</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 16, color: "var(--muted)", fontSize: 12 }}>Aucun client trouvé.</div>
          ) : (
            filtered.map((c) => (
              <div
                key={c.id}
                onClick={() => { onChange(c.id, c); setOpen(false); setSearch(""); }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 12px",
                  cursor: "pointer",
                  fontSize: 13,
                  borderBottom: "1px solid var(--border2)"
                }}
                onMouseOver={(e) => e.currentTarget.style.background = "var(--card2)"}
                onMouseOut={(e) => e.currentTarget.style.background = ""}
              >
                <div className="avatar" style={{ width: 26, height: 26, fontSize: 9 }}>
                  {initials(displayName(c))}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: "var(--text)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {displayName(c)}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>{c.email || c.phone || "—"}</div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
