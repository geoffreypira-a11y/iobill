import React, { useEffect, useState } from "react";
import { parseEInvoiceXml, eur, num, dateFr } from "../lib/e-invoice-xml.js";

/**
 * EInvoiceXmlPreview — v8.108
 *
 * Une facture reçue par la Plateforme Agréée n'est pas toujours un PDF.
 * Quand le fournisseur émet en Peppol (cas d'OVH), la PA ne détient qu'un
 * XML : CII (UN/CEFACT, le socle de Factur-X) ou UBL. Jusqu'ici la modale
 * d'aperçu poussait ce XML dans une <iframe>, qui affichait donc la
 * première ligne du source — illisible.
 *
 * Ce composant rend la facture lisible : vendeur, acheteur, lignes,
 * ventilation de TVA, totaux, règlement. Le XML brut reste accessible
 * d'un clic, il fait foi.
 */

/* ─── Rendu ─── */
const cardSt = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 14
};
const labelSt = { fontSize: 10, textTransform: "uppercase", letterSpacing: 0.6, color: "var(--muted)" };
const thSt = {
  textAlign: "left", fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5,
  color: "var(--muted)", padding: "6px 8px", borderBottom: "1px solid var(--border)"
};
const tdSt = { padding: "8px", fontSize: 12, borderBottom: "1px solid var(--border)", verticalAlign: "top" };

function Party({ title, p }) {
  if (!p) return null;
  return (
    <div style={cardSt}>
      <div style={labelSt}>{title}</div>
      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>{p.name || "—"}</div>
      {p.lines.map((l, i) => (
        <div key={i} style={{ fontSize: 11, color: "var(--muted)" }}>{l}</div>
      ))}
      {p.vat && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>TVA {p.vat}</div>}
    </div>
  );
}

