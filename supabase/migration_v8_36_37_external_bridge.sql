-- ═══════════════════════════════════════════════════════════════════
-- v8.36 + v8.37 — IO BILL : Pont API écosystème OWL (IOCAR phase 1 + 2)
--
-- Cette migration consolide :
--   • v8.36 : colonnes companies (source_app, external_ref),
--             colonnes invoices (external_source, external_id),
--             table external_api_keys
--   • v8.37 : colonne companies.external_managed_fields (alerte IOBILL si
--             modif d'un champ géré par IOCAR)
-- ═══════════════════════════════════════════════════════════════════

-- ── companies : source + ref + champs gérés externes ────────
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS source_app TEXT NOT NULL DEFAULT 'iobill',
  ADD COLUMN IF NOT EXISTS external_ref TEXT,
  ADD COLUMN IF NOT EXISTS external_managed_fields TEXT[] DEFAULT '{}'::TEXT[];

CREATE INDEX IF NOT EXISTS idx_companies_external
  ON public.companies(source_app, external_ref)
  WHERE external_ref IS NOT NULL;

COMMENT ON COLUMN public.companies.source_app IS
  'Origine du compte : iobill (par défaut), iocar, iobtp, ioinstitute...';
COMMENT ON COLUMN public.companies.external_ref IS
  'ID externe dans l''app source (ex. garages.id côté IOCAR). NULL pour iobill natif.';
COMMENT ON COLUMN public.companies.external_managed_fields IS
  'Liste des champs gérés par l''app source. Le frontend IOBILL alerte si user modifie l''un d''eux.';

-- ── invoices : trace origine + idempotence ──────────────────
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS external_source TEXT,
  ADD COLUMN IF NOT EXISTS external_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_external
  ON public.invoices(external_source, external_id)
  WHERE external_source IS NOT NULL AND external_id IS NOT NULL;

COMMENT ON COLUMN public.invoices.external_source IS
  'App source de la facture (iocar, iobtp, ...). NULL pour iobill natif.';
COMMENT ON COLUMN public.invoices.external_id IS
  'ID de l''entité source (ex. orders.id côté IOCAR). Unicité avec external_source.';

-- ── Table external_api_keys ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.external_api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  source_app TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  label TEXT,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_external_api_keys_token
  ON public.external_api_keys(token)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_external_api_keys_company
  ON public.external_api_keys(company_id);

ALTER TABLE public.external_api_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS eak_owner_select ON public.external_api_keys;
CREATE POLICY eak_owner_select ON public.external_api_keys FOR SELECT TO authenticated USING (
  EXISTS (
    SELECT 1 FROM public.companies c
    WHERE c.id = external_api_keys.company_id AND c.user_id = auth.uid()
  )
);
-- INSERT/UPDATE/DELETE : service_role seul (depuis l'API).

COMMENT ON TABLE public.external_api_keys IS
  'Tokens API utilisés par les apps OWL externes (IOCAR, ...) pour pousser des factures dans IOBILL au nom d''un user.';

-- FIN migration v8.36 + v8.37
