import React, { useEffect, useState, useMemo } from "react";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend
} from "recharts";
import { sb } from "../../lib/supabase.js";
import { fmtEUR, fmtEURCompact } from "../../lib/helpers.js";
import { snapshotDisplayName } from "../../lib/snapshots.js";

const COLORS = {
  gold: "#d4a843",
  gold2: "#f0c86a",
  green: "#3ecf7a",
  orange: "#e5973c",
  red: "#e55c5c",
  muted: "#6b6a7a",
  bg: "#13141a",
  border: "rgba(212, 168, 67, 0.2)",
  text: "#f0ede8"
};

const PIE_COLORS = [COLORS.gold, COLORS.green, COLORS.orange, COLORS.red, COLORS.muted];

// ──────────────────────────────────────────────────────────────
//  Bloc combine : 3 graphiques cote a cote
// ──────────────────────────────────────────────────────────────
export function DashboardCharts({ token, company }) {
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const list = await sb.select(token, "invoices", {
        filter: `company_id=eq.${company.id}&status=in.(issued,sent,partial,paid,overdue)`,
        order: "issue_date.desc",
        limit: 500
      });
      if (!alive) return;
      setInvoices(list || []);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, company.id]);

  if (loading) {
    return (
      <div className="card card-pad" style={{ textAlign: "center", padding: 40, color: "var(--muted)" }}>
        Chargement des graphiques...
      </div>
    );
  }

  if (invoices.length === 0) {
    return null; // Pas de graphiques si pas de data — le dashboard reste epure
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 16, marginBottom: 16 }}>
      <RevenueChart invoices={invoices} />
      <StatusDonut invoices={invoices} />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
//  CA mensuel sur les 12 derniers mois
// ──────────────────────────────────────────────────────────────
function RevenueChart({ invoices }) {
  const data = useMemo(() => {
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.toISOString().slice(0, 7); // YYYY-MM
      months.push({
        key,
        label: d.toLocaleDateString("fr-FR", { month: "short", year: "2-digit" }),
        ca_ht: 0,
        encaisse: 0
      });
    }

    invoices.forEach((inv) => {
      const m = (inv.issue_date || "").slice(0, 7);
      const target = months.find((mm) => mm.key === m);
      if (target) {
        target.ca_ht += (inv.subtotal_ht_cents || 0) / 100;
        target.encaisse += (inv.paid_cents || 0) / 100;
      }
    });

    return months.map((m) => ({
      label: m.label,
      "CA HT": Math.round(m.ca_ht),
      "Encaissé": Math.round(m.encaisse)
    }));
  }, [invoices]);

  return (
    <div className="card card-pad">
      <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 14 }}>
        Évolution CA HT — 12 derniers mois
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
          <XAxis dataKey="label" stroke={COLORS.muted} fontSize={11} tickLine={false} />
          <YAxis
            stroke={COLORS.muted}
            fontSize={10}
            tickFormatter={(v) => v >= 1000 ? (v / 1000).toFixed(0) + "k" : v}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              background: COLORS.bg,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 8,
              fontSize: 12
            }}
            labelStyle={{ color: COLORS.text }}
            formatter={(v) => fmtEURCompact(v * 100)}
            cursor={{ fill: "rgba(212, 168, 67, 0.05)" }}
          />
          <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} />
          <Bar dataKey="CA HT" fill={COLORS.gold} radius={[4, 4, 0, 0]} />
          <Bar dataKey="Encaissé" fill={COLORS.green} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
//  Donut : repartition des factures par statut
// ──────────────────────────────────────────────────────────────
function StatusDonut({ invoices }) {
  const data = useMemo(() => {
    const counts = {};
    invoices.forEach((inv) => {
      let s = inv.status;
      if (["issued", "sent", "partial"].includes(s) && inv.due_date && new Date(inv.due_date) < new Date()) {
        s = "overdue";
      }
      counts[s] = (counts[s] || 0) + 1;
    });
    const labels = {
      paid: "Payées", overdue: "En retard", partial: "Partielles",
      sent: "Envoyées", issued: "Émises", canceled: "Annulées"
    };
    const colorMap = {
      paid: COLORS.green, overdue: COLORS.red, partial: COLORS.orange,
      sent: COLORS.gold, issued: COLORS.gold2, canceled: COLORS.muted
    };
    return Object.entries(counts).map(([k, v]) => ({
      name: labels[k] || k,
      value: v,
      color: colorMap[k] || COLORS.muted
    }));
  }, [invoices]);

  return (
    <div className="card card-pad">
      <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 14 }}>
        Répartition factures
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={50}
            outerRadius={80}
            paddingAngle={2}
            dataKey="value"
          >
            {data.map((entry, idx) => (
              <Cell key={idx} fill={entry.color} stroke={COLORS.bg} strokeWidth={2} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: COLORS.bg,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 8,
              fontSize: 12
            }}
            labelStyle={{ color: COLORS.text }}
          />
          <Legend
            wrapperStyle={{ fontSize: 11 }}
            iconType="circle"
            iconSize={8}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
//  Top clients (barres horizontales) — composant separe
// ──────────────────────────────────────────────────────────────
export function TopClientsChart({ token, company }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
      const invoices = await sb.select(token, "invoices", {
        filter: `company_id=eq.${company.id}&status=in.(issued,sent,partial,paid,overdue)&issue_date=gte.${yearStart}`,
        select: "client_id,client_snapshot,subtotal_ht_cents",
        limit: 500
      });
      if (!alive) return;

      const byClient = {};
      (invoices || []).forEach((inv) => {
        const key = inv.client_id || "_none";
        const name = snapshotDisplayName(inv.client_snapshot);
        if (!byClient[key]) byClient[key] = { name, ca: 0 };
        byClient[key].ca += (inv.subtotal_ht_cents || 0) / 100;
      });

      const sorted = Object.values(byClient)
        .sort((a, b) => b.ca - a.ca)
        .slice(0, 5)
        .map((c) => ({ name: c.name.length > 22 ? c.name.slice(0, 20) + "…" : c.name, ca: Math.round(c.ca) }));

      setData(sorted);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, company.id]);

  if (loading || data.length === 0) return null;

  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <div style={{ fontFamily: "Syne, sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 14 }}>
        Top 5 clients (CA HT YTD)
      </div>
      <ResponsiveContainer width="100%" height={Math.max(180, data.length * 36)}>
        <BarChart data={data} layout="vertical" margin={{ top: 5, right: 30, left: 110, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" horizontal={false} />
          <XAxis
            type="number"
            stroke={COLORS.muted}
            fontSize={10}
            tickFormatter={(v) => v >= 1000 ? (v / 1000).toFixed(0) + "k" : v}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="name"
            stroke={COLORS.muted}
            fontSize={11}
            width={110}
            tickLine={false}
          />
          <Tooltip
            contentStyle={{
              background: COLORS.bg,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 8,
              fontSize: 12
            }}
            formatter={(v) => fmtEUR(v * 100)}
            cursor={{ fill: "rgba(212, 168, 67, 0.05)" }}
          />
          <Bar dataKey="ca" fill={COLORS.gold} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
