import React, { useEffect, useState } from "react";
import { fmtDate } from "../../lib/helpers.js";

/**
 * AdminFirmsTab — Onglet "Cabinets" dans AdminPage.
 *
 * Liste tous les cabinets comptables avec : nom, SIRET, email,
 * nb membres, nb clients, date création, statut.
 *
 * Actions : suspendre, archiver (avec raison), supprimer (avec confirmation).
 */
export function AdminFirmsTab({ token }) {
  const [firms, setFirms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [expandedFirm, setExpandedFirm] = useState(null);
  const [firmData, setFirmData] = useState(null);
  const [showArchiveModal, setShowArchiveModal] = useState(null);
  const [showDeleteModal, setShowDeleteModal] = useState(null);

  async function api(action, payload) {
    const r = await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, payload: payload || {} })
    });
    return r.json();
  }

  async function loadFirms() {
    setLoading(true);
    const r = await api("firms_list");
    setFirms(r?.firms || []);
    setLoading(false);
  }

  useEffect(() => { loadFirms(); }, []);

  async function loadFirmData(firmId) {
    if (expandedFirm === firmId) {
      setExpandedFirm(null);
      setFirmData(null);
      return;
    }
    setExpandedFirm(firmId);
    setFirmData(null);
    const r = await api("firm_data", { firmId });
    setFirmData(r?.data || null);
  }

  async function toggleSuspend(firm) {
    const action = firm.status === "suspended" ? "réactiver" : "suspendre";
    if (!confirm(`Confirmer ${action} ce cabinet ?`)) return;
    const suspend = firm.status !== "suspended";
    const r = await api("firm_toggle_suspend", { firmId: firm.id, suspend });
    if (r?.error) { alert(r.error); return; }
    loadFirms();
  }

  async function archiveFirm(firmId, reason) {
    const r = await api("firm_archive", { firmId, reason });
    if (r?.error) { alert(r.error); return; }
    setShowArchiveModal(null);
    loadFirms();
  }

  async function unarchiveFirm(firmId) {
    if (!confirm("Réactiver ce cabinet (le sortir des archives) ?")) return;
    const r = await api("firm_unarchive", { firmId });
    if (r?.error) { alert(r.error); return; }
    loadFirms();
  }

  async function deleteFirm(firmId) {
    const r = await api("firm_delete", { firmId });
    if (r?.error) { alert(r.error); return; }
    setShowDeleteModal(null);
    loadFirms();
  }

  const filtered = firms.filter((f) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      (f.name || "").toLowerCase().includes(q) ||
      (f.legal_name || "").toLowerCase().includes(q) ||
      (f.email || "").toLowerCase().includes(q) ||
      (f.siret || "").includes(q)
    );
  });

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <input
          type="text"
          className="form-input"
          placeholder="🔍 Rechercher (nom, email, SIRET)..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 400 }}
        />
      </div>

      {loading ? (
        <div className="card card-pad" style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>
          Chargement...
        </div>
      ) : filtered.length === 0 ? (
        <div className="card card-pad" style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>
          Aucun cabinet.
        </div>
      ) : (
        filtered.map((f) => (
          <FirmCard
            key={f.id}
            firm={f}
            expanded={expandedFirm === f.id}
            data={expandedFirm === f.id ? firmData : null}
            onToggle={() => loadFirmData(f.id)}
            onToggleSuspend={() => toggleSuspend(f)}
            onArchive={() => setShowArchiveModal(f.id)}
            onUnarchive={() => unarchiveFirm(f.id)}
            onDelete={() => setShowDeleteModal(f)}
          />
        ))
      )}

      {showArchiveModal && (
        <ArchiveFirmModal
          firmId={showArchiveModal}
          onClose={() => setShowArchiveModal(null)}
          onConfirm={(reason) => archiveFirm(showArchiveModal, reason)}
        />
      )}

      {showDeleteModal && (
        <DeleteFirmModal
          firm={showDeleteModal}
          onClose={() => setShowDeleteModal(null)}
          onConfirm={() => deleteFirm(showDeleteModal.id)}
        />
      )}
    </>
  );
}

