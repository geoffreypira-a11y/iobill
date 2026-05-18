-- ──────────────────────────────────────────────────────────────
-- IO BILL — Migration v8.15.0 — Panel admin
-- Archivage de comptes + table support_tickets
-- ──────────────────────────────────────────────────────────────
-- À exécuter dans Supabase SQL Editor.

-- 1) Colonnes archivage sur companies
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS _archived BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS archive_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archive_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_companies_archived ON public.companies(_archived);
CREATE INDEX IF NOT EXISTS idx_companies_active ON public.companies(is_active);

-- 2) Table support_tickets
CREATE TABLE IF NOT EXISTS public.support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('incident','amelioration','question','facturation')),
  message TEXT NOT NULL CHECK (length(message) <= 5000),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','resolved','closed')),
  admin_notes TEXT CHECK (length(admin_notes) <= 5000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON public.support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_company ON public.support_tickets(company_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_created ON public.support_tickets(created_at DESC);

CREATE OR REPLACE FUNCTION public.set_support_tickets_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_support_tickets_updated_at ON public.support_tickets;
CREATE TRIGGER trg_support_tickets_updated_at
  BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public.set_support_tickets_updated_at();

-- 3) RLS support_tickets
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS st_select ON public.support_tickets;
CREATE POLICY st_select ON public.support_tickets FOR SELECT TO authenticated USING (
  user_id = auth.uid()
  OR EXISTS (SELECT 1 FROM public.companies WHERE user_id = auth.uid() AND is_admin = TRUE)
);

DROP POLICY IF EXISTS st_insert ON public.support_tickets;
CREATE POLICY st_insert ON public.support_tickets FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS st_update ON public.support_tickets;
CREATE POLICY st_update ON public.support_tickets FOR UPDATE TO authenticated USING (
  EXISTS (SELECT 1 FROM public.companies WHERE user_id = auth.uid() AND is_admin = TRUE)
);

DROP POLICY IF EXISTS st_delete ON public.support_tickets;
CREATE POLICY st_delete ON public.support_tickets FOR DELETE TO authenticated USING (
  EXISTS (SELECT 1 FROM public.companies WHERE user_id = auth.uid() AND is_admin = TRUE)
);

-- 4) Bucket "backups" (privé) à créer manuellement dans Supabase Dashboard :
--    Storage > New bucket > name="backups" > Public=NO > Save
--    Aucune policy : seul service_role y accède via l'API admin.

-- FIN migration v8.15.0
