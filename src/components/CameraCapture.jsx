import React, { useState, useRef, useEffect } from "react";
import { Icon } from "./Icon.jsx";

/**
 * Composant de capture photo via camera mobile (PWA).
 * Utilise getUserMedia (camera arriere par defaut sur mobile).
 *
 * Props:
 *   onCapture(blob: Blob, dataUrl: string)  — callback avec l'image capturee
 *   onClose()                                 — fermer la modale
 *   facingMode = "environment" | "user"
 */
export function CameraCapture({ onCapture, onClose, facingMode = "environment" }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [captured, setCaptured] = useState(null); // {blob, dataUrl}
  const [torch, setTorch] = useState(false);
  const [hasTorch, setHasTorch] = useState(false);

  // Demarrage camera
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setError("Votre navigateur ne supporte pas la caméra.");
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: facingMode },
            width:  { ideal: 1920 },
            height: { ideal: 1080 }
          },
          audio: false
        });
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }

        // Detection du torch (lampe) si dispo
        const track = stream.getVideoTracks()[0];
        const caps = track.getCapabilities ? track.getCapabilities() : {};
        if (caps.torch) setHasTorch(true);

        setReady(true);
      } catch (e) {
        const code = e?.name || "";
        if (code === "NotAllowedError" || code === "PermissionDeniedError") {
          setError("Permission caméra refusée. Activez-la dans les paramètres du navigateur.");
        } else if (code === "NotFoundError") {
          setError("Aucune caméra détectée sur cet appareil.");
        } else {
          setError("Impossible d'accéder à la caméra : " + (e.message || code));
        }
      }
    })();
    return () => {
      alive = false;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, [facingMode]);

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch }] });
      setTorch(!torch);
    } catch {}
  }

  function takePhoto() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, w, h);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      setCaptured({ blob, dataUrl });
    }, "image/jpeg", 0.85);
  }

  function retake() {
    setCaptured(null);
  }

  function confirm() {
    if (!captured) return;
    onCapture(captured.blob, captured.dataUrl);
  }

  // Permettre la fermeture au clavier (touche Echap)
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div style={{
      position: "fixed", inset: 0, background: "#000", zIndex: 9999,
      display: "flex", flexDirection: "column"
    }}>
      {/* Header */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, padding: "14px 16px",
        background: "linear-gradient(180deg, rgba(0,0,0,0.7), transparent)",
        display: "flex", alignItems: "center", justifyContent: "space-between", zIndex: 2
      }}>
        <button
          onClick={onClose}
          style={{
            background: "rgba(255,255,255,0.1)", color: "#fff", border: "none",
            padding: "8px 12px", borderRadius: 20, fontSize: 14, cursor: "pointer"
          }}
        >
          ← Annuler
        </button>
        <div style={{
          color: "#d4a843", fontFamily: "Syne, sans-serif", fontSize: 12,
          letterSpacing: 2, textTransform: "uppercase"
        }}>
          📸 Scanner facture
        </div>
        {hasTorch ? (
          <button
            onClick={toggleTorch}
            style={{
              background: torch ? "#d4a843" : "rgba(255,255,255,0.1)",
              color: torch ? "#0b0c10" : "#fff",
              border: "none", padding: "8px 12px", borderRadius: 20,
              fontSize: 14, cursor: "pointer"
            }}
          >
            💡 {torch ? "ON" : "OFF"}
          </button>
        ) : <div style={{ width: 60 }} />}
      </div>

      {/* Zone video / capture */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        {error ? (
          <div style={{ color: "#fff", padding: 30, textAlign: "center" }}>
            <div style={{ fontSize: 40, marginBottom: 14 }}>📷</div>
            <div style={{ fontSize: 14, marginBottom: 18 }}>{error}</div>
            <button
              onClick={onClose}
              style={{ background: "#d4a843", color: "#0b0c10", border: "none", padding: "10px 18px", borderRadius: 8, fontWeight: 600, cursor: "pointer" }}
            >
              Fermer
            </button>
          </div>
        ) : captured ? (
          <img
            src={captured.dataUrl}
            alt="Capture"
            style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
          />
        ) : (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        )}

        {/* Overlay viseur quand camera live */}
        {!captured && !error && ready && (
          <div style={{
            position: "absolute", left: "10%", right: "10%", top: "20%", bottom: "25%",
            border: "2px dashed rgba(212, 168, 67, 0.6)", borderRadius: 12,
            pointerEvents: "none"
          }}>
            <div style={{
              position: "absolute", left: 0, right: 0, bottom: -28, textAlign: "center",
              color: "rgba(212, 168, 67, 0.8)", fontSize: 11, letterSpacing: 1
            }}>
              Cadrez la facture dans le rectangle
            </div>
          </div>
        )}
      </div>

      <canvas ref={canvasRef} style={{ display: "none" }} />

      {/* Footer : actions */}
      <div style={{
        background: "linear-gradient(0deg, rgba(0,0,0,0.85), transparent)",
        padding: "20px 16px 30px", display: "flex", alignItems: "center",
        justifyContent: "center", gap: 30
      }}>
        {captured ? (
          <>
            <button
              onClick={retake}
              style={{
                background: "rgba(255,255,255,0.15)", color: "#fff", border: "none",
                padding: "12px 22px", borderRadius: 30, fontSize: 14, cursor: "pointer"
              }}
            >
              ↻ Reprendre
            </button>
            <button
              onClick={confirm}
              style={{
                background: "#d4a843", color: "#0b0c10", border: "none",
                padding: "14px 28px", borderRadius: 30, fontSize: 15, fontWeight: 700,
                cursor: "pointer"
              }}
            >
              ✓ Utiliser cette photo
            </button>
          </>
        ) : (
          <button
            onClick={takePhoto}
            disabled={!ready}
            aria-label="Prendre une photo"
            style={{
              width: 76, height: 76, borderRadius: "50%",
              background: ready ? "#fff" : "#666", border: "5px solid rgba(212, 168, 67, 0.7)",
              cursor: ready ? "pointer" : "not-allowed",
              boxShadow: "0 0 0 2px rgba(0,0,0,0.4)"
            }}
          />
        )}
      </div>
    </div>
  );
}
