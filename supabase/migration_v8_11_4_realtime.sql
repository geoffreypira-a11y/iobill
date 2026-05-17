-- ═══════════════════════════════════════════════════════════
-- IO BILL — Migration v8.11.4 — Activer Realtime
-- ═══════════════════════════════════════════════════════════
-- Active Supabase Realtime sur les tables ou on veut un refresh
-- instantane cote frontend (notifications, quotes, invoices).
--
-- Realtime fonctionne en abonnant le client via WebSocket aux
-- changements (INSERT/UPDATE/DELETE) sur ces tables.
-- ═══════════════════════════════════════════════════════════

-- 1) Ajouter les tables a la publication "supabase_realtime"
-- (cree par defaut par Supabase). Si une table est deja dans
-- la publication, on ignore l'erreur.

DO $$
BEGIN
  -- notifications : pour la cloche en temps reel
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;

  -- quotes : pour voir un devis signe instantanement
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.quotes;
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;

  -- invoices : pour voir un paiement / transmission instantanement
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.invoices;
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;
END $$;

-- 2) Le filtrage RLS s'applique automatiquement aux events Realtime
--    (un client ne recoit QUE les events sur les lignes auxquelles il
--    a acces selon les policies RLS). Donc rien d'autre a faire.

NOTIFY pgrst, 'reload schema';
