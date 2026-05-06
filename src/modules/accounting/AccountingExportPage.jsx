import React, { useEffect, useMemo, useState } from "react";
import { sb } from "../../lib/supabase.js";
import { Icon } from "../../components/Icon.jsx";
import { fmtEUR, fmtDate, todayISO } from "../../lib/helpers.js";
import { capture, bumpModuleUsage } from "../../lib/telemetry.js";

const EXPORT_FORMATS = [
  { code: "fec", label: "FEC (Fichier des Écritures Comptables)", description: "Format standard exigé par l'administration fiscale en cas de contrôle (art. A.47 A-1 LPF)." },
  { code: "csv", label: "CSV générique", description: "Pour reprise dans Excel ou tout outil compta." },
  { code: "sage", label: "Sage 100 / Sage Compta", description: "Import direct dans Sage. UTF-8 BOM, séparateur ';', date JJ/MM/AAAA." },
  { code: "cegid", label: "Cegid Compta / Cegid Loop", description: "Format CSV importable dans Cegid avec sens D/C, date JJMMAAAA." },
  { code: "pennylane", label: "Pennylane (CSV)", description: "Import dans Pennylane via CSV. Pour la synchro API en temps réel, voir 'Pennylane API' (V1.4)." },
  { code: "pennylane_api", label: "Pennylane (API)", description: "Synchronisation directe avec votre compte Pennylane (V1.4)." },
  { code: "tiime_api", label: "Tiime (API)", description: "Envoi vers votre cabinet via Tiime (V1.4)." }
];

export function AccountingExportPage({ token, company }) {
  const [exports, setExports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [periodStart, setPeriodStart] = useState(yearStart());
  const [periodEnd, setPeriodEnd] = useState(todayISO());
  const [format, setFormat] = useState("fec");

  useEffect(() => {
    let alive = true;
    (async () => {
      const list = await sb.select(token, "accounting_exports", {
        filter: `company_id=eq.${company.id}`,
        order: "created_at.desc",
        limit: 50
      });
      if (alive) {
        setExports(list || []);
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [token, company.id]);

  async function generate() {
    setGenerating(true);
    try {
      const r = await fetch("/api/accounting-export", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          company_id: company.id,
          format,
          period_start: periodStart,
          period_end: periodEnd
        })
      });
      const j = await r.json();
      if (j?.id) {
        setExports([j, ...exports]);
        capture("accounting_exported", {
          format,
          period_start: periodStart,
          period_end: periodEnd
        });
        bumpModuleUsage(token, company.id, "accounting");
        if (j.file_url) window.open(j.file_url, "_blank");
      } else {
        alert("API non câblée. Sera implémentée dans api/accounting-export.js");
      }
    } catch {
      alert("API non câblée. Sera implémentée dans api/accounting-export.js");
    }
    setGenerating(false);
  }

  if (loading) return <div className="page"><div style={{ padding: 60, textAlign: "center", color: "var(--muted)" }}>Chargement...</div></div>;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">EXPORT COMPTABLE</div>
          <div className="page-sub">Génération FEC ou envoi vers connecteurs</div>
        </div>
      </div>

      {/* Form génération */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 14 }}>
          Nouvel export
        </div>

        <div className="form-row">
          <label className="form-label">Format</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {EXPORT_FORMATS.map((f) => (
              <label
                key={f.code}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  padding: "10px 14px",
                  background: format === f.code ? "var(--card2)" : "var(--card)",
                  border: "1px solid " + (format === f.code ? "var(--gold)" : "var(--border2)"),
                  borderRadius: 8,
                  cursor: "pointer"
                }}
              >
                <input
                  type="radio"
                  checked={format === f.code}
                  onChange={() => setFormat(f.code)}
                  style={{ accentColor: "var(--gold)", marginTop: 3 }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{f.label}</div>
                  <div style={{ fontSize: 11, color: "var(--muted)" }}>{f.description}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 14 }}>
          <div className="form-row">
            <label className="form-label">Période — début</label>
            <input type="date" className="form-input" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          </div>
          <div className="form-row">
            <label className="form-label">Période — fin</label>
            <input type="date" className="form-input" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
          </div>
        </div>

        <button className="btn btn-primary" onClick={generate} disabled={generating}>
          <Icon name="download" size={14} /> {generating ? "Génération..." : "Générer l'export"}
        </button>
      </div>

      {/* Historique */}
      <div className="card" style={{ overflow: "hidden" }}>
        <div className="card-pad" style={{ borderBottom: "1px solid var(--border2)", padding: "14px 20px" }}>
          <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase" }}>
            Historique des exports
          </div>
        </div>
        {exports.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
            Aucun export généré.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Format</th>
                <th>Période</th>
                <th style={{ textAlign: "right" }}>Lignes</th>
                <th>Statut</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {exports.map((e) => (
                <tr key={e.id}>
                  <td>{fmtDate(e.created_at)}</td>
                  <td className="mono">{e.format.toUpperCase()}</td>
                  <td>{fmtDate(e.period_start)} → {fmtDate(e.period_end)}</td>
                  <td className="mono" style={{ textAlign: "right" }}>{e.row_count || "—"}</td>
                  <td>
                    <span className={"badge " + (e.status === "ready" || e.status === "downloaded" ? "badge-green" : "badge-muted")}>
                      {e.status}
                    </span>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {e.file_url && (
                      <a href={e.file_url} target="_blank" rel="noreferrer" className="btn btn-ghost btn-xs">
                        <Icon name="download" size={12} /> Télécharger
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function yearStart() {
  return new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
}
