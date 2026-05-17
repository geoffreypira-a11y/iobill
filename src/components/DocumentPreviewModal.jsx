import React, { useEffect, useState } from "react";

/**
 * Modale d'aperçu PDF (pattern IOcar PrintDoc).
 *
 * Charge le PDF via l'API server-side et l'affiche dans un iframe.
 * Fournit boutons "Imprimer", "Télécharger", "Fermer".
 *
 * Props :
 * - token : auth
 * - docType : "quote" | "invoice"
 * - doc : objet devis/facture (pour titre)
 * - onClose() : fermeture modale
 */
export function DocumentPreviewModal({ token, docType, doc, onClose, onSend }) {
  const [pdfUrl, setPdfUrl] = useState(null);
  const [pdfBlobUrl, setPdfBlobUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let alive = true;
    let blobToRevoke = null;
    (async () => {
      try {
        // Choisir le bon endpoint selon le type
        const endpoint = docType === "quote" ? "/api/generate-quote-pdf" : "/api/generate-facturx";
        const bodyKey = docType === "quote" ? "quote_id" : "invoice_id";

        const r = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ [bodyKey]: doc.id, preview: true })
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j.error || `Erreur ${r.status} lors de la génération du PDF`);
        }
        const j = await r.json();
        if (!alive) return;

        if (j.pdf_url) {
          // URL distante : on l'utilise directement dans l'iframe
          setPdfUrl(j.pdf_url);
        } else if (j.pdf_base64) {
          // PDF en base64 : créer un blob URL local
          const byteChars = atob(j.pdf_base64);
          const bytes = new Uint8Array(byteChars.length);
          for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
          const blob = new Blob([bytes], { type: "application/pdf" });
          const url = URL.createObjectURL(blob);
          blobToRevoke = url;
          setPdfBlobUrl(url);
        } else {
          throw new Error("Réponse invalide du serveur (ni pdf_url ni pdf_base64)");
        }
        setLoading(false);
      } catch (e) {
        if (alive) {
          setError(e.message || "Erreur de chargement");
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
      if (blobToRevoke) URL.revokeObjectURL(blobToRevoke);
    };
  }, [token, docType, doc?.id]);

  const finalUrl = pdfUrl || pdfBlobUrl;
  const title = `${docType === "quote" ? "Devis" : "Facture"} ${doc.number || ""}`;

  // ─── Bandeau de statut (devis signe/converti/refuse, facture payee, etc.) ───
  let statusBanner = null;
  if (docType === "quote") {
    if (doc.status === "signed") {
      const signedDate = doc.signed_at ? new Date(doc.signed_at).toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" }) : null;
      const signedTime = doc.signed_at ? new Date(doc.signed_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : null;
      statusBanner = {
        bg: "rgba(62,207,122,0.12)",
        border: "rgba(62,207,122,0.4)",
        color: "var(--green)",
        icon: "✓",
        title: "Devis accepté",
        text: `${doc.signed_by_name ? `Signé par ${doc.signed_by_name}` : "Accepté"}${signedDate ? ` le ${signedDate}` : ""}${signedTime ? ` à ${signedTime}` : ""}${doc.signed_ip ? ` (IP ${doc.signed_ip})` : ""}`
      };
    } else if (doc.status === "converted") {
      const convDate = doc.signed_at ? new Date(doc.signed_at).toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" }) : null;
      statusBanner = {
        bg: "rgba(62,207,122,0.12)",
        border: "rgba(62,207,122,0.4)",
        color: "var(--green)",
        icon: "🧾",
        title: "Devis converti en facture",
        text: `${doc.signed_by_name ? `Signé par ${doc.signed_by_name}` : "Accepté"}${convDate ? ` le ${convDate}` : ""} puis converti en facture.`
      };
    } else if (doc.status === "refused") {
      statusBanner = {
        bg: "rgba(229,92,92,0.12)",
        border: "rgba(229,92,92,0.4)",
        color: "var(--red)",
        icon: "✗",
        title: "Devis refusé",
        text: doc.refusal_reason ? `Motif : ${doc.refusal_reason}` : "Le client a refusé ce devis."
      };
    } else if (doc.status === "sent") {
      const sentDate = doc.sent_at ? new Date(doc.sent_at).toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" }) : null;
      statusBanner = {
        bg: "rgba(212,168,67,0.10)",
        border: "rgba(212,168,67,0.4)",
        color: "var(--gold)",
        icon: "📤",
        title: "Devis envoyé",
        text: `Envoyé au client${sentDate ? ` le ${sentDate}` : ""} - En attente d'acceptation.`
      };
    }
  } else if (docType === "invoice") {
    if (doc.status === "paid") {
      statusBanner = {
        bg: "rgba(62,207,122,0.12)",
        border: "rgba(62,207,122,0.4)",
        color: "var(--green)",
        icon: "💰",
        title: "Facture payée",
        text: "Le client a réglé l'intégralité de cette facture."
      };
    } else if (doc.status === "partial") {
      statusBanner = {
        bg: "rgba(212,168,67,0.10)",
        border: "rgba(212,168,67,0.4)",
        color: "var(--gold)",
        icon: "💸",
        title: "Paiement partiel",
        text: `Encaissé : ${((doc.paid_cents || 0) / 100).toFixed(2)} € sur ${((doc.total_ttc_cents || 0) / 100).toFixed(2)} €`
      };
    } else if (doc.status === "overdue") {
      statusBanner = {
        bg: "rgba(229,92,92,0.12)",
        border: "rgba(229,92,92,0.4)",
        color: "var(--red)",
        icon: "⚠️",
        title: "Facture en retard",
        text: doc.due_date ? `Échéance dépassée : ${new Date(doc.due_date).toLocaleDateString("fr-FR")}` : "Cette facture est en retard de paiement."
      };
    } else if (doc.status === "sent" || doc.status === "issued") {
      const sentDate = doc.sent_at ? new Date(doc.sent_at).toLocaleDateString("fr-FR") : (doc.issued_at ? new Date(doc.issued_at).toLocaleDateString("fr-FR") : null);
      statusBanner = {
        bg: "rgba(212,168,67,0.10)",
        border: "rgba(212,168,67,0.4)",
        color: "var(--gold)",
        icon: "📩",
        title: doc.status === "sent" ? "Facture envoyée" : "Facture émise",
        text: `${doc.status === "sent" ? "Envoyée" : "Émise"} le ${sentDate || "—"}${doc.due_date ? ` · Échéance ${new Date(doc.due_date).toLocaleDateString("fr-FR")}` : ""}`
      };
    }
    // Surcouche : facture transmise a l'administration (PDP)
    if (doc.pdp_transmitted_at) {
      const transDate = new Date(doc.pdp_transmitted_at).toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
      statusBanner = {
        bg: "rgba(62,207,122,0.12)",
        border: "rgba(62,207,122,0.4)",
        color: "var(--green)",
        icon: "🏛️",
        title: "Transmise à l'administration",
        text: `Via ${doc.pdp_provider || "PDP"} le ${transDate}${doc.pdp_transmission_id ? ` · ID transmission : ${doc.pdp_transmission_id}` : ""}`
      };
    }
  }

  function handlePrint() {
    if (!finalUrl) return;
    // Ouvrir le PDF dans un nouvel onglet (le navigateur gère le print natif PDF)
    const printWindow = window.open(finalUrl, "_blank");
    if (printWindow) {
      // Attendre que le PDF se charge dans l'onglet, puis déclencher print
      setTimeout(() => {
        try { printWindow.print(); } catch {}
      }, 1000);
    }
  }

  function handleDownload() {
    if (!finalUrl) return;
    const a = document.createElement("a");
    a.href = finalUrl;
    a.download = `${docType === "quote" ? "Devis" : "Facture"}-${(doc.number || "").replace(/[^a-zA-Z0-9-]/g, "_")}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  return (
    <div
      className="modal-bg"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{ padding: 0, alignItems: "stretch" }}
    >
      <div
        className="modal"
        style={{
          maxWidth: "min(960px, 95vw)",
          width: "100%",
          maxHeight: "95vh",
          height: "95vh",
          display: "flex",
          flexDirection: "column",
          margin: "auto"
        }}
      >
        {/* Header avec actions */}
        <div className="modal-hd" style={{ position: "sticky", top: 0, zIndex: 2 }}>
          <span className="modal-title">
            📄 Aperçu — {title}
          </span>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {finalUrl && !loading && (
              <>
                {onSend && (
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={async () => {
                      setSending(true);
                      try { await onSend(doc); } catch {}
                      setSending(false);
                    }}
                    disabled={sending}
                    style={{ padding: "5px 12px", fontSize: 11, color: "var(--gold)", borderColor: "rgba(212,168,67,0.4)" }}
                    title="Envoyer par email au client"
                  >
                    {sending ? "⏳ Envoi..." : "📧 Envoyer"}
                  </button>
                )}
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={handleDownload}
                  style={{ padding: "5px 12px", fontSize: 11 }}
                  title="Télécharger le PDF"
                >
                  ⬇ Télécharger
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handlePrint}
                  style={{ padding: "5px 12px", fontSize: 11 }}
                  title="Imprimer ou exporter en PDF"
                >
                  🖨 Imprimer
                </button>
              </>
            )}
            <button className="close-btn" onClick={onClose} title="Fermer">×</button>
          </div>
        </div>

        {/* Bandeau de statut si applicable */}
        {statusBanner && (
          <div style={{
            padding: "12px 24px",
            background: statusBanner.bg,
            borderBottom: `1px solid ${statusBanner.border}`,
            display: "flex",
            alignItems: "center",
            gap: 12
          }}>
            <div style={{ fontSize: 20, lineHeight: 1 }}>{statusBanner.icon}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: statusBanner.color, marginBottom: 2 }}>
                {statusBanner.title}
              </div>
              <div style={{ fontSize: 11, color: "var(--muted2)", lineHeight: 1.5 }}>
                {statusBanner.text}
              </div>
            </div>
          </div>
        )}

        {/* Contenu : iframe du PDF, scrollable */}
        <div style={{
          flex: 1,
          overflow: "hidden",
          background: "var(--card2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center"
        }}>
          {loading && (
            <div style={{ textAlign: "center", color: "var(--muted)" }}>
              <div style={{ fontSize: 24, marginBottom: 12 }}>⏳</div>
              <div style={{ fontSize: 12 }}>Génération du PDF en cours...</div>
            </div>
          )}
          {error && (
            <div style={{ textAlign: "center", color: "var(--red)", padding: 40, maxWidth: 400 }}>
              <div style={{ fontSize: 24, marginBottom: 12 }}>⚠️</div>
              <div style={{ fontSize: 13, marginBottom: 16 }}>{error}</div>
              <button className="btn btn-ghost btn-sm" onClick={onClose}>Fermer</button>
            </div>
          )}
          {finalUrl && !loading && !error && (
            <iframe
              src={finalUrl}
              title={title}
              style={{
                width: "100%",
                height: "100%",
                border: "none",
                background: "#fff"
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
