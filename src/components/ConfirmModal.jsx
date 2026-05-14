import React from "react";

/**
 * Modale de confirmation générique.
 *
 * Props :
 * - title : titre (string)
 * - message : description (string ou JSX)
 * - confirmLabel : libellé du bouton de confirmation (par défaut "Confirmer")
 * - confirmType : "primary" | "danger" (par défaut "primary")
 * - onConfirm() : callback de confirmation
 * - onCancel() : callback d'annulation
 */
export function ConfirmModal({
  title,
  message,
  confirmLabel = "Confirmer",
  confirmType = "primary",
  onConfirm,
  onCancel
}) {
  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal modal-sm">
        <div className="modal-hd">
          <span className="modal-title">{title}</span>
          <button className="close-btn" onClick={onCancel}>×</button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--text)" }}>
            {message}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={onCancel}>Annuler</button>
          <button
            className={"btn " + (confirmType === "danger" ? "btn-danger" : "btn-primary")}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
