import React, { useEffect, useState } from "react";
import { sb } from "../../lib/supabase.js";
import { fmtDate } from "../../lib/helpers.js";

/**
 * MyFirmSettingsPage — v8.26.4
 * Filtre par invited_email OU company_id (plus robuste)
 */
export function MyFirmSettingsPage({ token, user, company }) {
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);

  async function load() {
    if (!token || !user?.email) { setLoading(false); return; }
    setLoading(true);

    // 1) Par email
    const byEmail = await sb.select(token, "firm_client_links", {
      filter: `invited_email=eq.${encodeURIComponent(user.email)}`,
      select: "*",
      order: "created_at.desc",
      limit: 50
    }) || [];

    // 2) Par company
    let byCompany = [];
    if (company?.id) {
      byCompany = await sb.select(token, "firm_client_links", {
        filter: `company_id=eq.${company.id}`,
        select: "*",
        order: "created_at.desc",
        limit: 50
      }) || [];
    }

    const map = new Map();
    for (const l of [...byEmail, ...byCompany]) map.set(l.id, l);
    const merged = Array.from(map.values()).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Hydrater
    const out = [];
    for (const l of merged) {
      const firm = await sb.selectOne(token, "accounting_firms", `id=eq.${l.firm_id}`, "id,name,email,siret");
      out.push({ ...l, _firm: firm });
    }
    setLinks(out);
    setLoading(false);
  }

  useEffect(() => { load(); }, [token, user?.email, company?.id]);

  async function action(linkId, act) {
    const labels = { accept: "Accepter ce cabinet ?", refuse: "Refuser cette invitation ?", revoke: "Rompre la liaison avec ce cabinet ?" };
    if (!confirm(labels[act])) return;
    const r = await fetch("/api/firm-invitation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: act, payload: { link_id: linkId } })
    });
    if (!r.ok) { 
      const d = await r.json().catch(() => ({})); 
      alert(d.error || "Échec"); 
      return; 
    }
    load();
  }

  if (loading) return <div style={loadingStyle}>Chargement...</div>;

  // v8.48.32 — Séparer les pending selon qui a initié :
  //  - initiated_by="firm" : le cabinet t'invite, tu dois accepter/refuser
  //  - initiated_by="client" : c'est TOI qui as invité le cabinet, tu attends sa réponse
  const pendingFromFirm = links.filter((l) => l.status === "pending" && l.initiated_by === "firm");
  const pendingSentByMe = links.filter((l) => l.status === "pending" && l.initiated_by === "client");
  const accepted = links.filter((l) => l.status === "accepted");
  const others = links.filter((l) => !["pending", "accepted"].includes(l.status));

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "20px 24px" }}>
      <h1 style={{ fontFamily: "Syne, sans-serif", fontSize: 32, fontWeight: 700, margin: "0 0 8px 0", letterSpacing: "-0.02em" }}>
        MON CABINET COMPTABLE
      </h1>
      <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 24 }}>
        Donnez à votre cabinet comptable un accès en lecture à votre comptabilité.
      </div>

      {/* Invitations en attente */}
      {pendingFromFirm.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={sectionTitleStyle}>⏳ Invitations reçues</h3>
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10 }}>
            Ces cabinets vous ont invité à leur donner accès à votre comptabilité.
          </div>
          {pendingFromFirm.map((l) => (
            <PendingCard key={l.id} link={l} onAccept={() => action(l.id, "accept")} onRefuse={() => action(l.id, "refuse")} />
          ))}
        </div>
      )}

      {pendingSentByMe.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={sectionTitleStyle}>📤 Invitations envoyées</h3>
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 10 }}>
            Vous avez invité ces cabinets. En attente de leur acceptation.
          </div>
          {pendingSentByMe.map((l) => (
            <SentInvitationCard key={l.id} link={l} onRevoke={() => action(l.id, "revoke")} />
          ))}
        </div>
      )}

      {/* Cabinet actuel */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <h3 style={sectionTitleStyle}>✅ Mon cabinet rattaché</h3>
          {accepted.length === 0 && pendingSentByMe.length === 0 && (
            <button className="btn btn-primary btn-sm" onClick={() => setShowInvite(true)}>
              + Inviter un cabinet
            </button>
          )}
        </div>
        {accepted.length === 0 && pendingSentByMe.length === 0 ? (
          <div className="card card-pad" style={{ textAlign: "center", padding: 30, color: "var(--muted)" }}>
            <div style={{ fontSize: 13, marginBottom: 8 }}>Aucun cabinet rattaché.</div>
            <div style={{ fontSize: 11 }}>
              Si vous avez un comptable, vous pouvez l'inviter à gérer votre dossier sur IO BILL.
            </div>
          </div>
        ) : accepted.length === 0 ? null : (
          accepted.map((l) => (
            <ActiveFirmCard key={l.id} link={l} onRevoke={() => action(l.id, "revoke")} />
          ))
        )}
      </div>

      {/* v8.86 — Relevés bancaires (transmis au cabinet) */}
      {company?.id && <BankStatementsSection token={token} company={company} user={user} />}

      {/* Historique */}
      {others.length > 0 && (
        <details style={{ marginTop: 24 }}>
          <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--muted)" }}>
            Historique ({others.length})
          </summary>
          <div style={{ marginTop: 12 }}>
            {others.map((l) => (
              <div key={l.id} className="card" style={{ padding: 10, marginBottom: 6, fontSize: 12, color: "var(--muted2)" }}>
                {l._firm?.name || l.invited_email} · <span style={{ textTransform: "capitalize" }}>{l.status}</span> · {fmtDate(l.refused_at || l.revoked_at || l.created_at)}
              </div>
            ))}
          </div>
        </details>
      )}

      {showInvite && (
        <InviteFirmModal
          token={token}
          company={company}
          onClose={() => setShowInvite(false)}
          onSuccess={() => { setShowInvite(false); load(); }}
        />
      )}
    </div>
  );
}

