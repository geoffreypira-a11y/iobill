-- IO BILL - Migration v8.1 : colonnes signature simple + refus de devis
-- A executer une seule fois dans Supabase SQL Editor apres le deploiement de v8.1

-- Ajout colonnes manquantes a la table quotes
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS signed_by_name TEXT,
  ADD COLUMN IF NOT EXISTS signed_by_ip TEXT,
  ADD COLUMN IF NOT EXISTS refusal_reason TEXT;

-- Index pour rechercher rapidement les devis signes
CREATE INDEX IF NOT EXISTS idx_quotes_status_signed
  ON public.quotes(company_id, status)
  WHERE status = 'signed';

-- Refresh des politiques RLS au cas ou
NOTIFY pgrst, 'reload schema';

-- FIN migration_v8_1.sql
