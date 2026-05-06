import React, { useEffect, useState } from "react";
import { Icon } from "../../components/Icon.jsx";
import { fmtDate } from "../../lib/helpers.js";
import { SkeletonTable } from "../../components/Skeleton.jsx";

const CURL_EXAMPLE = `curl -X POST https://iobill.fr/api/v1/invoices \\
  -H "Authorization: Bearer iobill_live_xxxxxxxx_yyyy..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "client_id": "uuid-du-client",
    "lines": [
      { "description": "Prestation conseil", "quantity": 1, "unit_price_ht": 800, "vat_rate": 20 }
    ]
  }'`;

export function ApiKeysPage({ token, company }) {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newScopes, setNewScopes] = useState(["read", "write"]);
  const [newRateLimit, setNewRateLimit] = useState(60);
  const [createdKey, setCreatedKey] = useState(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const r = await fetch("/api/api-keys", {
        headers: { Authorization: `Bearer ${token}` }
      });
      const j = await r.json();
      setKeys(j.keys || []);
    } catch {
      setErr("Erreur de chargement des clés");
    }
    setLoading(false);
  }

  async function createKey() {
    setErr("");
    if (!newName.trim()) { setErr("Donnez un nom à votre clé"); return; }
    setCreating(true);
    try {
      const r = await fetch("/api/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: newName, scopes: newScopes, rate_limit: newRateLimit })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Erreur");
      setCreatedKey(j.key);
      setNewName("");
      await refresh();
    } catch (e) {
      setErr(e.message);
    }
    setCreating(false);
  }

  async function revokeKey(id, name) {
    if (!confirm(`Révoquer la clé "${name}" ? Cette action est irréversible.`)) return;
    try {
      const r = await fetch(`/api/api-keys?id=${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!r.ok) throw new Error();
      await refresh();
    } catch {
      alert("Erreur lors de la révocation");
    }
  }

  function copyKey() {
    if (!createdKey) return;
    navigator.clipboard.writeText(createdKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  function toggleScope(scope) {
    setNewScopes((s) =>
      s.includes(scope) ? s.filter((x) => x !== scope) : [...s, scope]
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">API DÉVELOPPEUR</div>
          <div className="page-sub">Clés d'accès à l'API publique IO BILL v1</div>
        </div>
        <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer" className="btn btn-ghost">
          📖 OpenAPI Spec
        </a>
      </div>

      {/* Modal de creation : on affiche la cle UNE SEULE FOIS */}
      {createdKey && (
        <div className="card card-pad" style={{
          marginBottom: 18, borderLeft: "3px solid var(--green)",
          background: "rgba(62, 207, 122, 0.05)"
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
            ✓ Clé créée — copiez-la maintenant
          </div>
          <div style={{ fontSize: 11, color: "var(--muted2)", marginBottom: 10 }}>
            Cette clé ne sera plus jamais affichée. Stockez-la en lieu sûr (gestionnaire de mots de passe, vault Vercel, etc.).
          </div>
          <div style={{
            background: "var(--bg)", padding: 12, borderRadius: 7,
            display: "flex", alignItems: "center", gap: 8
          }}>
            <code className="mono" style={{ flex: 1, fontSize: 11, color: "var(--gold)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {createdKey}
            </code>
            <button className="btn btn-primary btn-sm" onClick={copyKey}>
              {copied ? "✓ Copié" : "📋 Copier"}
            </button>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setCreatedKey(null)}
            style={{ marginTop: 12 }}
          >
            J'ai stocké la clé
          </button>
        </div>
      )}

      {/* Formulaire de création */}
      {!createdKey && (
        <div className="card card-pad" style={{ marginBottom: 18 }}>
          <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 14 }}>
            ➕ Nouvelle clé API
          </div>
          {err && <div className="auth-error" style={{ marginBottom: 10 }}>{err}</div>}

          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, marginBottom: 12 }}>
            <div className="form-row" style={{ marginBottom: 0 }}>
              <label className="form-label">Nom (description)</label>
              <input
                className="form-input"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="ex: Intégration Make / Zapier"
                maxLength={80}
              />
            </div>
            <div className="form-row" style={{ marginBottom: 0 }}>
              <label className="form-label">Limite (req/min)</label>
              <input
                type="number" min={10} max={1000} step={10}
                className="form-input mono"
                value={newRateLimit}
                onChange={(e) => setNewRateLimit(Number(e.target.value))}
              />
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label className="form-label">Permissions (scopes)</label>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {["read", "write", "admin"].map((s) => {
                const active = newScopes.includes(s);
                return (
                  <button
                    key={s}
                    onClick={() => toggleScope(s)}
                    style={{
                      background: active ? "var(--gold)" : "var(--card2)",
                      color: active ? "#0b0c10" : "var(--text)",
                      border: "1px solid " + (active ? "var(--gold)" : "var(--border2)"),
                      padding: "6px 14px", borderRadius: 6,
                      fontSize: 11, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase",
                      cursor: "pointer"
                    }}
                  >
                    {active ? "✓ " : ""}{s}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 6 }}>
              <strong>read</strong> : lecture · <strong>write</strong> : création/modification · <strong>admin</strong> : tout (incl. suppression)
            </div>
          </div>

          <button className="btn btn-primary" onClick={createKey} disabled={creating}>
            {creating ? "Création..." : "Générer une clé"}
          </button>
        </div>
      )}

      {/* Liste des clés */}
      <div style={{ marginBottom: 14, fontSize: 12, color: "var(--muted)", letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 600 }}>
        Clés actives ({keys.filter((k) => !k.revoked_at).length})
      </div>

      {loading ? (
        <SkeletonTable rows={3} cols={5} />
      ) : keys.length === 0 ? (
        <div className="card card-pad" style={{ textAlign: "center", padding: 50, color: "var(--muted)" }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>🔑</div>
          Aucune clé API. Créez-en une ci-dessus pour commencer.
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th>Nom</th>
                <th>Préfixe</th>
                <th>Permissions</th>
                <th>Limite</th>
                <th>Dernier usage</th>
                <th>Statut</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} style={{ opacity: k.revoked_at ? 0.5 : 1 }}>
                  <td>{k.name}</td>
                  <td className="mono" style={{ fontSize: 11, color: "var(--muted2)" }}>{k.key_prefix}***</td>
                  <td>
                    {(k.scopes || []).map((s) => (
                      <span key={s} className="badge badge-gold" style={{ marginRight: 4, fontSize: 9 }}>
                        {s}
                      </span>
                    ))}
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>{k.rate_limit_per_minute}/min</td>
                  <td style={{ fontSize: 11 }}>
                    {k.last_used_at ? fmtDate(k.last_used_at) : <span style={{ color: "var(--muted)" }}>Jamais</span>}
                  </td>
                  <td>
                    {k.revoked_at ? (
                      <span className="badge badge-red">Révoquée</span>
                    ) : (
                      <span className="badge badge-green">Active</span>
                    )}
                  </td>
                  <td>
                    {!k.revoked_at && (
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => revokeKey(k.id, k.name)}
                        style={{ color: "var(--red)" }}
                      >
                        Révoquer
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Documentation rapide */}
      <div className="card card-pad" style={{ marginTop: 24 }}>
        <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 14 }}>
          📚 Quick start
        </div>
        <div style={{ fontSize: 12, color: "var(--muted2)", lineHeight: 1.7, marginBottom: 14 }}>
          Endpoints disponibles en v1 :
        </div>
        <ul style={{ fontSize: 12, lineHeight: 2, paddingLeft: 18, color: "var(--muted2)" }}>
          <li><code className="mono">GET  /api/v1/clients</code> — liste des clients</li>
          <li><code className="mono">POST /api/v1/clients</code> — créer un client</li>
          <li><code className="mono">GET  /api/v1/invoices</code> — liste des factures</li>
          <li><code className="mono">POST /api/v1/invoices</code> — créer une facture (brouillon)</li>
          <li><code className="mono">POST /api/v1/invoices?issue=1</code> — créer + émettre directement</li>
        </ul>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 14, marginBottom: 8 }}>
          Exemple d'appel curl :
        </div>
        <pre style={{
          background: "var(--bg)", padding: 14, borderRadius: 7,
          fontSize: 11, fontFamily: "DM Mono, monospace", color: "var(--muted2)",
          overflow: "auto", lineHeight: 1.5, margin: 0,
          whiteSpace: "pre-wrap"
        }}>{CURL_EXAMPLE}</pre>
      </div>
    </div>
  );
}
