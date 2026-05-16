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
export function DocumentPreviewModal({ token, docType, doc, onClose }) {
  const [pdfUrl, setPdfUrl] = useState(null);
  const [pdfBlobUrl, setPdfBlobUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
