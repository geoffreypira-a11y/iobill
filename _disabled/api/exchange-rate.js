// IO BILL - Proxy taux de change BCE (via frankfurter.app)
// Avec cache memoire journalier pour limiter les appels.

import { json } from "./_lib/supabase-admin.js";

let cache = { date: null, rates: {} };

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  const from = req.query?.from || (req.body?.from);
  const to = req.query?.to || (req.body?.to) || "EUR";
  const date = req.query?.date || (req.body?.date) || null;

  if (!from) return json(res, 400, { error: "Missing 'from' currency" });

  if (from === to) {
    return json(res, 200, { rate: 1, date: date || new Date().toISOString().slice(0, 10), from, to, cached: false });
  }

  const cacheKey = `${date || "latest"}-${from}-${to}`;
  const today = new Date().toISOString().slice(0, 10);

  // Reset cache si change de jour
  if (cache.date !== today) {
    cache = { date: today, rates: {} };
  }

  if (cache.rates[cacheKey]) {
    return json(res, 200, { ...cache.rates[cacheKey], cached: true });
  }

  try {
    const dateStr = date || "latest";
    const r = await fetch(`https://api.frankfurter.app/${dateStr}?from=${from}&to=${to}`);
    if (!r.ok) {
      return json(res, 502, { error: "Exchange rate API unavailable" });
    }
    const j = await r.json();
    const out = { rate: j.rates?.[to], date: j.date, from, to };
    cache.rates[cacheKey] = out;
    return json(res, 200, { ...out, cached: false });
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
}
