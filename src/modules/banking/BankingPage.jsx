import React, { useEffect, useMemo, useState } from "react";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtEUR, fmtDate } from "../../lib/helpers.js";
import { capture, bumpModuleUsage } from "../../lib/telemetry.js";

export function BankingPage({ token, company }) {
  const [connections, setConnections] = useState([]);
  const [transactions, setTransactions] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [matchFilter, setMatchFilter] = useState("unmatched");
  const [syncing, setSyncing] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [c, t, i, s] = await Promise.all([
        sb.select(token, "bank_connections", { filter: `company_id=eq.${company.id}`, order: "created_at.desc" }),
        sb.select(token, "bank_transactions", { filter: `company_id=eq.${company.id}`, order: "transaction_date.desc", limit: 200 }),
        sb.select(token, "invoices", {
          filter: `company_id=eq.${company.id}&status=in.(issued,sent,partial,overdue)`,
          order: "issue_date.desc"
        }),
        sb.select(token, "bank_match_suggestions", {
          filter: `company_id=eq.${company.id}&status=eq.pending`,
          order: "confidence_score.desc",
          limit: 50
        })
      ]);
      if (!alive) return;
      setConnections(c || []);
      setTransactions(t || []);
      setInvoices(i || []);
      setSuggestions(s || []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, company.id]);

  const filtered = useMemo(() => {
    if (matchFilter === "all") return transactions;
    return transactions.filter((t) => t.match_status === matchFilter);
  }, [transactions, matchFilter]);

  // Connexion d'un nouveau compte (Bridge OAuth)
  async function connectBank() {
    try {
      const r = await fetch("/api/bridge-connect", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ company_id: company.id })
      });
      const j = await r.json();
      if (j?.connect_url) {
        window.location.href = j.connect_url;
      } else {
        alert("API Bridge non câblée. À implémenter dans api/bridge-connect.js");
      }
    } catch {
      alert("API Bridge non câblée. À implémenter dans api/bridge-connect.js");
    }
  }

  // Synchronisation manuelle des transactions
  async function syncTransactions() {
    setSyncing(true);
    try {
      const r = await fetch("/api/bridge-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ company_id: company.id })
      });
      if (!r.ok) throw new Error();
      const j = await r.json();
      // Recharge la liste
      const t = await sb.select(token, "bank_transactions", { filter: `company_id=eq.${company.id}`, order: "transaction_date.desc", limit: 200 });
      setTransactions(t || []);
      capture("bank_synced", { imported: j.imported || 0 });
      bumpModuleUsage(token, company.id, "banking");
      alert(`${j.imported || 0} nouvelles transactions importées.`);
    } catch {
      alert("API Bridge non câblée.");
    }
    setSyncing(false);
  }

  // Auto-lettrage IA : appelle bank-match-suggest
  async function runSuggest() {
    setSuggesting(true);
    try {
      const r = await fetch("/api/bank-match-suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({})
      });
      if (!r.ok) throw new Error("API error");
      const j = await r.json();
      // Recharge les suggestions
      const s = await sb.select(token, "bank_match_suggestions", {
        filter: `company_id=eq.${company.id}&status=eq.pending`,
        order: "confidence_score.desc", limit: 50
      });
      setSuggestions(s || []);
      alert(`${j.suggestions || 0} suggestion(s) générée(s) sur ${j.scanned || 0} transaction(s) analysée(s).`);
    } catch (e) {
      alert("Erreur d'auto-lettrage");
    }
    setSuggesting(false);
  }

  // Valide ou rejette une suggestion
  async function confirmMatch(suggestionId, action) {
    try {
      const r = await fetch("/api/bank-match-confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ suggestion_id: suggestionId, action })
      });
      if (!r.ok) throw new Error();
      // Refresh
      setSuggestions((arr) => arr.filter((s) => s.id !== suggestionId));
      // Refresh transactions et invoices (le statut change si payment cree)
      const [t, i] = await Promise.all([
        sb.select(token, "bank_transactions", { filter: `company_id=eq.${company.id}`, order: "transaction_date.desc", limit: 200 }),
        sb.select(token, "invoices", { filter: `company_id=eq.${company.id}&status=in.(issued,sent,partial,overdue,paid)`, order: "issue_date.desc" })
      ]);
      setTransactions(t || []);
      setInvoices(i || []);
    } catch {
      alert("Erreur lors de la validation");
    }
  }

  // Lettrage : association transaction -> facture
  async function matchTransaction(txId, invoiceId) {
    const updated = await sb.update(token, "bank_transactions", `id=eq.${txId}`, {
      matched_invoice_id: invoiceId,
      match_status: "matched",
      match_confidence: 1.0
    });
    if (updated && updated[0]) {
      // Crée un paiement lié
      const tx = transactions.find((t) => t.id === txId);
      const inv = invoices.find((i) => i.id === invoiceId);
      if (tx && inv) {
        await sb.insert(token, "payments", {
          company_id: company.id,
          invoice_id: invoiceId,
          amount_cents: Math.abs(tx.amount_cents),
          method: "bank_transfer",
          paid_at: tx.transaction_date,
          reference: tx.description,
          bank_transaction_id: tx.external_id,
          match_method: "manual",
          match_confidence: 1.0
        });
        const newPaid = (inv.paid_cents || 0) + Math.abs(tx.amount_cents);
        const newStatus = newPaid >= inv.total_ttc_cents ? "paid" : "partial";
        await sb.update(token, "invoices", `id=eq.${invoiceId}`, {
          paid_cents: newPaid,
          status: newStatus
        });
      }
      setTransactions(transactions.map((t) => (t.id === txId ? updated[0] : t)));
    }
  }

  async function ignoreTx(txId) {
    const updated = await sb.update(token, "bank_transactions", `id=eq.${txId}`, {
      match_status: "ignored"
    });
    if (updated && updated[0]) {
      setTransactions(transactions.map((t) => (t.id === txId ? updated[0] : t)));
    }
  }

  if (loading) return <div className="page"><div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Chargement...</div></div>;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">BANQUE — LETTRAGE</div>
          <div className="page-sub">
            {connections.length} compte{connections.length !== 1 ? "s" : ""} connecté{connections.length !== 1 ? "s" : ""} · {transactions.filter((t) => t.match_status === "unmatched").length} transactions à lettrer
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {connections.length > 0 && (
            <button className="btn btn-ghost" onClick={syncTransactions} disabled={syncing}>
              {syncing ? "Synchro..." : "🔄 Synchroniser"}
            </button>
          )}
          {transactions.length > 0 && (
            <button className="btn btn-ghost" onClick={runSuggest} disabled={suggesting}>
              {suggesting ? "..." : "🤖 Auto-lettrer"}
            </button>
          )}
          <button className="btn btn-primary" onClick={connectBank}>
            <Icon name="plus" size={14} /> Connecter une banque
          </button>
        </div>
      </div>

      {/* Suggestions de matching IA */}
      {suggestions.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 16, borderLeft: "3px solid var(--gold)" }}>
          <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 10 }}>
            🤖 {suggestions.length} suggestion{suggestions.length > 1 ? "s" : ""} de lettrage à valider
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {suggestions.slice(0, 10).map((s) => {
              const tx = transactions.find((t) => t.id === s.bank_transaction_id);
              const inv = s.match_type === "invoice" ? invoices.find((i) => i.id === s.match_id) : null;
              if (!tx) return null;
              const confColor = s.confidence_score >= 0.8 ? "var(--green)" : s.confidence_score >= 0.6 ? "var(--gold)" : "var(--orange)";
              return (
                <div
                  key={s.id}
                  style={{
                    background: "var(--card2)", padding: 12, borderRadius: 7,
                    display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap"
                  }}
                >
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <div style={{ fontSize: 12, marginBottom: 3 }}>
                      <span className="mono" style={{ color: "var(--muted)" }}>{fmtDate(tx.transaction_date)}</span>
                      {" · "}
                      <span>{(tx.label || "").slice(0, 60)}</span>
                      {" · "}
                      <span className="mono" style={{ color: tx.amount_cents > 0 ? "var(--green)" : "var(--orange)" }}>
                        {fmtEUR(Math.abs(tx.amount_cents))}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--muted2)" }}>
                      → <strong>{inv ? `Facture ${inv.number}` : "Achat"}</strong>
                      {inv?.client_snapshot?.legal_name && ` (${inv.client_snapshot.legal_name})`}
                    </div>
                    {s.reasoning && (
                      <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4, fontStyle: "italic" }}>
                        {s.reasoning}
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: confColor, minWidth: 60 }}>
                    {Math.round(s.confidence_score * 100)}%
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="btn btn-primary btn-xs" onClick={() => confirmMatch(s.id, "accept")}>
                      ✓ Valider
                    </button>
                    <button className="btn btn-ghost btn-xs" onClick={() => confirmMatch(s.id, "reject")}>
                      ✗ Rejeter
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Comptes connectés */}
      {connections.length === 0 ? (
        <div className="card card-pad" style={{ textAlign: "center", padding: 60, marginBottom: 16 }}>
          <div style={{ fontSize: 44, marginBottom: 14 }}>🏦</div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Aucune banque connectée</div>
          <div style={{ fontSize: 13, color: "var(--muted2)", marginBottom: 18, maxWidth: 480, marginLeft: "auto", marginRight: "auto" }}>
            Connectez votre compte pro via la DSP2 (PSD2). Vos transactions sont rapatriées automatiquement et lettrées avec vos factures émises grâce au moteur de matching IO BILL.
          </div>
          <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 18 }}>
            Provider : Bridge by BPCE — Agrément ACPR n°16648 · DSP2/RGPD compatible
          </div>
          <button className="btn btn-primary" onClick={connectBank}>
            <Icon name="bank" size={14} /> Connecter ma banque
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12, marginBottom: 18 }}>
          {connections.map((c) => (
            <div key={c.id} className="card card-pad">
              <div style={{ fontSize: 11, color: "var(--muted)", letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 6 }}>
                {c.provider}
              </div>
              <div style={{ fontFamily: "Syne, sans-serif", fontSize: 15, fontWeight: 700, marginBottom: 4 }}>
                {c.bank_name || "Compte"}
              </div>
              <div style={{ fontSize: 12, color: "var(--muted2)" }} className="mono">
                •••• {c.iban_last4}
              </div>
              <div style={{ marginTop: 10, fontSize: 11, color: "var(--muted)" }}>
                Dernière sync : {c.last_sync_at ? fmtDate(c.last_sync_at) : "jamais"}
              </div>
              <span className={"badge " + (c.status === "active" ? "badge-green" : "badge-orange")} style={{ marginTop: 10 }}>
                {c.status === "active" ? "✅ Actif" : "⚠️ " + c.status}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Filtres + table transactions */}
      {transactions.length > 0 && (
        <>
          <div className="tabs" style={{ marginBottom: 16 }}>
            <button className={"tab" + (matchFilter === "unmatched" ? " active" : "")} onClick={() => setMatchFilter("unmatched")}>
              À lettrer ({transactions.filter((t) => t.match_status === "unmatched").length})
            </button>
            <button className={"tab" + (matchFilter === "suggested" ? " active" : "")} onClick={() => setMatchFilter("suggested")}>
              Suggérées ({transactions.filter((t) => t.match_status === "suggested").length})
            </button>
            <button className={"tab" + (matchFilter === "matched" ? " active" : "")} onClick={() => setMatchFilter("matched")}>
              Lettrées ({transactions.filter((t) => t.match_status === "matched").length})
            </button>
            <button className={"tab" + (matchFilter === "ignored" ? " active" : "")} onClick={() => setMatchFilter("ignored")}>
              Ignorées ({transactions.filter((t) => t.match_status === "ignored").length})
            </button>
            <button className={"tab" + (matchFilter === "all" ? " active" : "")} onClick={() => setMatchFilter("all")}>
              Tout ({transactions.length})
            </button>
          </div>

          <div className="card" style={{ overflow: "hidden" }}>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th style={{ textAlign: "right" }}>Montant</th>
                  <th>Lettrage</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => {
                  const matched = invoices.find((i) => i.id === t.matched_invoice_id);
                  const candidates = t.amount_cents > 0
                    ? invoices.filter((i) => Math.abs(i.total_ttc_cents - i.paid_cents - t.amount_cents) < 100)
                    : [];
                  return (
                    <tr key={t.id}>
                      <td>{fmtDate(t.transaction_date)}</td>
                      <td>
                        <div style={{ fontSize: 13 }}>{t.description || "—"}</div>
                        {t.counterparty && (
                          <div style={{ fontSize: 11, color: "var(--muted)" }}>{t.counterparty}</div>
                        )}
                      </td>
                      <td className="mono" style={{ textAlign: "right", color: t.amount_cents > 0 ? "var(--green)" : "var(--text)" }}>
                        {t.amount_cents > 0 ? "+" : ""}{fmtEUR(t.amount_cents)}
                      </td>
                      <td>
                        {t.match_status === "matched" && matched ? (
                          <span className="mono" style={{ fontSize: 11, color: "var(--green)" }}>
                            ✅ {matched.number}
                          </span>
                        ) : t.match_status === "ignored" ? (
                          <span style={{ fontSize: 11, color: "var(--muted)" }}>Ignorée</span>
                        ) : t.amount_cents > 0 ? (
                          <select
                            className="form-input"
                            style={{ fontSize: 11, padding: "4px 8px" }}
                            defaultValue=""
                            onChange={(e) => e.target.value && matchTransaction(t.id, e.target.value)}
                          >
                            <option value="">— Lettrer avec —</option>
                            {candidates.length > 0 && (
                              <optgroup label="Suggestions (montant exact)">
                                {candidates.map((inv) => (
                                  <option key={inv.id} value={inv.id}>
                                    ⚡ {inv.number} — {fmtEUR(inv.total_ttc_cents - inv.paid_cents)}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                            <optgroup label="Toutes les factures">
                              {invoices.map((inv) => (
                                <option key={inv.id} value={inv.id}>
                                  {inv.number} — {fmtEUR(inv.total_ttc_cents - inv.paid_cents)}
                                </option>
                              ))}
                            </optgroup>
                          </select>
                        ) : (
                          <span style={{ fontSize: 11, color: "var(--muted)" }}>(débit)</span>
                        )}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {t.match_status === "unmatched" && (
                          <button className="btn btn-ghost btn-xs" onClick={() => ignoreTx(t.id)}>Ignorer</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
