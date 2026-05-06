import React from "react";

// ─── Skeleton primitif ──────────────────────────────────────
export function SkeletonBox({ height = 14, width = "100%", radius = 4, style = {} }) {
  return (
    <div
      className="skeleton"
      style={{
        height,
        width,
        borderRadius: radius,
        ...style
      }}
    />
  );
}

// ─── Skeleton table : utilise pour les listes ────────────────
export function SkeletonTable({ rows = 6, cols = 5 }) {
  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <table>
        <thead>
          <tr>
            {Array.from({ length: cols }).map((_, i) => (
              <th key={i}><SkeletonBox height={12} width="60%" /></th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, r) => (
            <tr key={r}>
              {Array.from({ length: cols }).map((_, c) => (
                <td key={c}>
                  <SkeletonBox height={12} width={c === 0 ? "70%" : c === cols - 1 ? "40%" : "85%"} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Skeleton KPI grid ───────────────────────────────────────
export function SkeletonKPIs({ count = 4 }) {
  return (
    <div className="kpi-grid">
      {Array.from({ length: count }).map((_, i) => (
        <div className="kpi" key={i}>
          <SkeletonBox height={9} width="60%" style={{ marginBottom: 8 }} />
          <SkeletonBox height={22} width="80%" style={{ marginBottom: 6 }} />
          <SkeletonBox height={9} width="50%" />
        </div>
      ))}
    </div>
  );
}

// ─── Skeleton card ───────────────────────────────────────────
export function SkeletonCard({ lines = 3 }) {
  return (
    <div className="card card-pad">
      <SkeletonBox height={14} width="40%" style={{ marginBottom: 14 }} />
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonBox key={i} height={11} width={i === lines - 1 ? "70%" : "100%"} style={{ marginBottom: 8 }} />
      ))}
    </div>
  );
}

// ─── Page complete avec KPI + table ──────────────────────────
export function SkeletonListPage({ kpis = 4, rows = 6, cols = 5 }) {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <SkeletonBox height={20} width={180} style={{ marginBottom: 8 }} />
          <SkeletonBox height={11} width={120} />
        </div>
      </div>
      {kpis > 0 && <div style={{ marginBottom: 18 }}><SkeletonKPIs count={kpis} /></div>}
      <SkeletonTable rows={rows} cols={cols} />
    </div>
  );
}
