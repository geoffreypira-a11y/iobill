import { useState, useEffect } from "react";
import { sb } from "../lib/supabase.js";

/**
 * useMyFirm — Hook qui retourne le cabinet de l'utilisateur courant (s'il en a un).
 *
 * Retourne :
 *   - loading : true pendant le fetch
 *   - firm    : l'objet accounting_firms si l'user est firm_member, sinon null
 *   - member  : la ligne firm_members (avec role) si membre, sinon null
 *
 * Un user peut être membre d'UN SEUL cabinet (Option 3 : comptable = rôle exclusif).
 */
export function useMyFirm(token, userId) {
  const [loading, setLoading] = useState(true);
  const [firm, setFirm] = useState(null);
  const [member, setMember] = useState(null);

  useEffect(() => {
    if (!token || !userId) {
      setLoading(false);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const members = await sb.select(token, "firm_members", {
          filter: `user_id=eq.${userId}`,
          select: "firm_id,role,receive_email_notifications,joined_at",
          limit: 1
        });
        if (!alive) return;

        if (!members || members.length === 0) {
          setFirm(null);
          setMember(null);
          setLoading(false);
          return;
        }

        const m = members[0];
        const f = await sb.selectOne(token, "accounting_firms", `id=eq.${m.firm_id}`);
        if (!alive) return;
        setFirm(f);
        setMember(m);
      } catch (e) {
        console.warn("[useMyFirm] error:", e?.message);
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [token, userId]);

  return { loading, firm, member };
}
