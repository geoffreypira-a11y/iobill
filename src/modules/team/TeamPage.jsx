import React, { useEffect, useState } from "react";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtDate, isEmail } from "../../lib/helpers.js";

const ROLE_LABELS = {
  owner:      { label: "Propriétaire", desc: "Accès total, gestion abonnement", color: "var(--gold)" },
  admin:      { label: "Administrateur", desc: "Toutes les actions sauf abonnement", color: "var(--gold2)" },
  accountant: { label: "Comptable", desc: "Émission factures, exports, paiements", color: "var(--green)" },
  readonly:   { label: "Lecture seule", desc: "Consultation uniquement", color: "var(--muted)" }
};

/**
 * TeamPage — Gestion des utilisateurs d'une company
 * (le owner peut inviter d'autres users avec un role)
 */
export function TeamPage({ token, company, user }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("readonly");
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  // Charger les membres
  useEffect(() => {
    let alive = true;
    (async () => {
      const list = await sb.select(token, "company_users", {
        filter: `company_id=eq.${company.id}`,
        order: "created_at.asc"
      });
      if (!alive) return;
      setMembers(list || []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, company.id]);

  // Trouve le role de l'utilisateur courant pour cette company
  const myRole = members.find((m) => m.user_id === user.id)?.role || "owner";
  const canManage = ["owner", "admin"].includes(myRole);

  async function inviteUser() {
    setErr(""); setOk("");
    if (!isEmail(email)) { setErr("Email invalide"); return; }
    setInviting(true);
    try {
      // On insere une ligne avec invited_email + invited_at, sans user_id
      // (sera resolu quand le destinataire creera son compte avec cet email)
      const r = await fetch("/api/team-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email, role })
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "Erreur lors de l'invitation");
      }
      setOk(`Invitation envoyée à ${email}`);
      setEmail("");
      // Refresh
      const list = await sb.select(token, "company_users", {
        filter: `company_id=eq.${company.id}`,
        order: "created_at.asc"
      });
      setMembers(list || []);
    } catch (e) {
      setErr(e.message);
    }
    setInviting(false);
  }

  async function changeRole(memberId, newRole) {
    if (!canManage) return;
    if (!confirm(`Changer le rôle vers "${ROLE_LABELS[newRole].label}" ?`)) return;
    await sb.update(token, "company_users", `id=eq.${memberId}`, { role: newRole });
    setMembers((prev) => prev.map((m) => m.id === memberId ? { ...m, role: newRole } : m));
  }

  async function removeMember(memberId, mEmail) {
    if (!canManage) return;
    if (!confirm(`Retirer ${mEmail || "ce membre"} de l'équipe ? Cette action est immédiate.`)) return;
    await sb.delete(token, "company_users", `id=eq.${memberId}`);
    setMembers((prev) => prev.filter((m) => m.id !== memberId));
  }

  if (loading) {
    return <div className="page"><div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Chargement...</div></div>;
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">ÉQUIPE</div>
          <div className="page-sub">{members.length} membre{members.length > 1 ? "s" : ""}</div>
        </div>
      </div>

      {/* Invitation */}
      {canManage && (
        <div className="card card-pad" style={{ marginBottom: 18 }}>
          <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 12 }}>
            Inviter un nouvel utilisateur
          </div>
          {err && <div className="auth-error" style={{ marginBottom: 10 }}>{err}</div>}
          {ok && <div className="tipline" style={{ marginBottom: 10, color: "var(--green)" }}>{ok}</div>}
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr auto", gap: 10, alignItems: "end" }}>
            <div>
              <label className="form-label">Email</label>
              <input
                className="form-input"
                type="email"
                placeholder="prenom.nom@cabinet.fr"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label className="form-label">Rôle</label>
              <select className="form-input" value={role} onChange={(e) => setRole(e.target.value)}>
                {Object.entries(ROLE_LABELS).filter(([k]) => k !== "owner").map(([k, info]) => (
                  <option key={k} value={k}>{info.label}</option>
                ))}
              </select>
            </div>
            <button
              className="btn btn-primary"
              onClick={inviteUser}
              disabled={inviting || !email}
            >
              {inviting ? "..." : "Inviter"}
            </button>
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 8, lineHeight: 1.6 }}>
            <strong style={{ color: "var(--text)" }}>Rôles disponibles :</strong>{" "}
            {Object.entries(ROLE_LABELS).filter(([k]) => k !== "owner").map(([k, info], i, arr) => (
              <span key={k}>
                <span style={{ color: info.color }}>{info.label}</span> ({info.desc.toLowerCase()})
                {i < arr.length - 1 ? " · " : ""}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Liste membres */}
      <div className="card" style={{ overflow: "hidden" }}>
        <table>
          <thead>
            <tr>
              <th>Email / Utilisateur</th>
              <th>Rôle</th>
              <th>Invité le</th>
              <th>Acceptée</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const info = ROLE_LABELS[m.role] || ROLE_LABELS.readonly;
              const isMe = m.user_id === user.id;
              return (
                <tr key={m.id}>
                  <td>
                    {m.invited_email || (isMe ? user.email : "—")}
                    {isMe && <span className="badge badge-muted" style={{ marginLeft: 6, fontSize: 10 }}>Moi</span>}
                  </td>
                  <td>
                    {canManage && !isMe && m.role !== "owner" ? (
                      <select
                        className="form-input"
                        style={{ padding: "4px 8px", fontSize: 12, width: "auto" }}
                        value={m.role}
                        onChange={(e) => changeRole(m.id, e.target.value)}
                      >
                        {Object.entries(ROLE_LABELS).filter(([k]) => k !== "owner").map(([k, ri]) => (
                          <option key={k} value={k}>{ri.label}</option>
                        ))}
                      </select>
                    ) : (
                      <span style={{ color: info.color, fontSize: 12, fontWeight: 500 }}>{info.label}</span>
                    )}
                  </td>
                  <td>{fmtDate(m.invited_at || m.created_at)}</td>
                  <td>
                    {m.accepted_at ? (
                      <span className="badge badge-green">{fmtDate(m.accepted_at)}</span>
                    ) : (
                      <span className="badge badge-muted">En attente</span>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {canManage && !isMe && m.role !== "owner" && (
                      <button
                        className="btn btn-ghost btn-xs"
                        style={{ color: "var(--red)" }}
                        onClick={() => removeMember(m.id, m.invited_email)}
                      >
                        Retirer
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