function PendingCard({ link, onAccept, onRefuse }) {
  return (
    <div className="card" style={{ padding: 14, marginBottom: 8, border: "1px solid rgba(212,168,67,0.4)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            {link._firm?.name || "Cabinet"}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>
            SIRET {link._firm?.siret} · {link._firm?.email} · Invité le {fmtDate(link.created_at)}
          </div>
          {link.message_invite && (
            <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted2)", fontStyle: "italic", padding: "6px 10px", background: "rgba(255,255,255,0.03)", borderRadius: 4 }}>
              «{link.message_invite}»
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn btn-ghost btn-sm" onClick={onRefuse}>Refuser</button>
          <button className="btn btn-primary btn-sm" onClick={onAccept}>✅ Accepter</button>
        </div>
      </div>
    </div>
  );
}

// v8.48.32 — Carte pour une invitation ENVOYÉE par l'abonné, en attente
// de réponse du cabinet. Pas de bouton Accepter (c'est au cabinet de le faire),
// juste Annuler pour retirer l'invitation.
function SentInvitationCard({ link, onRevoke }) {
  return (
    <div className="card" style={{ padding: 14, marginBottom: 8, border: "1px dashed rgba(212,168,67,0.4)", opacity: 0.85 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            {link._firm?.name || link.invited_email || "Cabinet"}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>
            {link.invited_siret ? `SIRET ${link.invited_siret} · ` : ""}
            {link.invited_email} · Envoyée le {fmtDate(link.created_at)}
          </div>
          {link.message_invite && (
            <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 6, fontStyle: "italic" }}>
              « {link.message_invite} »
            </div>
          )}
          <div style={{ fontSize: 11, color: "var(--gold, #d4a843)", marginTop: 6 }}>
            ⏳ En attente d'acceptation par le cabinet
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onRevoke} style={{ fontSize: 11 }}>
          Annuler l'invitation
        </button>
      </div>
    </div>
  );
}

function ActiveFirmCard({ link, onRevoke }) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{link._firm?.name}</span>
            <span className="badge badge-green">Actif</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>
            SIRET {link._firm?.siret} · {link._firm?.email} · Lié depuis le {fmtDate(link.accepted_at)}
          </div>
          <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 8 }}>
            Ce cabinet peut consulter vos factures et achats en lecture seule, et signaler des anomalies.
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onRevoke}>
          Rompre la liaison
        </button>
      </div>
    </div>
  );
}

