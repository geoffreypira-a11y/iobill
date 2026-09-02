// IO BILL — v8.48 — Déclenchement des relances sans attendre le cron.
// ═══════════════════════════════════════════════════════════════════
// Le cron Vercel ne passe qu'une fois par jour. Pour que les relances
// partent le jour même où elles deviennent dues, l'app déclenche elle-même
// un passage du moteur :
//   - automatiquement à l'ouverture de l'app (au plus 1 fois / 30 min) ;
//   - à la demande via le bouton « Relancer maintenant » des réglages.
// Le serveur applique de toute façon sa propre limite et reste idempotent :
// une relance déjà envoyée ne repart jamais.
// ═══════════════════════════════════════════════════════════════════

const LS_KEY = "iobill:reminders:last_kick";
const MIN_GAP_MS = 30 * 60 * 1000;

async function call(token, mode) {
  const r = await fetch("/api/cron-reminders", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ mode })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Erreur ${r.status}`);
  return j;
}

/** Passage automatique en arrière-plan. N'échoue jamais bruyamment. */
export async function kickReminders(token) {
  if (!token) return null;
  try {
    const last = Number(localStorage.getItem(LS_KEY) || 0);
    if (Date.now() - last < MIN_GAP_MS) return null;
    localStorage.setItem(LS_KEY, String(Date.now()));
    return await call(token, "auto");
  } catch (e) {
    console.warn("[relances] passage auto impossible:", e?.message);
    return null;
  }
}

/** Passage déclenché par l'utilisateur. Remonte les erreurs à l'appelant. */
export async function runRemindersNow(token) {
  const out = await call(token, "manual");
  try { localStorage.setItem(LS_KEY, String(Date.now())); } catch {}
  return out;
}
