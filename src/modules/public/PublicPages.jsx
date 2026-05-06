import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { LogoMark } from "../../components/Logo.jsx";
import { fmtEUR, fmtDate, fmtDateLong } from "../../lib/helpers.js";
import { snapshotDisplayName } from "../../lib/snapshots.js";

export function PublicQuotePage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/public-fetch?token=${encodeURIComponent(token)}`);
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          setError(j.error || "Lien invalide ou expiré");
          setLoading(false);
          return;
        }
        const j = await r.json();
        if (j.scope !== "quote") {
          setError("Ce lien n'est pas un devis.");
          setLoading(false);
          return;
        }
        setData(j);
      } catch (e) {
        setError("Erreur réseau");
      }
      setLoading(false);
    })();
  }, [token]);

  if (loading) return <PublicShell><div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Chargement...</div></PublicShell>;
  if (error) return <PublicShell><ErrorCard message={error} /></PublicShell>;

  const { company, document: q, lines } = data;
  const cs = q.client_snapshot || {};
  const co = q.company_snapshot || company;

  return (
    <PublicShell>
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "40px 20px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <LogoMark size={48} />
            <div>
              <div style={{ fontFamily: "Syne, sans-serif", fontSize: 18, fontWeight: 800, letterSpacing: 2, color: "var(--gold)" }}>
                IO<span style={{ color: "var(--text)" }}>BILL</span>
              </div>
              <div style={{ fontSize: 9, color: "var(--muted)", letterSpacing: 1.5, textTransform: "uppercase" }}>
                Owl's Industry
              </div>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: "Syne, sans-serif", fontSize: 22, fontWeight: 700, color: "var(--text)" }}>DEVIS</div>
            <div style={{ fontFamily: "DM Mono, monospace", fontSize: 14, color: "var(--gold)" }}>{q.number}</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>
              Émis le {fmtDateLong(q.issue_date)}
            </div>
            {q.expires_at && (
              <div style={{ fontSize: 11, color: "var(--orange)", marginTop: 2 }}>
                Valable jusqu'au {fmtDateLong(q.expires_at)}
              </div>
            )}
          </div>
        </div>

        <StatusBanner status={q.status} expiresAt={q.expires_at} signedAt={q.signed_at} />

        {/* Émetteur / destinataire */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
          <PartyCard title="Émetteur" data={co} />
          <PartyCard title="Destinataire" data={cs} />
        </div>

        {/* Lignes */}
        <div className="card card-pad" style={{ marginBottom: 24 }}>
          <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 12 }}>
            Détail
          </div>
          <table>
            <thead>
              <tr>
                <th>Désignation</th>
                <th style={{ textAlign: "right" }}>Qté</th>
                <th style={{ textAlign: "right" }}>P.U. HT</th>
                <th style={{ textAlign: "right" }}>TVA</th>
                <th style={{ textAlign: "right" }}>Total HT</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.description}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{Number(l.quantity).toString().replace(/\.0+$/, "")} {l.unit}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(l.unit_price_ht_cents)}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{Number(l.vat_rate).toFixed(0)}%</td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(l.line_ht_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Totals doc={q} />
        </div>

        {/* Notes */}
        {q.notes && (
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6 }}>Notes</div>
            <div style={{ fontSize: 13, whiteSpace: "pre-wrap", color: "var(--muted2)" }}>{q.notes}</div>
          </div>
        )}
        {q.terms && (
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6 }}>Conditions de paiement</div>
            <div style={{ fontSize: 13, whiteSpace: "pre-wrap", color: "var(--muted2)" }}>{q.terms}</div>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 28, flexWrap: "wrap" }}>
          {q.pdf_url && (
            <a href={q.pdf_url} className="btn btn-ghost" target="_blank" rel="noopener noreferrer">
              📄 Télécharger en PDF
            </a>
          )}
          {q.status === "sent" && q.signature_provider && (
            <div style={{ background: "var(--card2)", padding: "12px 18px", borderRadius: 8, fontSize: 13, color: "var(--muted2)", textAlign: "center" }}>
              Vous avez reçu un email avec le lien de signature {q.signature_provider === "yousign" ? "Yousign" : ""}.
            </div>
          )}
        </div>

        <div style={{ marginTop: 50, textAlign: "center", fontSize: 10, color: "var(--muted)", letterSpacing: 1.5, textTransform: "uppercase" }}>
          Document généré par IO BILL · Owl's Industry
        </div>
      </div>
    </PublicShell>
  );
}

// ──────────────────────────────────────────────────────────────
//  PUBLIC INVOICE PAGE
// ──────────────────────────────────────────────────────────────
export function PublicInvoicePage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/public-fetch?token=${encodeURIComponent(token)}`);
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          setError(j.error || "Lien invalide ou expiré");
          setLoading(false);
          return;
        }
        const j = await r.json();
        if (j.scope !== "invoice") { setError("Ce lien n'est pas une facture."); setLoading(false); return; }
        setData(j);
      } catch (e) { setError("Erreur réseau"); }
      setLoading(false);
    })();
  }, [token]);

  if (loading) return <PublicShell><div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Chargement...</div></PublicShell>;
  if (error) return <PublicShell><ErrorCard message={error} /></PublicShell>;

  const { company, document: inv, lines } = data;
  const cs = inv.client_snapshot || {};
  const co = inv.company_snapshot || company;
  const remaining = (inv.total_ttc_cents || 0) - (inv.paid_cents || 0);

  return (
    <PublicShell>
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "40px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <LogoMark size={48} />
            <div>
              <div style={{ fontFamily: "Syne, sans-serif", fontSize: 18, fontWeight: 800, letterSpacing: 2, color: "var(--gold)" }}>
                IO<span style={{ color: "var(--text)" }}>BILL</span>
              </div>
              <div style={{ fontSize: 9, color: "var(--muted)", letterSpacing: 1.5, textTransform: "uppercase" }}>Owl's Industry</div>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: "Syne, sans-serif", fontSize: 22, fontWeight: 700, color: "var(--text)" }}>FACTURE</div>
            <div style={{ fontFamily: "DM Mono, monospace", fontSize: 14, color: "var(--gold)" }}>{inv.number}</div>
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>Émise le {fmtDateLong(inv.issue_date)}</div>
            {inv.due_date && <div style={{ fontSize: 11, color: "var(--orange)", marginTop: 2 }}>Échéance : {fmtDateLong(inv.due_date)}</div>}
          </div>
        </div>

        <StatusBanner status={inv.status} dueDate={inv.due_date} />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
          <PartyCard title="Émetteur" data={co} />
          <PartyCard title="Destinataire" data={cs} />
        </div>

        <div className="card card-pad" style={{ marginBottom: 24 }}>
          <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 12 }}>Détail</div>
          <table>
            <thead>
              <tr>
                <th>Désignation</th>
                <th style={{ textAlign: "right" }}>Qté</th>
                <th style={{ textAlign: "right" }}>P.U. HT</th>
                <th style={{ textAlign: "right" }}>TVA</th>
                <th style={{ textAlign: "right" }}>Total HT</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.description}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{Number(l.quantity).toString().replace(/\.0+$/, "")} {l.unit}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(l.unit_price_ht_cents)}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{Number(l.vat_rate).toFixed(0)}%</td>
                  <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(l.line_ht_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Totals doc={inv} showPaid />
        </div>

        {/* Boutons paiement / téléchargement */}
        <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 28, flexWrap: "wrap" }}>
          {remaining > 0 && inv.stripe_payment_link_url && (
            <a href={inv.stripe_payment_link_url} className="btn btn-primary" style={{ fontSize: 14 }}>
              💳 Régler {fmtEUR(remaining)} en ligne
            </a>
          )}
          {(inv.facturx_pdf_url || inv.pdf_url) && (
            <a href={inv.facturx_pdf_url || inv.pdf_url} className="btn btn-ghost" target="_blank" rel="noopener noreferrer">
              📄 Télécharger Factur-X
            </a>
          )}
        </div>

        <div style={{ marginTop: 50, textAlign: "center", fontSize: 10, color: "var(--muted)", letterSpacing: 1.5, textTransform: "uppercase" }}>
          Document généré par IO BILL · Owl's Industry
        </div>
      </div>
    </PublicShell>
  );
}

