-- ──────────────────────────────────────────────────────────────
-- IO BILL — Migration v8.21.0 — CLEANUP module Cabinet v8.19
-- ──────────────────────────────────────────────────────────────
-- On supprime les tables firms / firm_users / firm_clients et les
-- objets associés. Le module Cabinet va être reconstruit dans une
-- v8.23 avec un modèle économique différent (Mode Comptable : cabinet
-- GRATUIT illimité, c'est le client final qui paie).
--
-- ⚠ ATTENTION : irréversible. Tous les cabinets/clients liés
-- aux anciennes tables seront perdus. À ne lancer QUE si tu
-- n'as aucune donnée cabinet en production (ce qui est ton cas).
--
-- Tu peux exécuter ce SQL après avoir fait un backup admin
-- (depuis le Panel Admin → "Sauvegarder maintenant").
-- ──────────────────────────────────────────────────────────────

-- 1) Supprimer la vue d'audit
DROP VIEW IF EXISTS public.admin_free_firms CASCADE;

-- 2) Supprimer les fonctions associées
DROP FUNCTION IF EXISTS public.claim_firm_free_slot(uuid);
DROP FUNCTION IF EXISTS public.my_firm_ids();

-- 3) Supprimer les tables (CASCADE supprime aussi triggers, policies, FK)
DROP TABLE IF EXISTS public.firm_clients CASCADE;
DROP TABLE IF EXISTS public.firm_users CASCADE;
DROP TABLE IF EXISTS public.firms CASCADE;

-- 4) Petit log dans audit_log si la table existe (best-effort)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_log') THEN
    INSERT INTO public.audit_log (table_name, action, payload, created_at)
    VALUES (
      'firms',
      'CLEANUP_v8_21',
      jsonb_build_object('reason', 'Cabinet v8.19 abandonné au profit du Mode Comptable v8.23 (modèle économique inversé)'),
      NOW()
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- ignore si audit_log a une structure différente
  NULL;
END $$;

-- FIN cleanup v8.21.0
-- Le Mode Comptable v8.23 introduira accounting_firms, firm_members,
-- firm_client_links, firm_signals, firm_messages.
