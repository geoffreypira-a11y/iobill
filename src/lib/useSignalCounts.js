import { useEffect, useState } from "react";
import { sb } from "../lib/supabase.js";

/**
 * useSignalCounts — v8.27.5
 * Charge les signalements ouverts pour une company,
 * retourne un map { [target_id]: { count, maxSeverity } } pour le target_type donné.
 * 
 * @param {string} token
 * @param {string} companyId
 * @param {string} targetType  ('invoice' | 'purchase' | 'quote' | 'credit_note')
 */
export function useSignalCounts(token, companyId, targetType) {
  const [byId, setById] = useState({});
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token || !companyId || !targetType) { setLoading(false); return; }
    let alive = true;
    (async () => {
      const rows = await sb.select(token, "firm_signals", {
        filter: `company_id=eq.${companyId}&target_type=eq.${targetType}&status=eq.open&visible_to_client=eq.true`,
        select: "target_id,severity",
        limit: 500
      });
      if (!alive) return;
      const m = {};
      const sevRank = { info: 1, warning: 2, critical: 3 };
      for (const s of (rows || [])) {
        if (!s.target_id) continue;
        if (!m[s.target_id]) m[s.target_id] = { count: 0, maxSeverity: "info" };
        m[s.target_id].count++;
        if (sevRank[s.severity] > sevRank[m[s.target_id].maxSeverity]) {
          m[s.target_id].maxSeverity = s.severity;
        }
      }
      setById(m);
      setTotal((rows || []).length);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, companyId, targetType]);

  return { byId, total, loading };
}
