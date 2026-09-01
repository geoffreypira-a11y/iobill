import React, { useEffect, useState } from "react";
import { sb } from "../lib/supabase.js";
import { fmtDate } from "../lib/helpers.js";

/**
 * v8.48 — Suivi des envois email.
 *
 * Affiche, pour un document précis (facture, devis, avoir) ou pour toute la
 * société, l'état réel de chaque email : parti, délivré chez le client, ouvert,
 * rejeté (bounce), marqué en spam, ou non envoyé — avec le motif.
 *
 * Les statuts "délivré / ouvert / rejeté" proviennent des accusés Resend
 * (webhook /api/public?op=email_events).
 *
 * Props :
 *  - token     : JWT Supabase
 *  - document  : { id, number, type } pour filtrer sur un document (optionnel)
 *  - title     : titre de la modale (optionnel)
 *  - onClose() : fermeture
 */

export const EMAIL_STATUS = {
  queued:     { label: "En attente",  icon: "⏳", color: "var(--muted2)",
                help: "Email en file d'attente." },
  sent:       { label: "Envoyé",      icon: "📤", color: "var(--gold, #d4a843)",
                help: "Accepté par le serveur d'envoi. En attente de l'accusé de réception du serveur du client." },
  delivered:  { label: "Délivré",     icon: "✅", color: "#3ecf7a",
                help: "Remis dans la boîte du destinataire. S'il ne le voit pas, il est très probablement dans ses spams." },
  opened:     { label: "Ouvert",      icon: "👁️", color: "#3ecf7a",
                help: "Le destinataire a ouvert l'email." },
  clicked:    { label: "Lien cliqué", icon: "🖱️", color: "#3ecf7a",
                help: "Le destinataire a cliqué un lien de l'email." },
  delayed:    { label: "Retardé",     icon: "🕒", color: "var(--orange, #e2953f)",
                help: "Le serveur du destinataire diffère la remise. De nouvelles tentatives sont en cours." },
  bounced:    { label: "Rejeté",      icon: "⛔", color: "var(--red, #e54949)",
                help: "Le serveur du destinataire a refusé l'email : adresse inexistante, boîte pleine ou domaine invalide." },
  complained: { label: "Spam",        icon: "🚫", color: "var(--red, #e54949)",
                help: "Le destinataire a signalé l'email comme indésirable." },
  failed:     { label: "Échec",       icon: "❌", color: "var(--red, #e54949)",
                help: "L'email n'a pas pu être remis au service d'envoi." },
  skipped:    { label: "Non envoyé",  icon: "⚠️", color: "var(--orange, #e2953f)",
                help: "Aucun email n'est parti — voir le motif." }
};

const KIND_LABEL = {
  invoice: "Facture",
  quote: "Devis",
  credit_note: "Avoir",
  reminder: "Relance",
  notification: "Notification"
};

const TEMPLATE_LABEL = {
  courteous: "rappel courtois (J+3)",
  first: "1ʳᵉ relance (J+10)",
  second: "2ᵉ relance (J+30)",
  final: "dernière relance (J+60)"
};

export function EmailStatusBadge({ status }) {
  const s = EMAIL_STATUS[status] || EMAIL_STATUS.queued;
  return (
    <span
      title={s.help}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5,
        fontSize: 11, fontWeight: 700, letterSpacing: 0.3,
        color: s.color, whiteSpace: "nowrap"
      }}
    >
      {s.icon} {s.label}
    </span>
  );
}

export function EmailTrackingModal({ token, document = null, title, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const filter = document
        ? `document_id=eq.${document.id}`
        : "";
      const data = await sb.select(token, "email_log", {
        filter,
        order: "created_at.desc",
        limit: document ? 50 : 30
      });
      if (!alive) return;
      // Si la migration v8.48 n'est pas encore appliquée, sb.select renvoie []
      // comme pour « aucun envoi » : on affiche simplement l'état vide.
      setRows(Array.isArray(data) ? data : []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, document?.id]);

  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-md">
        <div className="modal-hd">
          <span className="modal-title">
            {title || (document
              ? `Suivi des envois — ${document.number || ""}`
              : "Suivi des envois")}
          </span>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {loading ? (
            <div style={{ fontSize: 13, color: "var(--muted2)" }}>Chargement…</div>
          ) : rows.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--muted2)", lineHeight: 1.7 }}>
              Aucun envoi enregistré{document ? " pour ce document" : ""}.
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--muted)" }}>
                Le journal démarre à la mise en service du suivi : les emails
                envoyés avant n'y figurent pas.
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {rows.map((r) => <EmailLogRow key={r.id} row={r} showDoc={!document} />)}
            </div>
          )}

          <div style={{
            marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--border)",
            fontSize: 11.5, color: "var(--muted)", lineHeight: 1.8
          }}>
            <strong style={{ color: "var(--muted2)" }}>Comment lire ces statuts&nbsp;?</strong><br />
            <strong>Délivré</strong> = l'email est arrivé chez le destinataire. S'il dit ne rien
            avoir reçu, il est dans ses indésirables : demandez‑lui de chercher
            « {"IO BILL"} » et de marquer l'expéditeur comme fiable.<br />
            <strong>Rejeté</strong> = l'adresse est invalide ou la boîte est pleine → corrigez
            l'email sur la fiche client.<br />
            <strong>Non envoyé</strong> = rien n'est parti (souvent : pas d'adresse email sur la
            fiche client).
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onClose}>Fermer</button>
        </div>
      </div>
    </div>
  );
}

function EmailLogRow({ row, showDoc }) {
  const s = EMAIL_STATUS[row.status] || EMAIL_STATUS.queued;
  const when = row.created_at ? new Date(row.created_at) : null;
  const kind = KIND_LABEL[row.kind] || row.kind;

  return (
    <div style={{
      border: "1px solid var(--border)", borderRadius: 8,
      padding: "12px 14px", background: "var(--card2)"
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 3 }}>
            {row.channel === "sms" ? "📱 SMS" : "✉️"} {kind}
            {showDoc && row.document_number ? ` ${row.document_number}` : ""}
            {row.reminder_template ? ` · ${TEMPLATE_LABEL[row.reminder_template] || row.reminder_template}` : ""}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--muted2)", wordBreak: "break-all" }}>
            {row.recipient || "—"}
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <EmailStatusBadge status={row.status} />
          <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 3 }}>
            {when ? `${fmtDate(row.created_at)} ${when.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : ""}
          </div>
        </div>
      </div>

      {row.subject && (
        <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 8 }}>
          Objet : {row.subject}
        </div>
      )}

      {/* Chronologie des accusés Resend */}
      {(row.delivered_at || row.opened_at || row.bounced_at) && (
        <div style={{ fontSize: 11, color: "var(--muted2)", marginTop: 6, lineHeight: 1.7 }}>
          {row.delivered_at && <div>✅ Délivré le {fmtDate(row.delivered_at)} à {new Date(row.delivered_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</div>}
          {row.opened_at && <div>👁️ Ouvert le {fmtDate(row.opened_at)} à {new Date(row.opened_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</div>}
          {row.bounced_at && <div>⛔ Rejeté le {fmtDate(row.bounced_at)}</div>}
        </div>
      )}

      {row.error && (
        <div style={{
          marginTop: 8, padding: "7px 10px", borderRadius: 6, fontSize: 11.5,
          background: "rgba(229,73,73,.10)", color: s.color, lineHeight: 1.5,
          wordBreak: "break-word"
        }}>
          {row.error}
        </div>
      )}
    </div>
  );
}