function FirmCard({ firm, expanded, data, onToggle, onToggleSuspend, onArchive, onUnarchive, onDelete }) {
  const isArchived = firm.status === "archived";
  const isSuspended = firm.status === "suspended";

  const statusBadge = isArchived ? { label: "Archivé", cls: "badge-muted" }
    : isSuspended ? { label: "Suspendu", cls: "badge-red" }
    : { label: "Actif", cls: "badge-green" };

  return (
    <div className="card" style={{ marginBottom: 10, padding: 14 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{firm.name || "—"}</span>
            <span className={`badge ${statusBadge.cls}`}>{statusBadge.label}</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>
            {firm.siret ? `SIRET ${firm.siret} · ` : ""}
            {firm.email || "—"}
            {firm.legal_name && firm.legal_name !== firm.name ? ` · ${firm.legal_name}` : ""}
          </div>
        </div>

        <div style={{ display: "flex", gap: 16, fontSize: 11, color: "var(--muted2)" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--gold)" }}>{firm.member_count}</div>
            <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 1 }}>Membres</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--gold)" }}>{firm.client_count}</div>
            <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 1 }}>Clients</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 11, color: "var(--muted2)" }}>{fmtDate(firm.created_at)}</div>
            <div style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: 1 }}>Créé</div>
          </div>
        </div>

        <button className="btn btn-ghost btn-sm" onClick={onToggle}>
          {expanded ? "▲ Replier" : "▼ Détails"}
        </button>
      </div>

      {/* Détails étendus */}
      {expanded && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border2)" }}>
          {!data ? (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>Chargement...</div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
                <div>
                  <div className="kpi-label" style={{ marginBottom: 6 }}>Membres ({data.members.length})</div>
                  {data.members.length === 0 ? (
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>Aucun membre</div>
                  ) : (
                    data.members.map((m) => (
                      <div key={m.user_id} style={{ fontSize: 11, color: "var(--muted2)", padding: "2px 0" }}>
                        • {m.role} <span style={{ color: "var(--muted)" }}>({m.user_id.slice(0, 8)}...)</span>
                      </div>
                    ))
                  )}
                </div>

                <div>
                  <div className="kpi-label" style={{ marginBottom: 6 }}>Liens clients ({data.client_links.length})</div>
                  {data.client_links.length === 0 ? (
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>Aucun client lié</div>
                  ) : (
                    data.client_links.slice(0, 5).map((l) => (
                      <div key={l.id} style={{ fontSize: 11, color: "var(--muted2)", padding: "2px 0" }}>
                        • {l.company_id.slice(0, 8)}... {l.accepted_at ? "✅" : "⏳"} {l.revoked_at ? "🚫" : ""}
                      </div>
                    ))
                  )}
                </div>
              </div>

              {data.signals.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div className="kpi-label" style={{ marginBottom: 6 }}>Signaux récents ({data.signals.length})</div>
                  {data.signals.slice(0, 3).map((s) => (
                    <div key={s.id} style={{ fontSize: 11, color: "var(--muted2)", padding: "2px 0" }}>
                      • [{s.severity}] {s.title} <span style={{ color: "var(--muted)" }}>· {fmtDate(s.created_at)}</span>
                    </div>
                  ))}
                </div>
              )}

              {firm.notes_admin && (
                <div style={{ marginBottom: 14, padding: 10, background: "rgba(255,255,255,0.02)", borderRadius: 6 }}>
                  <div className="kpi-label" style={{ marginBottom: 4 }}>Notes admin</div>
                  <div style={{ fontSize: 12, color: "var(--muted2)" }}>{firm.notes_admin}</div>
                </div>
              )}
            </>
          )}

          {/* Actions */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            {!isArchived && (
              <button className="btn btn-ghost btn-sm" onClick={onToggleSuspend}>
                {isSuspended ? "▶ Réactiver" : "⏸ Suspendre"}
              </button>
            )}
            {!isArchived ? (
              <button className="btn btn-ghost btn-sm" onClick={onArchive}>
                📦 Archiver
              </button>
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={onUnarchive}>
                📤 Désarchiver
              </button>
            )}
            <button className="btn btn-danger btn-sm" onClick={onDelete}>
              🗑 Supprimer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ArchiveFirmModal({ firmId, onClose, onConfirm }) {
  const [reason, setReason] = useState("");
  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div className="card card-pad" style={modalBox} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 12px 0", fontSize: 16 }}>Archiver le cabinet</h3>
        <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14 }}>
          L'archivage masque le cabinet de l'interface utilisateur, mais ne supprime aucune donnée.
          Tu pourras le désarchiver à tout moment.
        </p>
        <label className="form-label">Raison de l'archivage *</label>
        <textarea
          className="form-input"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Ex : Cabinet inactif depuis 6 mois"
          style={{ resize: "vertical", minHeight: 60 }}
        />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Annuler</button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => onConfirm(reason)}
            disabled={!reason.trim()}
          >
            Archiver
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteFirmModal({ firm, onClose, onConfirm }) {
  const [confirmation, setConfirmation] = useState("");
  const expected = firm.name || "";
  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div className="card card-pad" style={modalBox} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 12px 0", fontSize: 16, color: "var(--red)" }}>
          ⚠ Suppression définitive
        </h3>
        <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14, lineHeight: 1.6 }}>
          Cette action supprime <strong>définitivement</strong> le cabinet, tous ses membres,
          tous les liens clients, signaux et messages. <strong>Irréversible.</strong>
        </p>
        <p style={{ fontSize: 12, marginBottom: 8 }}>
          Tape <strong>{expected}</strong> pour confirmer :
        </p>
        <input
          type="text"
          className="form-input"
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
          placeholder={expected}
        />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Annuler</button>
          <button
            className="btn btn-danger btn-sm"
            onClick={onConfirm}
            disabled={confirmation !== expected}
          >
            🗑 Supprimer définitivement
          </button>
        </div>
      </div>
    </div>
  );
}

const modalBackdrop = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 300,
  backdropFilter: "blur(4px)"
};

const modalBox = {
  maxWidth: 500,
  width: "100%",
  margin: 20
};