function InviteFirmModal({ token, company, onClose, onSuccess }) {
  const [siret, setSiret] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  async function submit() {
    setErr(null);
    const cleanSiret = siret.replace(/\s/g, "");
    if (cleanSiret.length !== 14) { setErr("Le SIRET doit contenir 14 chiffres"); return; }
    if (!email.includes("@")) { setErr("Email invalide"); return; }
    setLoading(true);
    const r = await fetch("/api/firm-invitation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        action: "create_from_client",
        payload: { company_id: company.id, siret: cleanSiret, email: email.trim(), message: message.trim() }
      })
    });
    const data = await r.json();
    setLoading(false);
    if (!r.ok) { setErr(data.error || "Échec invitation"); return; }
    onSuccess();
  }

  return (
    <div style={modalBackdrop} onClick={onClose}>
      <div className="card card-pad" style={modalBox} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 12px 0", fontSize: 16 }}>Inviter mon cabinet comptable</h3>
        <p style={{ fontSize: 12, color: "var(--muted)", marginBottom: 16 }}>
          Le cabinet doit déjà avoir un compte IO BILL pour pouvoir vous gérer.
          Demandez-lui son SIRET et son email.
        </p>

        <label className="form-label">SIRET du cabinet *</label>
        <input
          type="text"
          className="form-input"
          value={siret}
          onChange={(e) => setSiret(e.target.value.replace(/[^\d\s]/g, "").slice(0, 17))}
          placeholder="14 chiffres"
          style={{ fontFamily: "monospace", marginBottom: 12 }}
        />

        <label className="form-label">Email du cabinet *</label>
        <input
          type="email"
          className="form-input"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="contact@cabinet.com"
          style={{ marginBottom: 12 }}
        />

        <label className="form-label">Message (optionnel)</label>
        <textarea
          className="form-input"
          rows={3}
          value={message}
          onChange={(e) => setMessage(e.target.value.slice(0, 500))}
          placeholder="Ex : Bonjour, je souhaiterais que vous gériez ma comptabilité..."
          style={{ resize: "vertical", marginBottom: 12 }}
        />

        {err && <div className="alert-danger" style={{ marginBottom: 12, fontSize: 12 }}>{err}</div>}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Annuler</button>
          <button className="btn btn-primary btn-sm" onClick={submit} disabled={loading}>
            {loading ? "Envoi..." : "Envoyer la demande"}
          </button>
        </div>
      </div>
    </div>
  );
}

const sectionTitleStyle = { fontSize: 13, textTransform: "uppercase", letterSpacing: 1, color: "var(--muted)", margin: "0 0 12px 0", fontWeight: 600 };
const loadingStyle = { minHeight: 400, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontSize: 13 };
const modalBackdrop = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300, backdropFilter: "blur(4px)" };
const modalBox = { maxWidth: 500, width: "100%", margin: 20 };

