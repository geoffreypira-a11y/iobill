import React, { useEffect, useState } from "react";

/**
 * AdminPdpModal — Panneau « 🔌 PDP Access » de la zone admin.
 *
 * Modèle d'accès (Version 1 + dérogation) :
 *   • self_service_allowed = FALSE (défaut) → l'abonné est en lecture
 *     seule et ne peut que DEMANDER une modification.
 *   • self_service_allowed = TRUE  → l'abonné saisit ses propres codes.
 *
 * Les secrets ne redescendent JAMAIS du serveur : on affiche seulement
 * has_client_secret / has_webhook_secret. Un champ laissé vide = inchangé.
 */
export function AdminPdpModal({ company, adminCall, onClose }) {
  const [cfg, setCfg] = useState({
    provider: "superpdp",
    environment: "sandbox",
    base_url: "",
    client_id: "",
    client_secret: "",
    webhook_secret: "",
    enabled: false,
    self_service_allowed: false
  });
  const [meta, setMeta] = useState(null);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    let alive = true;
    adminCall("pa_admin_list")
      .then(({ companies, pending_requests }) => {
        if (!alive) return;
        const me = (companies || []).find(c => c.id === company.id);
        const pa = me && me.pa;
        setMeta(pa || { configured: false });
        if (pa && pa.configured) {
          setCfg(c => ({
            ...c,
            provider: pa.provider || "superpdp",
            environment: pa.environment || "sandbox",
            base_url: pa.base_url || "",
            client_id: pa.client_id || "",
            enabled: !!pa.enabled,
            self_service_allowed: !!pa.self_service_allowed
          }));
        }
        setRequests((pending_requests || []).filter(r => r.company_id === company.id));
      })
      .catch(e => setMsg({ t: "err", m: e.message }))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [company.id, adminCall]);

  const set = k => e =>
    setCfg(c => ({ ...c, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  async function save() {
    setBusy(true); setMsg(null);
    try {
      await adminCall("pa_admin_save", { company_id: company.id, ...cfg });
      setCfg(c => ({ ...c, client_secret: "", webhook_secret: "" }));
      setMsg({ t: "ok", m: "Configuration enregistrée" });
      const { companies } = await adminCall("pa_admin_list");
      const me = (companies || []).find(c => c.id === company.id);
      setMeta(me?.pa || null);
    } catch (e) { setMsg({ t: "err", m: e.message }); }
    finally { setBusy(false); }
  }

  async function test() {
    setBusy(true); setMsg(null);
    try {
      const r = await adminCall("pa_admin_test", { company_id: company.id });
      setMsg({ t: r.ok ? "ok" : "err", m: r.message });
    } catch (e) { setMsg({ t: "err", m: e.message }); }
    finally { setBusy(false); }
  }

  async function resolve(id, status) {
    const note = status === "done" ? null : window.prompt("Motif du refus (optionnel) :");
    setBusy(true);
    try {
      await adminCall("pa_admin_resolve_request", { request_id: id, status, admin_note: note });
      setRequests(rs => rs.filter(r => r.id !== id));
    } catch (e) { setMsg({ t: "err", m: e.message }); }
    finally { setBusy(false); }
  }

  const label = { display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 4 };
  const input = {
    width: "100%", padding: "8px 10px", borderRadius: 8,
    border: "1px solid var(--border, #232230)", background: "var(--bg, #0c0b0f)",
    color: "var(--text, #fff)", fontSize: 13, fontFamily: "monospace", boxSizing: "border-box"
  };
  const box = {
    border: "1px solid var(--border, #232230)", borderRadius: 10,
    padding: "14px 16px", marginBottom: 12
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,.72)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        zIndex: 9999, overflowY: "auto", padding: "40px 16px"
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "var(--card, #141319)", border: "1px solid var(--border, #232230)",
          borderRadius: 14, padding: 22, width: "100%", maxWidth: 620
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>🔌 PDP Access</div>
          <button className="btn btn-ghost" onClick={onClose} style={{ fontSize: 12 }}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 16 }}>
          {company.name} {company.siret ? "· SIRET " + company.siret : ""}
        </div>

        {msg && (
          <div style={{
            padding: "9px 12px", borderRadius: 8, marginBottom: 14, fontSize: 13,
            background: msg.t === "err" ? "rgba(229,73,73,.12)" : "rgba(62,207,122,.12)",
            color: msg.t === "err" ? "var(--red, #e54949)" : "var(--green, #3ecf7a)"
          }}>{msg.m}</div>
        )}

        {loading ? (
          <div style={{ color: "var(--muted)", padding: 20 }}>Chargement…</div>
        ) : (
          <>
            {requests.length > 0 && (
              <div style={{ ...box, borderColor: "var(--orange, #e5973c)" }}>
                <div style={{ fontWeight: 600, marginBottom: 8, color: "var(--orange, #e5973c)" }}>
                  🔔 Demande{requests.length > 1 ? "s" : ""} en attente
                </div>
                {requests.map(r => (
                  <div key={r.id} style={{ fontSize: 13, marginBottom: 10 }}>
                    <div style={{ marginBottom: 6, whiteSpace: "pre-wrap" }}>{r.message}</div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="btn btn-ghost" disabled={busy}
                        onClick={() => resolve(r.id, "done")}
                        style={{ fontSize: 12, color: "var(--green, #3ecf7a)" }}>✓ Traitée</button>
                      <button className="btn btn-ghost" disabled={busy}
                        onClick={() => resolve(r.id, "rejected")}
                        style={{ fontSize: 12, color: "var(--red, #e54949)" }}>✕ Rejeter</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={box}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
                <div>
                  <label style={label}>Fournisseur</label>
                  <select value={cfg.provider} onChange={set("provider")} style={input}>
                    <option value="superpdp">SUPER PDP</option>
                    <option value="mock">Mock (dev)</option>
                  </select>
                </div>
                <div>
                  <label style={label}>Environnement</label>
                  <select value={cfg.environment} onChange={set("environment")} style={input}>
                    <option value="sandbox">Bac à sable</option>
                    <option value="production">Production</option>
                  </select>
                </div>
              </div>
              <label style={label}>Base URL (vide = défaut du provider)</label>
              <input value={cfg.base_url} onChange={set("base_url")} style={input} placeholder="https://api.superpdp.tech" />
            </div>

            <div style={box}>
              <label style={label}>client_id</label>
              <input value={cfg.client_id} onChange={set("client_id")} style={{ ...input, marginBottom: 10 }} />

              <label style={label}>
                client_secret {meta?.has_client_secret ? "— enregistré, vide = inchangé" : ""}
              </label>
              <input type="password" value={cfg.client_secret} onChange={set("client_secret")}
                style={{ ...input, marginBottom: 10 }}
                placeholder={meta?.has_client_secret ? "••••••••" : ""} />

              <label style={label}>
                webhook_secret (HMAC) {meta?.has_webhook_secret ? "— enregistré" : ""}
              </label>
              <input type="password" value={cfg.webhook_secret} onChange={set("webhook_secret")}
                style={input}
                placeholder={meta?.has_webhook_secret ? "••••••••" : ""} />
            </div>

            <div style={box}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 10 }}>
                <input type="checkbox" checked={cfg.enabled} onChange={set("enabled")} />
                Activer l'émission et la réception
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13 }}>
                <input type="checkbox" checked={cfg.self_service_allowed}
                  onChange={set("self_service_allowed")} style={{ marginTop: 3 }} />
                <span>
                  Autoriser l'abonné à saisir ses propres codes
                  <br />
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>
                    Décoché = lecture seule côté abonné, il ne peut que demander une modification.
                  </span>
                </span>
              </label>
            </div>

            {meta?.configured && (
              <div style={{ ...box, fontSize: 12, color: "var(--muted)" }}>
                <div>Webhook à déclarer chez la PA :</div>
                <code style={{ display: "block", marginTop: 6, wordBreak: "break-all", color: "var(--gold, #d4a843)" }}>
                  {meta.webhook_url}
                </code>
                {meta.last_auth_ok_at && (
                  <div style={{ marginTop: 8, color: "var(--green, #3ecf7a)" }}>
                    ✓ Dernière auth OK : {new Date(meta.last_auth_ok_at).toLocaleString("fr-FR")}
                  </div>
                )}
                {meta.last_error && (
                  <div style={{ marginTop: 8, color: "var(--red, #e54949)" }}>
                    ⚠️ {meta.last_error}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button className="btn" onClick={save} disabled={busy}>💾 Enregistrer</button>
              <button className="btn btn-ghost" onClick={test} disabled={busy}>🔍 Tester la connexion</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default AdminPdpModal;
