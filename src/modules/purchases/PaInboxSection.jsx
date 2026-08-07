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
  const [refuseModal, setRefuseModal] = useState(null); // v8.56 : modale refus

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

  // v8.56 — UX refus refondue : plutôt qu'un window.prompt cheap qui
  // rendait la saisie du motif MDT-113 douloureuse (et casse l'affichage
  // sur mobile), on ouvre un modal propre avec dropdown des codes et
  // champ commentaire libre. Le prompt reste utilisé pour l'approbation
  // et l'encaissement qui n'exigent pas de motif.
  async function ack(row, status) {
    if (status === "refused") {
      setRefuseModal({ row });
      return;
    }
    await doAck(row, status, null);
  }

  async function doAck(row, status, reason) {
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

      {/* v8.56 — Modale refus : dropdown code motif MDT-113 + commentaire */}
      {refuseModal && (
        <RefuseModal
          row={refuseModal.row}
          onCancel={() => setRefuseModal(null)}
          onConfirm={async (reason) => {
            setRefuseModal(null);
            await doAck(refuseModal.row, "refused", reason);
          }}
        />
      )}
    </div>
  );
}

/**
 * v8.56 — Modale de refus AFNOR.
 * Codes MDT-113 courants (annexe A XP Z12-012). La liste n'est pas
 * exhaustive : l'utilisateur peut aussi taper un code libre en fallback
 * pour couvrir les cas edge non prévus.
 */
function RefuseModal({ row, onCancel, onConfirm }) {
  const CODES = [
    ["IC001", "Facture erronée"],
    ["IC003", "Destinataire incorrect"],
    ["IC005", "Montant erroné"],
    ["IC006", "TVA erronée"],
    ["IC007", "Marchandise/prestation non conforme"],
    ["IC008", "Autre motif"]
  ];
  const [code, setCode] = React.useState(CODES[0][0]);
  const [label, setLabel] = React.useState("");
  const [customCode, setCustomCode] = React.useState("");
  const [useCustom, setUseCustom] = React.useState(false);

  const finalCode = useCustom ? customCode.trim().toUpperCase() : code;
  const defaultLabelForCode = CODES.find(([c]) => c === code)?.[1] || "";
  const finalLabel = label.trim() || defaultLabelForCode;
  const canSubmit = finalCode.length > 0;

  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal modal-md" style={{ maxWidth: 520 }}>
        <div className="modal-hd">
          <div className="modal-title">❌ Refuser la facture</div>
          <button className="close-btn" onClick={onCancel} aria-label="Fermer">×</button>
        </div>
        <div className="modal-body" style={{ padding: 20 }}>
          <div style={{ fontSize: 13, marginBottom: 4 }}>
            Destinataire du refus : <strong>{row.supplier_name || "Fournisseur inconnu"}</strong>
          </div>
          {row.invoice_number && (
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 16 }}>
              Facture {row.invoice_number} · {fmtEUR(row.total_ttc_cents)} TTC
            </div>
          )}

          <div style={{ padding: "10px 12px", background: "rgba(229,73,73,0.08)",
              border: "1px solid rgba(229,73,73,0.25)", borderRadius: 8,
              fontSize: 12, color: "var(--muted)", marginBottom: 18, lineHeight: 1.5 }}>
            Un motif est obligatoire (code MDT-113, règle AFNOR BR-FR-CDV-15).
            Le refus est transmis au fournisseur et à l'administration ;
            la facture ne pourra plus être encaissée.
          </div>

          {!useCustom ? (
            <>
              <label className="form-label">Motif du refus *</label>
              <select className="form-input" value={code} onChange={(e) => setCode(e.target.value)}
                style={{ marginBottom: 12 }}>
                {CODES.map(([c, l]) => <option key={c} value={c}>{c} — {l}</option>)}
              </select>
              <div style={{ fontSize: 11, marginBottom: 14 }}>
                <a href="#" onClick={(e) => { e.preventDefault(); setUseCustom(true); }}
                  style={{ color: "var(--gold)" }}>
                  Saisir un autre code MDT-113 →
                </a>
              </div>
            </>
          ) : (
            <>
              <label className="form-label">Code MDT-113 personnalisé *</label>
              <input className="form-input" value={customCode}
                onChange={(e) => setCustomCode(e.target.value.toUpperCase())}
                placeholder="Ex : IC012, IR03, MDT-EX1"
                style={{ marginBottom: 8 }} />
              <div style={{ fontSize: 11, marginBottom: 14 }}>
                <a href="#" onClick={(e) => { e.preventDefault(); setUseCustom(false); }}
                  style={{ color: "var(--gold)" }}>
                  ← Revenir à la liste des codes standard
                </a>
                {"  ·  "}
                <span style={{ color: "var(--muted)" }}>
                  Liste complète : annexe A XP Z12-012 (AFNOR)
                </span>
              </div>
            </>
          )}

          <label className="form-label">Précision (facultatif)</label>
          <textarea className="form-input" rows={3} value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={defaultLabelForCode || "Commentaire libre transmis au fournisseur"}
            maxLength={500}
            style={{ marginBottom: 4, resize: "vertical" }} />
          <div style={{ fontSize: 10, color: "var(--muted)", textAlign: "right" }}>
            {label.length} / 500
          </div>
        </div>
        <div className="modal-foot" style={{ padding: 16, gap: 8 }}>
          <button className="btn btn-ghost" onClick={onCancel}>Annuler</button>
          <button className="btn btn-danger"
            disabled={!canSubmit}
            onClick={() => onConfirm({ code: finalCode, label: finalLabel })}
            style={{ background: canSubmit ? "var(--red, #e54949)" : undefined,
              color: canSubmit ? "#fff" : undefined,
              opacity: canSubmit ? 1 : 0.5 }}>
            ❌ Confirmer le refus
          </button>
        </div>
      </div>
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