// ──────────────────────────────────────────────────────────────
//  CLIENT PORTAL
// ──────────────────────────────────────────────────────────────
export function PublicPortalPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/public-fetch?token=${encodeURIComponent(token)}`);
        if (!r.ok) { const j = await r.json().catch(() => ({})); setError(j.error || "Lien invalide"); setLoading(false); return; }
        const j = await r.json();
        if (j.scope !== "portal") { setError("Ce lien n'est pas un portail client."); setLoading(false); return; }
        setData(j);
      } catch (e) { setError("Erreur réseau"); }
      setLoading(false);
    })();
  }, [token]);

  if (loading) return <PublicShell><div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Chargement...</div></PublicShell>;
  if (error) return <PublicShell><ErrorCard message={error} /></PublicShell>;

  const { company, client, invoices, quotes } = data;
  const clientName = client.client_type === "individual"
    ? `${client.first_name || ""} ${client.last_name || ""}`.trim()
    : client.legal_name;

  const totalUnpaid = (invoices || [])
    .filter((i) => ["issued", "sent", "partial", "overdue"].includes(i.status))
    .reduce((s, i) => s + ((i.total_ttc_cents || 0) - (i.paid_cents || 0)), 0);

  return (
    <PublicShell>
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "40px 20px" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <LogoMark size={44} />
            <div>
              <div style={{ fontFamily: "Syne, sans-serif", fontSize: 16, fontWeight: 800, letterSpacing: 2, color: "var(--gold)" }}>
                IO<span style={{ color: "var(--text)" }}>BILL</span>
              </div>
              <div style={{ fontSize: 10, color: "var(--muted)" }}>Espace client de {company.legal_name}</div>
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: "Syne, sans-serif", fontSize: 18, fontWeight: 700 }}>{clientName}</div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>Bonjour, voici vos documents</div>
          </div>
        </div>

        {/* KPI */}
        <div className="kpi-grid" style={{ marginBottom: 26 }}>
          <div className="kpi">
            <div className="kpi-label">À régler</div>
            <div className={"kpi-val " + (totalUnpaid > 0 ? "orange" : "green")}>
              {totalUnpaid > 0 ? fmtEUR(totalUnpaid) : "✓ À jour"}
            </div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Factures</div>
            <div className="kpi-val">{invoices.length}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Devis</div>
            <div className="kpi-val">{quotes.length}</div>
          </div>
        </div>

        {/* Factures */}
        <div className="card card-pad" style={{ marginBottom: 18 }}>
          <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 12 }}>
            Factures
          </div>
          {invoices.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--muted)", padding: 12 }}>Aucune facture pour l'instant.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>N°</th>
                  <th>Émise le</th>
                  <th>Échéance</th>
                  <th style={{ textAlign: "right" }}>Montant TTC</th>
                  <th>Statut</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => {
                  const remaining = (inv.total_ttc_cents || 0) - (inv.paid_cents || 0);
                  return (
                    <tr key={inv.id}>
                      <td className="mono">{inv.number}</td>
                      <td>{fmtDate(inv.issue_date)}</td>
                      <td>{fmtDate(inv.due_date)}</td>
                      <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(inv.total_ttc_cents)}</td>
                      <td><InvoiceStatusBadge status={inv.status} /></td>
                      <td style={{ textAlign: "right" }}>
                        {remaining > 0 && inv.stripe_payment_link_url && (
                          <a href={inv.stripe_payment_link_url} className="btn btn-primary btn-xs">
                            Payer {fmtEUR(remaining)}
                          </a>
                        )}
                        {(inv.facturx_pdf_url || inv.pdf_url) && (
                          <a href={inv.facturx_pdf_url || inv.pdf_url} className="btn btn-ghost btn-xs" target="_blank" rel="noopener noreferrer" style={{ marginLeft: 6 }}>
                            📄
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Devis */}
        {quotes.length > 0 && (
          <div className="card card-pad">
            <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 12 }}>
              Devis
            </div>
            <table>
              <thead>
                <tr>
                  <th>N°</th>
                  <th>Date</th>
                  <th>Validité</th>
                  <th style={{ textAlign: "right" }}>Montant</th>
                  <th>Statut</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {quotes.map((q) => (
                  <tr key={q.id}>
                    <td className="mono">{q.number}</td>
                    <td>{fmtDate(q.issue_date)}</td>
                    <td>{fmtDate(q.expires_at)}</td>
                    <td className="mono" style={{ textAlign: "right" }}>{fmtEUR(q.total_ttc_cents)}</td>
                    <td><QuoteStatusBadge status={q.status} /></td>
                    <td style={{ textAlign: "right" }}>
                      {q.pdf_url && (
                        <a href={q.pdf_url} className="btn btn-ghost btn-xs" target="_blank" rel="noopener noreferrer">📄</a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ marginTop: 40, textAlign: "center", fontSize: 11, color: "var(--muted)", lineHeight: 1.7 }}>
          Pour toute question, contactez {company.email || company.legal_name}<br />
          <span style={{ fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--muted)" }}>Propulsé par IO BILL · Owl's Industry</span>
        </div>
      </div>
    </PublicShell>
  );
}

// ──────────────────────────────────────────────────────────────
//  Composants partages
// ──────────────────────────────────────────────────────────────
function PublicShell({ children }) {
  return <div style={{ minHeight: "100vh", background: "var(--bg)", color: "var(--text)" }}>{children}</div>;
}

function ErrorCard({ message }) {
  return (
    <div style={{ maxWidth: 460, margin: "120px auto", padding: 30, textAlign: "center" }}>
      <div style={{ fontSize: 50, marginBottom: 16 }}>🔒</div>
      <div style={{ fontFamily: "Syne, sans-serif", fontSize: 18, fontWeight: 700, marginBottom: 10 }}>Lien inaccessible</div>
      <div style={{ fontSize: 13, color: "var(--muted2)" }}>{message}</div>
      <div style={{ marginTop: 20, fontSize: 11, color: "var(--muted)" }}>
        Demandez à votre interlocuteur un nouveau lien.
      </div>
    </div>
  );
}

function StatusBanner({ status, dueDate, expiresAt, signedAt }) {
  let bg, color, label;
  if (status === "signed") { bg = "rgba(62, 207, 122, 0.1)"; color = "var(--green)"; label = `✓ Devis signé${signedAt ? " le " + fmtDate(signedAt) : ""}`; }
  else if (status === "paid") { bg = "rgba(62, 207, 122, 0.1)"; color = "var(--green)"; label = "✓ Facture réglée"; }
  else if (status === "sent") { bg = "rgba(212, 168, 67, 0.1)"; color = "var(--gold)"; label = "📤 En attente de votre validation"; }
  else if (status === "issued") { bg = "rgba(212, 168, 67, 0.1)"; color = "var(--gold)"; label = "📩 Facture émise"; }
  else if (status === "partial") { bg = "rgba(229, 151, 60, 0.1)"; color = "var(--orange)"; label = "Paiement partiel reçu"; }
  else if (status === "overdue") { bg = "rgba(229, 92, 92, 0.1)"; color = "var(--red)"; label = "⚠️ En retard de paiement"; }
  else if (status === "refused") { bg = "rgba(229, 92, 92, 0.1)"; color = "var(--red)"; label = "Devis refusé"; }
  else if (status === "expired") { bg = "rgba(107, 106, 122, 0.1)"; color = "var(--muted2)"; label = "Devis expiré"; }
  else return null;

  return (
    <div style={{ background: bg, color, padding: "12px 18px", borderRadius: 8, marginBottom: 24, fontSize: 13, fontWeight: 500, textAlign: "center", border: `1px solid ${color}30` }}>
      {label}
    </div>
  );
}

function PartyCard({ title, data }) {
  const name = data?.legal_name || `${data?.first_name || ""} ${data?.last_name || ""}`.trim() || "—";
  return (
    <div className="card card-pad">
      <div style={{ fontSize: 10, color: "var(--muted)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 8 }}>{title}</div>
      <div style={{ fontFamily: "Syne, sans-serif", fontSize: 15, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{name}</div>
      <div style={{ fontSize: 12, color: "var(--muted2)", lineHeight: 1.7 }}>
        {data?.contact_person && <>{data.contact_person}<br /></>}
        {data?.address_line1 && <>{data.address_line1}<br /></>}
        {data?.address_line2 && <>{data.address_line2}<br /></>}
        {(data?.postal_code || data?.city) && <>{data.postal_code} {data.city}<br /></>}
        {data?.country && <>{data.country}<br /></>}
        {data?.email && <span style={{ color: "var(--muted)" }}>{data.email}<br /></span>}
        {data?.siret && <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>SIRET {data.siret}<br /></span>}
        {data?.vat_number && <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>TVA {data.vat_number}</span>}
      </div>
    </div>
  );
}

function Totals({ doc, showPaid }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 320, marginLeft: "auto", marginTop: 18, paddingTop: 14, borderTop: "1px dashed var(--border)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", color: "var(--muted2)", fontSize: 13 }}>
        <span>Total HT</span><span className="mono">{fmtEUR(doc.subtotal_ht_cents)}</span>
      </div>
      {(doc.vat_breakdown || []).map((v) => (
        <div key={v.rate} style={{ display: "flex", justifyContent: "space-between", color: "var(--muted2)", fontSize: 12 }}>
          <span>TVA {v.rate}%</span><span className="mono">{fmtEUR(v.vat_cents)}</span>
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "space-between", color: "var(--gold)", fontFamily: "Syne, sans-serif", fontWeight: 700, fontSize: 18, paddingTop: 6, borderTop: "1px solid var(--border)", marginTop: 4 }}>
        <span>Total TTC</span><span>{fmtEUR(doc.total_ttc_cents)}</span>
      </div>
      {showPaid && (doc.paid_cents || 0) > 0 && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", color: "var(--green)", fontSize: 13 }}>
            <span>Déjà encaissé</span><span className="mono">− {fmtEUR(doc.paid_cents)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "Syne, sans-serif", fontWeight: 700, fontSize: 14, color: "var(--text)" }}>
            <span>Reste à régler</span><span>{fmtEUR(doc.total_ttc_cents - doc.paid_cents)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function InvoiceStatusBadge({ status }) {
  const m = {
    draft: ["badge-muted", "Brouillon"], issued: ["badge-gold", "Émise"], sent: ["badge-gold", "Envoyée"],
    partial: ["badge-orange", "Partielle"], paid: ["badge-green", "Payée"],
    overdue: ["badge-red", "En retard"], canceled: ["badge-muted", "Annulée"]
  }[status] || ["badge-muted", status];
  return <span className={"badge " + m[0]}>{m[1]}</span>;
}
function QuoteStatusBadge({ status }) {
  const m = {
    draft: ["badge-muted", "Brouillon"], sent: ["badge-gold", "Envoyé"], signed: ["badge-green", "Signé"],
    refused: ["badge-red", "Refusé"], expired: ["badge-muted", "Expiré"], converted: ["badge-green", "Converti"]
  }[status] || ["badge-muted", status];
  return <span className={"badge " + m[0]}>{m[1]}</span>;
}