export function EInvoiceXmlPreview({ url, downloadHref }) {
  const [state, setState] = useState({ status: "loading" });
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    (async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`Téléchargement impossible (${r.status})`);
        const text = await r.text();
        if (!alive) return;
        try {
          setState({ status: "ok", inv: parseEInvoiceXml(text), text });
        } catch (e) {
          setState({ status: "unparsed", error: e.message, text });
        }
      } catch (e) {
        if (alive) setState({ status: "error", error: e.message });
      }
    })();
    return () => { alive = false; };
  }, [url]);

  if (state.status === "loading") {
    return <div style={{ padding: 24, fontSize: 12, color: "var(--muted)" }}>Lecture du fichier…</div>;
  }
  if (state.status === "error") {
    return (
      <div style={{ padding: 24, fontSize: 12, color: "var(--red)" }}>
        {state.error}
        {downloadHref && (
          <> — <a href={downloadHref} target="_blank" rel="noopener noreferrer">télécharger le fichier</a></>
        )}
      </div>
    );
  }

  const showRaw = raw || state.status === "unparsed";
  const inv = state.inv;

  return (
    <div style={{ height: "100%", overflow: "auto", padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{
          fontSize: 10, padding: "3px 8px", borderRadius: 999,
          background: "var(--card2)", color: "var(--muted)", border: "1px solid var(--border)"
        }}>
          {state.status === "unparsed" ? "XML non reconnu" : inv.flavour}
        </span>
        <span style={{ fontSize: 11, color: "var(--muted)" }}>
          Facture électronique reçue au format XML — rendu lisible par IO BILL.
        </span>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setRaw((v) => !v)}
          disabled={state.status === "unparsed"}
          style={{ marginLeft: "auto", fontSize: 11, padding: "4px 10px" }}
        >
          {showRaw ? "◧ Vue facture" : "◧ XML brut"}
        </button>
      </div>

      {state.status === "unparsed" && (
        <div style={{ ...cardSt, marginBottom: 14, borderColor: "var(--red)", color: "var(--red)", fontSize: 12 }}>
          {state.error} — le source est affiché tel quel.
        </div>
      )}

      {showRaw ? (
        <pre style={{
          fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word",
          background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, padding: 14, margin: 0
        }}>
          {state.text}
        </pre>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <Party title="Vendeur" p={inv.seller} />
            <Party title="Acheteur" p={inv.buyer} />
            <div style={cardSt}>
              <div style={labelSt}>Document</div>
              <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>{inv.number || "—"}</div>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>
                Émise le {dateFr(inv.issueDate) || "—"}
              </div>
              {inv.dueDate && (
                <div style={{ fontSize: 11, color: "var(--muted)" }}>Échéance {dateFr(inv.dueDate)}</div>
              )}
              {inv.orderRef && (
                <div style={{ fontSize: 11, color: "var(--muted)" }}>Commande {inv.orderRef}</div>
              )}
              {inv.reference && (
                <div style={{ fontSize: 11, color: "var(--muted)" }}>Référence {inv.reference}</div>
              )}
            </div>
          </div>

          {inv.lines.length > 0 && (
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16 }}>
              <thead>
                <tr>
                  <th style={thSt}>Désignation</th>
                  <th style={{ ...thSt, textAlign: "right" }}>Qté</th>
                  <th style={{ ...thSt, textAlign: "right" }}>PU HT</th>
                  <th style={{ ...thSt, textAlign: "right" }}>TVA</th>
                  <th style={{ ...thSt, textAlign: "right" }}>Total HT</th>
                </tr>
              </thead>
              <tbody>
                {inv.lines.map((l, i) => (
                  <tr key={i}>
                    <td style={tdSt}>
                      <div>{l.label || "—"}</div>
                      {l.description && (
                        <div style={{ fontSize: 11, color: "var(--muted)", whiteSpace: "pre-wrap" }}>
                          {l.description}
                        </div>
                      )}
                    </td>
                    <td style={{ ...tdSt, textAlign: "right" }} className="mono">
                      {num(l.qty)}{l.unit && l.unit !== "C62" ? ` ${l.unit}` : ""}
                    </td>
                    <td style={{ ...tdSt, textAlign: "right" }} className="mono">
                      {l.unitPrice ? eur(l.unitPrice, inv.currency) : "—"}
                    </td>
                    <td style={{ ...tdSt, textAlign: "right" }} className="mono">
                      {l.vatRate ? `${num(l.vatRate)} %` : "—"}
                    </td>
                    <td style={{ ...tdSt, textAlign: "right" }} className="mono">
                      {l.total ? eur(l.total, inv.currency) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div style={{
            display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 12, marginTop: 16
          }}>
            {inv.taxes.length > 0 && (
              <div style={cardSt}>
                <div style={{ ...labelSt, marginBottom: 6 }}>Ventilation de TVA</div>
                {inv.taxes.map((t, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0" }}>
                    <span style={{ color: "var(--muted)" }}>
                      {t.rate ? `${num(t.rate)} %` : t.category || "—"}
                      {t.base ? ` sur ${eur(t.base, inv.currency)}` : ""}
                    </span>
                    <span className="mono">{t.amount ? eur(t.amount, inv.currency) : "—"}</span>
                  </div>
                ))}
                {inv.taxes.map((t, i) => t.exemption && (
                  <div key={`ex${i}`} style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                    {t.exemption}
                  </div>
                ))}
              </div>
            )}

            <div style={cardSt}>
              <div style={{ ...labelSt, marginBottom: 6 }}>Totaux</div>
              {[
                ["Total HT", inv.totals.ht || inv.totals.base],
                ["Base TVA", inv.totals.base],
                ["TVA", inv.totals.vat],
                ["Total TTC", inv.totals.ttc],
                ["Déjà réglé", inv.totals.paid],
                ["Net à payer", inv.totals.due]
              ].filter(([, v]) => v !== "" && v != null).map(([k, v], i) => (
                <div key={i} style={{
                  display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0",
                  fontWeight: k === "Net à payer" ? 700 : 400,
                  color: k === "Net à payer" ? "var(--gold)" : undefined
                }}>
                  <span style={{ color: k === "Net à payer" ? "var(--gold)" : "var(--muted)" }}>{k}</span>
                  <span className="mono">{eur(v, inv.currency)}</span>
                </div>
              ))}
            </div>

            {(inv.accounts.length > 0 || inv.paymentTerms) && (
              <div style={cardSt}>
                <div style={{ ...labelSt, marginBottom: 6 }}>Règlement</div>
                {inv.accounts.map((a, i) => (
                  <div key={i} className="mono" style={{ fontSize: 12 }}>{a}</div>
                ))}
                {inv.paymentTerms && (
                  <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4, whiteSpace: "pre-wrap" }}>
                    {inv.paymentTerms}
                  </div>
                )}
              </div>
            )}
          </div>

          {inv.notes.length > 0 && (
            <div style={{ ...cardSt, marginTop: 12 }}>
              <div style={{ ...labelSt, marginBottom: 6 }}>Mentions</div>
              {inv.notes.map((n, i) => (
                <div key={i} style={{ fontSize: 11, color: "var(--muted)", whiteSpace: "pre-wrap" }}>{n}</div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default EInvoiceXmlPreview;
