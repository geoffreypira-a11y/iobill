import React, { useCallback, useEffect, useMemo, useState } from "react";
import { sb } from "../../lib/supabase.js";
import { fmtEUR } from "../../lib/helpers.js";

/**
 * PaInboxSection — v8.48
 * Encart « 📥 Factures reçues (PA) » affiché EN HAUT de la page Achats.
 * Ne s'affiche que s'il y a au moins une facture non comptabilisée
 * (ou si le filtre « refusées » est actif).
 *
 * Actions par ligne :
 *   👁 PDF          → URL signée 1h
 *   ✅ Approuver    → sendEvent(approuvee) au fournisseur
 *   ❌ Refuser      → sendEvent(refusee) + motif obligatoire
 *   📗 Comptabiliser → crée un purchase, appelle onConverted()
 *
 * Les refusées restent visibles avec un badge rouge. Un toggle
 * « Masquer les refusées » les cache si l'utilisateur préfère.
 */
export function PaInboxSection({ token, company, onConverted }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [hideRefused, setHideRefused] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [msg, setMsg] = useState(null);
  const [preview, setPreview] = useState(null); // v8.48.3 : modale PDF

  const load = useCallback(async () => {
    try {
      // status IN (received, refused) — approved est un état transitoire
      // avant Comptabiliser ; converted disparaît (déjà dans purchases).
      const data = await sb.select(token, "pa_inbound_invoices", {
        filter: `company_id=eq.${company.id}&status=in.(received,approved,refused)`,
        order: "received_at.desc"
      });
      setRows(data || []);
    } catch (e) {
      setMsg({ t: "err", m: e.message });
    } finally {
      setLoading(false);
    }
  }, [token, company.id]);

  // v8.48.1 — Sync silencieux avec la PA au montage puis toutes les 90 s.
  // Aucune UI, aucun bouton nécessaire. Le composant n'est PAS visible
  // tant que rien n'est en base, donc on doit forcer la sync AVANT de
  // dépendre du fait qu'il soit monté. Comme on est monté (même invisible),
  // on peut piloter la sync ici.
  const silentSync = useCallback(async () => {
    try {
      await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: "pa_inbox_sync" })
      });
    } catch { /* pas de PDP configurée : silencieux, c'est normal */ }
    await load();
  }, [token, load]);

  useEffect(() => { silentSync(); }, [silentSync]);

  // Polling continu : 90 s. En-dessous ce n'est pas raisonnable
  // pour un endpoint tiers ; au-dessus l'utilisateur attend trop.
  useEffect(() => {
    const id = setInterval(silentSync, 90 * 1000);
    return () => clearInterval(id);
  }, [silentSync]);

  async function call(action, payload = {}) {
    const r = await fetch("/api/admin", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, payload })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Erreur ${r.status}`);
    return j;
  }

  async function sync() {
    setSyncing(true); setMsg(null);
    try {
      const r = await call("pa_inbox_sync");
      if (r.created > 0) setMsg({ t: "ok", m: `${r.created} nouvelle(s) facture(s) reçue(s)` });
      await load();
    } catch (e) { setMsg({ t: "err", m: e.message }); }
    finally { setSyncing(false); }
  }

  async function view(row) {
    setBusyId(row.id);
    try {
      const r = await call("pa_inbox_file", { inbound_id: row.id });
      setPreview({ url: r.url, row });
    } catch (e) { setMsg({ t: "err", m: "Aperçu indisponible : " + e.message }); }
    finally { setBusyId(null); }
  }

  async function ack(row, status) {
    let reason = null;
    if (status === "refused") {
      // v8.48.8 — SUPER PDP exige un code de motif AFNOR pour tout refus.
      // Codes autorisés :
      //   IC001 = Facture erronée
      //   IC003 = Destinataire incorrect
      //   IC005 = Montant erroné
      //   IC006 = TVA erronée
      //   IC008 = Autre motif
      const CODES = [
        ["IC001", "Facture erronée"],
        ["IC003", "Destinataire incorrect"],
        ["IC005", "Montant erroné"],
        ["IC006", "TVA erronée"],
        ["IC008", "Autre motif"]
      ];
      const menu = CODES.map((c, i) => (i + 1) + ". " + c[1]).join("\n");
      const pick = window.prompt("Motif du refus (transmis à " + (row.supplier_name || "l'expéditeur") + ") :\n\n" + menu + "\n\nTapez le numéro (1-5) :");
      if (pick === null) return;
      const idx = parseInt(pick, 10) - 1;
      if (isNaN(idx) || !CODES[idx]) {
        setMsg({ t: "err", m: "Choix invalide" });
        return;
      }
      const code = CODES[idx][0];
      const defaultLabel = CODES[idx][1];
      const label = window.prompt("Précision (facultatif) :", defaultLabel);
      if (label === null) return;
      reason = { code, label: label.trim() || defaultLabel };
    }
    setBusyId(row.id); setMsg(null);
    try {
      await call("pa_inbox_ack", { inbound_id: row.id, status, reason });
      await load();
    } catch (e) { setMsg({ t: "err", m: e.message }); }
    finally { setBusyId(null); }
  }

  async function convert(row) {
    setBusyId(row.id); setMsg(null);
    try {
      const r = await call("pa_inbox_convert", { inbound_id: row.id });
      setMsg({ t: "ok", m: "Facture ajoutée aux achats" });
      // Retire immédiatement la ligne pour un feedback instantané
      setRows(rs => rs.filter(x => x.id !== row.id));
      // Puis raffraîchit le tableau du bas
      onConverted?.(r.purchase_id);
    } catch (e) { setMsg({ t: "err", m: e.message }); setBusyId(null); }
    finally { setBusyId(null); }
  }

  const counts = useMemo(() => ({
    received: rows.filter(r => r.status === "received" || r.status === "approved").length,
    refused:  rows.filter(r => r.status === "refused").length
  }), [rows]);

  const visible = useMemo(
    () => hideRefused ? rows.filter(r => r.status !== "refused") : rows,
    [rows, hideRefused]
  );

  // Rien à afficher : on cache la section entière pour ne pas polluer
  // les abonnés qui n'utilisent pas encore la PA.
  if (!loading && rows.length === 0) return null;

  return (
    <div className="card" style={{ overflow: "hidden", marginBottom: 18, border: "1px solid rgba(212,168,67,.35)" }}>
      <div style={{
        padding: "12px 16px", background: "rgba(212,168,67,.08)",
        borderBottom: "1px solid rgba(212,168,67,.25)",
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap"
      }}>
        <div>
          <div style={{ fontFamily: "Syne, sans-serif", fontSize: 14, letterSpacing: 1, color: "var(--gold, #d4a843)" }}>
            📥 FACTURES REÇUES (PLATEFORME AGRÉÉE)
          </div>
          <div style={{ fontSize: 12, color: "var(--muted2)", marginTop: 3 }}>
            {counts.received} à traiter{counts.refused > 0 ? ` · ${counts.refused} refusée${counts.refused > 1 ? "s" : ""}` : ""}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {counts.refused > 0 && (
            <label style={{ fontSize: 12, color: "var(--muted)", display: "inline-flex", alignItems: "center", gap: 6 }}>
              <input type="checkbox" checked={hideRefused}
                onChange={(e) => setHideRefused(e.target.checked)} />
              Masquer les refusées
            </label>
          )}
          <button className="btn btn-ghost" onClick={sync} disabled={syncing} style={{ fontSize: 12 }}>
            {syncing ? "Sync…" : "🔄 Synchroniser"}
          </button>
        </div>
      </div>

      {msg && (
        <div style={{
          padding: "8px 16px", fontSize: 12,
          background: msg.t === "err" ? "rgba(229,73,73,.10)" : "rgba(62,207,122,.10)",
          color: msg.t === "err" ? "var(--red, #e54949)" : "var(--green, #3ecf7a)"
        }}>{msg.m}</div>
      )}

      {loading ? (
        <div style={{ padding: 20, color: "var(--muted)", textAlign: "center" }}>Chargement…</div>
      ) : visible.length === 0 ? (
        <div style={{ padding: 20, color: "var(--muted)", textAlign: "center", fontSize: 13 }}>
          Aucune facture à traiter.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ fontSize: 11, color: "var(--muted)", textAlign: "left" }}>
              <th style={th}>Fournisseur</th>
              <th style={th}>N° · Date</th>
              <th style={{ ...th, textAlign: "right" }}>HT</th>
              <th style={{ ...th, textAlign: "right" }}>TVA</th>
              <th style={{ ...th, textAlign: "right" }}>TTC</th>
              <th style={th}>Statut</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {visible.map(r => {
              const isRefused = r.status === "refused";
              return (
                <tr key={r.id} style={{ borderTop: "1px solid var(--border)", opacity: isRefused ? 0.7 : 1 }}>
                  <td style={td}>
                    <div style={{ fontWeight: 500 }}>{r.supplier_name || "Fournisseur inconnu"}</div>
                    {r.supplier_siren && <div style={{ fontSize: 11, color: "var(--muted)" }}>SIREN {r.supplier_siren}</div>}
                  </td>
                  <td style={td}>
                    <div>{r.invoice_number || "—"}</div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>{r.invoice_date || "—"}</div>
                  </td>
                  <td style={{ ...td, textAlign: "right" }} className="mono">{fmtEUR(r.subtotal_ht_cents)}</td>
                  <td style={{ ...td, textAlign: "right" }} className="mono">{fmtEUR(r.vat_total_cents)}</td>
                  <td style={{ ...td, textAlign: "right" }} className="mono" >
                    <strong style={{ color: "var(--gold)" }}>{fmtEUR(r.total_ttc_cents)}</strong>
                  </td>
                  <td style={td}>
                    {isRefused ? (
                      <span title={r.refusal_reason || ""} style={badge("#e54949")}>❌ Refusée</span>
                    ) : r.status === "approved" ? (
                      <span style={badge("#3ecf7a")}>✅ Approuvée</span>
                    ) : (
                      <span style={badge("#d4a843")}>📥 Reçue</span>
                    )}
                  </td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    <div style={{ display: "inline-flex", gap: 4 }}>
                      <button className="btn btn-ghost" onClick={() => view(r)}
                        disabled={busyId === r.id} style={btnSm} title="Aperçu du PDF">👁</button>
                      {!isRefused && (
                        <>
                          <button className="btn" disabled={busyId === r.id}
                            onClick={() => convert(r)}
                            style={{ ...btnSm, background: "var(--gold)", color: "#000" }}
                            title="Approuver auprès du fournisseur et ajouter aux achats">
                            📗 Comptabiliser
                          </button>
                          <button className="btn btn-ghost" disabled={busyId === r.id}
                            onClick={() => ack(r, "refused")} style={btnSm}
                            title="Refuser avec motif">❌</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {preview && (
        <div className="modal-bg" onClick={() => setPreview(null)}>
          <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: 900, width: "92vw", height: "85vh", display: "flex", flexDirection: "column" }}>
            <div className="modal-hd">
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  {preview.row.supplier_name || "Fournisseur"}
                  {preview.row.invoice_number && (
                    <span style={{ color: "var(--muted)", fontWeight: 400, marginLeft: 8 }}>
                      · {preview.row.invoice_number}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                  {preview.row.invoice_date || "—"} · {fmtEUR(preview.row.total_ttc_cents)} TTC · Factur-X
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <a href={preview.url} target="_blank" rel="noopener noreferrer"
                  className="btn btn-ghost btn-sm"
                  style={{ padding: "5px 12px", fontSize: 11, textDecoration: "none" }}>
                  ⬇ Télécharger
                </a>
                <button className="close-btn" onClick={() => setPreview(null)}>×</button>
              </div>
            </div>
            <div style={{ flex: 1, overflow: "hidden", background: "#1a1b22" }}>
              <iframe src={preview.url} title={preview.row.invoice_number || "facture"}
                style={{ width: "100%", height: "100%", border: "none" }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const th = { padding: "10px 12px", fontWeight: 500, textTransform: "uppercase", letterSpacing: 0.5 };
const td = { padding: "10px 12px", fontSize: 13, verticalAlign: "middle" };
const btnSm = { fontSize: 12, padding: "4px 8px" };

function badge(color) {
  return {
    display: "inline-block", padding: "3px 8px", borderRadius: 10, fontSize: 11,
    background: color + "20", color, border: `1px solid ${color}55`
  };
}

export default PaInboxSection;
