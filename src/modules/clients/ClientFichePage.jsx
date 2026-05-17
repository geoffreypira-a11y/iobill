import React, { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtEUR, fmtDate, fmtDateLong, initials, isEmail } from "../../lib/helpers.js";
import { CLIENT_STATUTS, PAYMENT_SCORES } from "./constants.js";
import { ClientModal } from "./ClientModal.jsx";

export function ClientFichePage({ token, company }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [client, setClient] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [quotes, setQuotes] = useState([]);
  const [payments, setPayments] = useState([]);
  const [interactions, setInteractions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [newNote, setNewNote] = useState("");
  const [vies, setVies] = useState({ checking: false, msg: "" });

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const [c, invs, qts, pays, ints] = await Promise.all([
        sb.selectOne(token, "clients", `id=eq.${id}`),
        sb.select(token, "invoices", { filter: `company_id=eq.${company.id}&client_id=eq.${id}`, order: "issue_date.desc" }),
        sb.select(token, "quotes", { filter: `company_id=eq.${company.id}&client_id=eq.${id}`, order: "issue_date.desc" }),
        sb.select(token, "payments", { filter: `company_id=eq.${company.id}`, order: "paid_at.desc", limit: 50 }),
        sb.select(token, "client_interactions", { filter: `client_id=eq.${id}`, order: "created_at.desc", limit: 50 })
      ]);
      if (!alive) return;
      setClient(c);
      setInvoices(invs || []);
      setQuotes(qts || []);
      // Filtre les paiements liés aux factures de ce client
      const myInvIds = new Set((invs || []).map((i) => i.id));
      setPayments((pays || []).filter((p) => myInvIds.has(p.invoice_id)));
      setInteractions(ints || []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, id, company.id]);

  if (loading) {
    return <div className="page"><div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Chargement...</div></div>;
  }
  if (!client) {
    return <div className="page"><div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Client introuvable.</div></div>;
  }

  // ─── Calculs ────────────────────────────────────────────
  const totalCAHT = invoices
    .filter((i) => ["issued", "sent", "partial", "paid", "overdue"].includes(i.status))
    .reduce((s, i) => s + (i.subtotal_ht_cents || 0), 0);
  const unpaidCents = invoices
    .filter((i) => ["issued", "sent", "partial", "overdue"].includes(i.status))
    .reduce((s, i) => s + ((i.total_ttc_cents || 0) - (i.paid_cents || 0)), 0);
  const overdueCount = invoices.filter((i) => i.status === "overdue" || (["issued","sent","partial"].includes(i.status) && i.due_date && new Date(i.due_date) < new Date())).length;

  // DSO client (délai moyen)
  const paidWithDelay = invoices.filter((i) => i.status === "paid" && i.issue_date);
  let dsoDays = null;
  if (paidWithDelay.length > 0) {
    const matched = paidWithDelay.map((i) => {
      const pay = payments.find((p) => p.invoice_id === i.id);
      if (!pay) return null;
      return Math.round((new Date(pay.paid_at) - new Date(i.issue_date)) / 86400000);
    }).filter((d) => d !== null);
    if (matched.length > 0) {
      dsoDays = Math.round(matched.reduce((a, b) => a + b, 0) / matched.length);
    }
  }

  const statusInfo = CLIENT_STATUTS[client.status] || CLIENT_STATUTS.prospect;
  const score = PAYMENT_SCORES[client.payment_score || "normal"];
  const name = displayName(client);

  // Vérification VIES (TVA intracom UE) — appel API serveur (à câbler)
  async function checkVies() {
    if (!client.vat_number) return;
    setVies({ checking: true, msg: "" });
    try {
      const r = await fetch("/api/vies-check", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ vat_number: client.vat_number })
      });
      const j = await r.json();
      const valid = !!j?.valid;
      await sb.update(token, "clients", `id=eq.${client.id}`, {
        vat_validated_at: new Date().toISOString(),
        vat_valid: valid
      });
      setClient((c) => ({ ...c, vat_validated_at: new Date().toISOString(), vat_valid: valid }));
      setVies({ checking: false, msg: valid ? "✓ Numéro TVA valide" : "✗ Numéro TVA invalide" });
    } catch {
      setVies({ checking: false, msg: "Vérification impossible (API non câblée)" });
    }
  }

  async function addNote() {
    if (!newNote.trim()) return;
    const inserted = await sb.insert(token, "client_interactions", {
      company_id: company.id,
      client_id: client.id,
      type: "note",
      content: newNote.trim()
    });
    if (inserted && inserted[0]) {
      setInteractions((arr) => [inserted[0], ...arr]);
      setNewNote("");
    }
  }

  async function deleteNote(noteId) {
    const ok = await sb.delete(token, "client_interactions", `id=eq.${noteId}`);
    if (ok) setInteractions((arr) => arr.filter((n) => n.id !== noteId));
  }

  return (
    <div className="page">
      <div style={{ marginBottom: 18 }}>
        <Link to="/clients" style={{ fontSize: 12, color: "var(--gold)", textDecoration: "none" }}>
          ← Retour CRM
        </Link>
      </div>

      {/* Header fiche */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 18, flexWrap: "wrap" }}>
          <div className="avatar" style={{ width: 56, height: 56, fontSize: 18 }}>
            {initials(name)}
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 5 }}>
              <div style={{ fontFamily: "Syne, sans-serif", fontSize: 22, fontWeight: 700, color: "var(--text)", letterSpacing: 0.5 }}>
                {name}
              </div>
              <span className={"badge " + statusInfo.cls}>{statusInfo.icon} {statusInfo.label}</span>
              <span className={"badge " + score.cls}>{score.icon} Paiement {score.label.toLowerCase()}</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--muted2)" }}>
              {client.contact_person && <span>👤 {client.contact_person} · </span>}
              {client.email && <span>✉️ {client.email} · </span>}
              {client.phone && <span>☎️ {client.phone}</span>}
            </div>
            {(client.siret || client.vat_number) && (
              <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }} className="mono">
                {client.siret && <span>SIRET : {client.siret}</span>}
                {client.siret && client.vat_number && <span> · </span>}
                {client.vat_number && (
                  <span>
                    TVA : {client.vat_number}
                    {client.vat_validated_at && (
                      <span style={{ color: client.vat_valid ? "var(--green)" : "var(--red)", marginLeft: 6 }}>
                        {client.vat_valid ? "✓ Validé" : "✗ Invalide"}
                      </span>
                    )}
                  </span>
                )}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {client.vat_number && (
              <button className="btn btn-ghost btn-sm" onClick={checkVies} disabled={vies.checking}>
                {vies.checking ? "Vérification..." : "Vérifier TVA (VIES)"}
              </button>
            )}
            <button className="btn btn-primary btn-sm" onClick={() => setEditing(true)}>
              <Icon name="edit" size={12} /> Modifier
            </button>
            <button className="btn btn-ghost btn-sm" onClick={async () => {
              try {
                const r = await fetch("/api/public?op=share", {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                  body: JSON.stringify({ scope: "portal", resource_id: client.id, expires_in_days: 365 })
                });
                if (!r.ok) { alert("Erreur lors de la génération du lien"); return; }
                const j = await r.json();
                if (j.public_url) {
                  try { await navigator.clipboard.writeText(j.public_url); } catch {}
                  alert("Lien espace client copié :\n\n" + j.public_url);
                }
              } catch { alert("Erreur réseau"); }
            }}>
              🔗 Espace client
            </button>
          </div>
        </div>
        {vies.msg && (
          <div style={{ marginTop: 10, fontSize: 12, color: vies.msg.startsWith("✓") ? "var(--green)" : "var(--orange)" }}>
            {vies.msg}
          </div>
        )}
      </div>

      {/* KPI fiche */}
      <div className="kpi-grid">
        <div className="kpi">
          <div className="kpi-label">CA HT total</div>
          <div className="kpi-val gold">{fmtEUR(totalCAHT)}</div>
          <div className="kpi-foot">{invoices.length} facture{invoices.length > 1 ? "s" : ""}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Encours</div>
          <div className={"kpi-val " + (unpaidCents > 0 ? "orange" : "")}>{fmtEUR(unpaidCents)}</div>
          <div className="kpi-foot">
            {overdueCount > 0 ? <span style={{ color: "var(--red)" }}>{overdueCount} en retard</span> : "À jour"}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">DSO client</div>
          <div className={"kpi-val " + (dsoDays === null ? "" : dsoDays > 30 ? "orange" : "green")}>
            {dsoDays === null ? "—" : `${dsoDays} j`}
          </div>
          <div className="kpi-foot">
            {dsoDays === null ? "Pas encore de paiement" : `Délai paiement (${client.payment_terms_days || 30} j prévus)`}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Devis envoyés</div>
          <div className="kpi-val">{quotes.length}</div>
          <div className="kpi-foot">
            {quotes.filter((q) => q.status === "signed").length} signé(s)
          </div>
        </div>
      </div>

      {/* Adresse + Notes en grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <div className="card card-pad">
          <SectionTitle>Coordonnées</SectionTitle>
          {client.address_line1 ? (
            <div style={{ fontSize: 13, lineHeight: 1.6 }}>
              <div>{client.address_line1}</div>
              {client.address_line2 && <div>{client.address_line2}</div>}
              <div>{client.postal_code} {client.city}</div>
              <div style={{ color: "var(--muted)" }}>{client.country}</div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>Aucune adresse renseignée.</div>
          )}
          {client.tags && client.tags.length > 0 && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border2)" }}>
              <div style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6 }}>
                Tags
              </div>
              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                {client.tags.map((t) => (
                  <span key={t} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, background: "var(--card2)", color: "var(--muted2)" }}>{t}</span>
                ))}
              </div>
            </div>
          )}
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border2)" }}>
            <div style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6 }}>
              Conditions commerciales
            </div>
            <div style={{ fontSize: 12, color: "var(--muted2)", lineHeight: 1.7 }}>
              Délai paiement : <span className="mono">{client.payment_terms_days || 30} jours</span><br />
              Remise : <span className="mono">{client.discount_pct || 0}%</span>
              {client.default_vat_rate ? <><br />TVA par défaut : <span className="mono">{client.default_vat_rate}%</span></> : null}
            </div>
          </div>
        </div>

        <div className="card card-pad">
          <SectionTitle>Notes & relances</SectionTitle>
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <input
              className="form-input"
              placeholder="Ajouter une note..."
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addNote()}
            />
            <button className="btn btn-primary btn-sm" onClick={addNote}>+</button>
          </div>
          {interactions.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>Aucune note pour l'instant.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 240, overflowY: "auto" }}>
              {interactions.map((n) => (
                <div key={n.id} style={{ background: "var(--card2)", padding: "8px 11px", borderRadius: 6, fontSize: 12.5 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <div style={{ color: "var(--text)", lineHeight: 1.5, flex: 1 }}>{n.content}</div>
                    <button
                      onClick={() => deleteNote(n.id)}
                      style={{ background: "none", border: "none", color: "var(--muted)", cursor: "pointer", padding: 0, fontSize: 14 }}
                    >×</button>
                  </div>
                  <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>
                    {fmtDateLong(n.created_at)}
                  </div>
                </div>
              ))}
            </div>
          )}
          {client.notes && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border2)" }}>
              <div style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6 }}>
                Description fiche
              </div>
              <div style={{ fontSize: 12, color: "var(--muted2)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                {client.notes}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Historique factures */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <SectionTitle>Factures ({invoices.length})</SectionTitle>
        {invoices.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--muted)", padding: "12px 0" }}>
            Aucune facture. <Link to="/quotes?new=1" style={{ color: "var(--gold)" }}>Créer un devis →</Link>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>N°</th>
                <th>Date</th>
                <th>Échéance</th>
                <th style={{ textAlign: "right" }}>Montant TTC</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} onClick={() => navigate(`/invoices/${inv.id}`)} style={{ cursor: "pointer" }}>
                  <td className="mono">{inv.number}</td>
                  <td>{fmtDate(inv.issue_date)}</td>
                  <td>{fmtDate(inv.due_date)}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(inv.total_ttc_cents)}</td>
                  <td><InvoiceStatusBadge status={inv.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Historique devis */}
      {quotes.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <SectionTitle>Devis ({quotes.length})</SectionTitle>
          <table>
            <thead>
              <tr>
                <th>N°</th>
                <th>Date</th>
                <th>Validité</th>
                <th style={{ textAlign: "right" }}>Montant TTC</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((q) => (
                <tr key={q.id} onClick={() => navigate(`/quotes/${q.id}`)} style={{ cursor: "pointer" }}>
                  <td className="mono">{q.number}</td>
                  <td>{fmtDate(q.issue_date)}</td>
                  <td>{fmtDate(q.expires_at)}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(q.total_ttc_cents)}</td>
                  <td><QuoteStatusBadge status={q.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Historique paiements */}
      {payments.length > 0 && (
        <div className="card card-pad">
          <SectionTitle>Paiements reçus ({payments.length})</SectionTitle>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Facture</th>
                <th>Méthode</th>
                <th>Référence</th>
                <th style={{ textAlign: "right" }}>Montant</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => {
                const inv = invoices.find((i) => i.id === p.invoice_id);
                return (
                  <tr key={p.id}>
                    <td>{fmtDate(p.paid_at)}</td>
                    <td className="mono">{inv?.number || "—"}</td>
                    <td>{p.method || "—"}</td>
                    <td className="mono" style={{ fontSize: 11 }}>{p.reference || "—"}</td>
                    <td className="mono" style={{ textAlign: "right", color: "var(--green)" }}>{fmtEUR(p.amount_cents)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ClientModal
          token={token}
          company={company}
          client={client}
          onSave={(c) => { setClient(c); setEditing(false); }}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

function SectionTitle({ children }) {
  return (
    <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 12, color: "var(--text)" }}>
      {children}
    </div>
  );
}

function InvoiceStatusBadge({ status }) {
  const map = {
    draft: { cls: "badge-muted", label: "Brouillon" },
    issued: { cls: "badge-gold", label: "Émise" },
    sent: { cls: "badge-gold", label: "Envoyée" },
    partial: { cls: "badge-orange", label: "Partielle" },
    paid: { cls: "badge-green", label: "Payée" },
    overdue: { cls: "badge-red", label: "En retard" },
    canceled: { cls: "badge-muted", label: "Annulée" }
  };
  const s = map[status] || { cls: "badge-muted", label: status };
  return <span className={"badge " + s.cls}>{s.label}</span>;
}

function QuoteStatusBadge({ status }) {
  const map = {
    draft: { cls: "badge-muted", label: "Brouillon" },
    sent: { cls: "badge-gold", label: "Envoyé" },
    signed: { cls: "badge-green", label: "Signé" },
    refused: { cls: "badge-red", label: "Refusé" },
    expired: { cls: "badge-muted", label: "Expiré" },
    converted: { cls: "badge-green", label: "Converti" }
  };
  const s = map[status] || { cls: "badge-muted", label: status };
  return <span className={"badge " + s.cls}>{s.label}</span>;
}

function displayName(c) {
  if (c.client_type === "individual") {
    return [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "Client";
  }
  return c.legal_name || "Client";
}