// ════════════════════════════════════════════════════════════════
// v8.86 — Relevés bancaires : l'abonné dépose ses relevés (fichier +
// nom choisi). Ils sont visibles en lecture par son cabinet comptable
// (onglet "Relevés bancaires" côté cabinet). Bucket privé bank-statements ;
// URL signée via l'action pdf_refresh_url.
// ════════════════════════════════════════════════════════════════
function BankStatementsSection({ token, company, user }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [file, setFile] = useState(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function load() {
    const rows = await sb.select(token, "bank_statements", {
      filter: `company_id=eq.${company.id}`,
      order: "created_at.desc",
      limit: 200
    });
    setItems(rows || []);
    setLoading(false);
  }
  useEffect(() => { load(); }, [company?.id]);

  function pick(f) {
    setErr("");
    if (!f) { setFile(null); return; }
    setFile(f);
    // Pré-remplit le nom avec le nom de fichier (sans extension) si vide.
    if (!name.trim()) {
      const base = f.name.replace(/\.[^.]+$/, "");
      setName(base);
    }
  }

  async function upload() {
    if (!file) { setErr("Choisissez un fichier."); return; }
    if (!name.trim()) { setErr("Donnez un nom au relevé."); return; }
    setBusy(true); setErr("");
    try {
      const ext = (file.name.split(".").pop() || "pdf").toLowerCase().slice(0, 5);
      const stamp = Date.now();
      const path = `${company.id}/${stamp}_${name.trim().replace(/[^\w.-]+/g, "_")}.${ext}`;
      const uploaded = await sb.uploadFile(token, "bank-statements", path, file);
      if (!uploaded) {
        setErr("Échec de l'upload. Vérifiez que le bucket 'bank-statements' existe (F12 pour les détails).");
        setBusy(false); return;
      }
      const inserted = await sb.insert(token, "bank_statements", {
        company_id: company.id,
        file_url: path,
        file_name: name.trim(),
        size_bytes: file.size,
        mime: file.type || null,
        uploaded_by: user?.id || null
      });
      if (!inserted) { setErr("Fichier uploadé mais enregistrement échoué."); setBusy(false); return; }
      setItems((prev) => [inserted[0] || { id: stamp, file_url: path, file_name: name.trim(), created_at: new Date().toISOString(), size_bytes: file.size }, ...prev]);
      setFile(null); setName("");
    } catch (e) {
      setErr(e.message || "Erreur");
    }
    setBusy(false);
  }

  async function openFile(it) {
    const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
    const storedUrl = `${SUPABASE_URL}/storage/v1/object/sign/bank-statements/${it.file_url}`;
    try {
      const r = await fetch("/api/firm-invitation", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "pdf_refresh_url", payload: { stored_url: storedUrl } })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.pdf_url) { alert(j.error || "Impossible d'ouvrir le fichier"); return; }
      window.open(j.pdf_url, "_blank");
    } catch (e) { alert("Erreur : " + e.message); }
  }

  async function remove(it) {
    if (!confirm(`Supprimer le relevé « ${it.file_name} » ?`)) return;
    await sb.delete(token, "bank_statements", `id=eq.${it.id}`);
    setItems((prev) => prev.filter((x) => x.id !== it.id));
    // Best-effort : suppression du fichier Storage (l'entrée BDD est déjà retirée).
    try { await sb.deleteFile?.(token, "bank-statements", it.file_url); } catch (_) {}
  }

  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={sectionTitleStyle}>🏦 Relevés bancaires</h3>
      <div className="card card-pad" style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 12 }}>
          Déposez vos relevés bancaires : ils seront consultables par votre cabinet comptable depuis son espace.
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 10, alignItems: "end" }}>
          <label className="form-row">
            <span className="form-label">Nom du relevé</span>
            <input className="form-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="ex : Relevé SG août 2026" />
          </label>
          <label className="form-row">
            <span className="form-label">Fichier (PDF, image…)</span>
            <input className="form-input" type="file" accept=".pdf,image/*" onChange={(e) => pick(e.target.files?.[0] || null)} />
          </label>
          <button className="btn btn-primary" onClick={upload} disabled={busy || !file}>
            {busy ? "⏳ Envoi…" : "⬆️ Déposer"}
          </button>
        </div>
        {err && <div style={{ color: "var(--red)", fontSize: 12, marginTop: 8 }}>{err}</div>}
      </div>

      {loading ? (
        <div style={{ color: "var(--muted)", fontSize: 12 }}>Chargement…</div>
      ) : items.length === 0 ? (
        <div className="card card-pad" style={{ textAlign: "center", color: "var(--muted)", fontSize: 12, padding: 20 }}>
          Aucun relevé déposé pour le moment.
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          {items.map((it) => (
            <div key={it.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--border2, rgba(255,255,255,0.06))" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{it.file_name}</div>
                <div style={{ fontSize: 11, color: "var(--muted)" }}>
                  {fmtDate(it.created_at)}{it.size_bytes ? ` · ${(it.size_bytes / 1024).toFixed(0)} Ko` : ""}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => openFile(it)} title="Ouvrir">👁</button>
                <button className="btn btn-ghost btn-sm" onClick={() => remove(it)} title="Supprimer" style={{ color: "var(--red)" }}>🗑</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
