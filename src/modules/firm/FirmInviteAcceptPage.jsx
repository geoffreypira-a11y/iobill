import React, { useState, useEffect } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtDate } from "../../lib/helpers.js";

/**
 * FirmInviteAcceptPage — Cote CLIENT : voir et accepter/refuser la demande
 * d'un cabinet pour superviser leur comptabilite.
 */
export function FirmInviteAcceptPage({ token, user, company }) {
  const { inviteId } = useParams();
  const navigate = useNavigate();
  const [invite, setInvite] = useState(null);
  const [firm, setFirm] = useState(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      // Charger l'invitation
      const inv = await sb.selectOne(token, "firm_clients", `id=eq.${inviteId}`);
      if (!alive) return;
      if (!inv) { setErr("Invitation introuvable"); setLoading(false); return; }
      if (inv.company_id !== company.id) { setErr("Cette invitation ne concerne pas votre entreprise"); setLoading(false); return; }
      setInvite(inv);

      // Charger les infos du cabinet
      const f = await sb.selectOne(token, "firms", `id=eq.${inv.firm_id}`);
      setFirm(f);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, inviteId, company.id]);

  async function accept() {
    setActing(true);
    setErr("");
    const updated = await sb.update(token, "firm_clients", `id=eq.${inviteId}`, {
      accepted_at: new Date().toISOString()
    });
    setActing(false);
    if (updated && updated[0]) {
      // Increment client_count cote firm (idealement via trigger SQL, mais en V1 on le fait ici)
      // Cette mise a jour echoue silencieusement si le user n'a pas les droits — c'est OK
      sb.rpc(token, "firm_client_count_inc", { p_firm_id: invite.firm_id }).catch(() => {});
      navigate("/?firm-accepted=1");
    } else {
      setErr("Impossible d'accepter l'invitation");
    }
  }

  async function refuse() {
    if (!confirm("Refuser cette demande de supervision ?")) return;
    setActing(true);
    const updated = await sb.update(token, "firm_clients", `id=eq.${inviteId}`, {
      revoked_at: new Date().toISOString()
    });
    setActing(false);
    if (updated && updated[0]) navigate("/");
  }

  if (loading) {
    return <div className="page"><div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Chargement...</div></div>;
  }

  if (err) {
    return (
      <div className="page" style={{ maxWidth: 520 }}>
        <div className="card card-pad" style={{ textAlign: "center", padding: 50 }}>
          <div style={{ fontSize: 36, marginBottom: 14 }}>⚠️</div>
          <div style={{ marginBottom: 18 }}>{err}</div>
          <Link to="/" className="btn btn-primary">Retour à l'accueil</Link>
        </div>
      </div>
    );
  }

  const alreadyAccepted = !!invite.accepted_at;
  const revoked = !!invite.revoked_at;

  return (
    <div className="page" style={{ maxWidth: 600 }}>
      <div className="page-header">
        <div>
          <div className="page-title">DEMANDE DE SUPERVISION</div>
          <div className="page-sub">{firm?.legal_name || "Cabinet"}</div>
        </div>
      </div>

      <div className="card card-pad">
        <div style={{ fontSize: 40, marginBottom: 14, textAlign: "center" }}>🏛️</div>

        <div style={{ fontSize: 13, color: "var(--muted2)", lineHeight: 1.7, marginBottom: 18, textAlign: "center" }}>
          Le cabinet <strong style={{ color: "var(--text)" }}>{firm?.legal_name}</strong> a demandé
          à superviser la comptabilité de <strong style={{ color: "var(--text)" }}>{company.legal_name}</strong>.
        </div>

        <div style={{ background: "var(--card2)", padding: 14, borderRadius: 8, marginBottom: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "8px 14px", fontSize: 12 }}>
            <div style={{ color: "var(--muted)" }}>Cabinet</div>
            <div>{firm?.legal_name}</div>
            {firm?.email && (<><div style={{ color: "var(--muted)" }}>Email</div><div>{firm.email}</div></>)}
            {firm?.siret && (<><div style={{ color: "var(--muted)" }}>SIRET</div><div className="mono">{firm.siret}</div></>)}
            <div style={{ color: "var(--muted)" }}>Niveau d'accès</div>
            <div>
              <span className="badge badge-gold">
                {invite.access_level === "editor" ? "✏️ Édition" : "👁️ Lecture seule"}
              </span>
            </div>
            <div style={{ color: "var(--muted)" }}>Demande envoyée</div>
            <div>{fmtDate(invite.invited_at)}</div>
          </div>
        </div>

        {invite.access_level === "viewer" ? (
          <div style={{ fontSize: 12, color: "var(--muted2)", marginBottom: 18, lineHeight: 1.6 }}>
            En mode <strong>Lecture seule</strong>, le cabinet pourra <strong>consulter</strong> :
            factures, devis, achats, déclarations TVA et URSSAF, exports comptables.
            <br />Il ne pourra rien modifier.
          </div>
        ) : (
          <div style={{ fontSize: 12, color: "var(--muted2)", marginBottom: 18, lineHeight: 1.6 }}>
            En mode <strong>Édition</strong>, le cabinet pourra : consulter et créer des factures,
            valider des achats, lancer des relances, générer des déclarations TVA/URSSAF.
            <br />Vous restez <strong>propriétaire</strong> de votre dossier — toutes les actions du cabinet sont tracées.
          </div>
        )}

        <div style={{ background: "rgba(212, 168, 67, 0.08)", padding: 12, borderRadius: 7, fontSize: 11, color: "var(--muted2)", marginBottom: 18, lineHeight: 1.6 }}>
          <strong style={{ color: "var(--gold)" }}>Vos droits :</strong> vous pouvez révoquer cet accès
          à tout moment depuis Settings → Cabinet superviseur. Toutes les actions du cabinet seront
          conservées dans votre audit log.
        </div>

        {alreadyAccepted && (
          <div className="tipline" style={{ marginBottom: 14, color: "var(--green)" }}>
            ✓ Vous avez accepté cette demande le {fmtDate(invite.accepted_at)}
          </div>
        )}
        {revoked && (
          <div className="tipline" style={{ marginBottom: 14, color: "var(--red)" }}>
            Cette demande a été refusée ou révoquée le {fmtDate(invite.revoked_at)}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          {!alreadyAccepted && !revoked && (
            <>
              <button className="btn btn-ghost" onClick={refuse} disabled={acting} style={{ color: "var(--red)" }}>
                Refuser
              </button>
              <button className="btn btn-primary" onClick={accept} disabled={acting}>
                {acting ? "Acceptation..." : "✓ Accepter"}
              </button>
            </>
          )}
          {(alreadyAccepted || revoked) && (
            <Link to="/" className="btn btn-primary">Retour à l'accueil</Link>
          )}
        </div>
      </div>
    </div>
  );
}
