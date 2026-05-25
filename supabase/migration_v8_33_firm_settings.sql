-- ═══════════════════════════════════════════════════════════════════
-- v8.33 — Préférences cabinet + rappels personnalisés par client
-- ═══════════════════════════════════════════════════════════════════

-- 1) Colonnes additionnelles sur accounting_firms (idempotent)
ALTER TABLE public.accounting_firms
  ADD COLUMN IF NOT EXISTS email_contact TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ADD COLUMN IF NOT EXISTS address_line1 TEXT,
  ADD COLUMN IF NOT EXISTS address_zip TEXT,
  ADD COLUMN IF NOT EXISTS address_city TEXT,
  ADD COLUMN IF NOT EXISTS logo_url TEXT,
  ADD COLUMN IF NOT EXISTS ordre_number TEXT,
  ADD COLUMN IF NOT EXISTS opening_hours TEXT,
  ADD COLUMN IF NOT EXISTS notif_on_message BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS notif_on_declaration_due BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.accounting_firms.ordre_number IS 
  'Numéro d''inscription à l''Ordre des Experts-Comptables';
COMMENT ON COLUMN public.accounting_firms.notif_on_message IS 
  'Recevoir un email à chaque nouveau message d''un client';
COMMENT ON COLUMN public.accounting_firms.notif_on_declaration_due IS 
  'Recevoir un email à l''approche d''une date de déclaration TVA (J-3)';

-- 2) Nouvelle table : rappels personnalisés cabinet → client
CREATE TABLE IF NOT EXISTS public.firm_client_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES public.accounting_firms(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  -- Récurrence simple : "monthly_day_X" (X = jour du mois, 1-28) ou "weekly_day_Y" (Y = 1=lundi, 7=dimanche)
  recurrence TEXT NOT NULL,
  hour_local SMALLINT NOT NULL DEFAULT 9 CHECK (hour_local BETWEEN 0 AND 23),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID
);

CREATE INDEX IF NOT EXISTS idx_firm_reminders_firm 
  ON public.firm_client_reminders (firm_id, enabled);
CREATE INDEX IF NOT EXISTS idx_firm_reminders_company 
  ON public.firm_client_reminders (company_id);
CREATE INDEX IF NOT EXISTS idx_firm_reminders_next_run 
  ON public.firm_client_reminders (next_run_at) WHERE enabled = TRUE;

-- 3) RLS sur firm_client_reminders
ALTER TABLE public.firm_client_reminders ENABLE ROW LEVEL SECURITY;

-- Lecture/écriture : seulement les membres du cabinet
DROP POLICY IF EXISTS reminders_select ON public.firm_client_reminders;
CREATE POLICY reminders_select ON public.firm_client_reminders
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm
      WHERE fm.firm_id = firm_client_reminders.firm_id
        AND fm.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS reminders_insert ON public.firm_client_reminders;
CREATE POLICY reminders_insert ON public.firm_client_reminders
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.firm_members fm
      WHERE fm.firm_id = firm_client_reminders.firm_id
        AND fm.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS reminders_update ON public.firm_client_reminders;
CREATE POLICY reminders_update ON public.firm_client_reminders
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm
      WHERE fm.firm_id = firm_client_reminders.firm_id
        AND fm.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS reminders_delete ON public.firm_client_reminders;
CREATE POLICY reminders_delete ON public.firm_client_reminders
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm
      WHERE fm.firm_id = firm_client_reminders.firm_id
        AND fm.user_id = auth.uid()
    )
  );

COMMENT ON TABLE public.firm_client_reminders IS 
  'Rappels personnalisés configurés par un cabinet pour un de ses clients';
