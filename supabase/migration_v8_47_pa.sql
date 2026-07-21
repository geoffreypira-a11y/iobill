-- ════════════════════════════════════════════════════════════════
-- IO BILL — migration v8.47 : Plateforme Agréée (émission + réception)
-- Projet Supabase IOBILL : ktezoouusydsvzcvwvma
--
-- ⚠️ Les colonnes pdp_provider / pdp_transmission_id / pdp_transmitted_at
--    et facturx_status EXISTENT DÉJÀ sur invoices (01_schema.sql).
--    On les réutilise — rien à ajouter côté invoices.
-- ════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 1. Credentials PA (aucune policy ⇒ service_role uniquement)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pa_credentials (
  company_id            UUID PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  provider              TEXT NOT NULL DEFAULT 'superpdp',   -- superpdp | mock
  environment           TEXT NOT NULL DEFAULT 'sandbox',    -- sandbox | production
  base_url              TEXT,
  client_id             TEXT,
  client_secret         TEXT,
  webhook_secret        TEXT,
  enabled               BOOLEAN NOT NULL DEFAULT FALSE,

  -- Version 1 : verrou par défaut, dérogation possible par abonné
  self_service_allowed  BOOLEAN NOT NULL DEFAULT FALSE,
  managed_by_admin      BOOLEAN NOT NULL DEFAULT FALSE,

  cursor_id             BIGINT DEFAULT 0,   -- curseur starting_after_id
  last_error            TEXT,
  last_auth_ok_at       TIMESTAMPTZ,
  updated_by            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.pa_credentials ENABLE ROW LEVEL SECURITY;
-- Volontairement AUCUNE policy : les secrets ne sortent jamais via PostgREST.
-- Le front passe par /api/admin qui filtre avec publicCfg().

-- ────────────────────────────────────────────────────────────────
-- 2. Demandes de modification (abonné → admin)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pa_credential_requests (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id   UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id      UUID,
  message      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | done | rejected
  admin_note   TEXT,
  resolved_at  TIMESTAMPTZ,
  resolved_by  UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pa_req_pending
  ON public.pa_credential_requests(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pa_req_one_pending
  ON public.pa_credential_requests(company_id) WHERE status = 'pending';

ALTER TABLE public.pa_credential_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pa_req_select_own ON public.pa_credential_requests;
CREATE POLICY pa_req_select_own ON public.pa_credential_requests
  FOR SELECT TO authenticated
  USING (company_id IN (SELECT id FROM public.companies WHERE user_id = auth.uid()));

-- ────────────────────────────────────────────────────────────────
-- 3. Factures reçues
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pa_inbound_invoices (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id           UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL DEFAULT 'superpdp',
  pa_document_id       TEXT NOT NULL,

  supplier_name        TEXT,
  supplier_siren       TEXT,
  supplier_siret       TEXT,
  supplier_vat_number  TEXT,

  invoice_number       TEXT,
  invoice_date         DATE,
  due_date             DATE,
  currency             TEXT NOT NULL DEFAULT 'EUR',
  subtotal_ht_cents    BIGINT NOT NULL DEFAULT 0,
  vat_total_cents      BIGINT NOT NULL DEFAULT 0,
  total_ttc_cents      BIGINT NOT NULL DEFAULT 0,
  vat_breakdown        JSONB,
  lines                JSONB,

  format               TEXT,
  file_url             TEXT,   -- path dans le bucket pa-inbound

  status               TEXT NOT NULL DEFAULT 'received',
                       -- received | approved | refused | converted
  refusal_reason       TEXT,
  purchase_id          UUID REFERENCES public.purchases(id) ON DELETE SET NULL,

  pa_ack_status        TEXT,
  pa_ack_sent_at       TIMESTAMPTZ,

  raw_payload          JSONB,
  received_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (company_id, provider, pa_document_id)
);

CREATE INDEX IF NOT EXISTS idx_pa_inbound_company
  ON public.pa_inbound_invoices(company_id, status, received_at DESC);

ALTER TABLE public.pa_inbound_invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pa_inbound_select ON public.pa_inbound_invoices;
CREATE POLICY pa_inbound_select ON public.pa_inbound_invoices
  FOR SELECT TO authenticated
  USING (
    company_id IN (SELECT id FROM public.companies WHERE user_id = auth.uid())
    OR public.firm_can_read(company_id)
  );

-- ────────────────────────────────────────────────────────────────
-- 4. Journal d'audit (traçabilité fiscale + qui a touché aux codes)
-- ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pa_events (
  id              BIGSERIAL PRIMARY KEY,
  company_id      UUID REFERENCES public.companies(id) ON DELETE CASCADE,
  direction       TEXT NOT NULL,          -- outbound | inbound | admin
  provider        TEXT,
  pa_document_id  TEXT,
  invoice_id      UUID,
  inbound_id      UUID,
  event_type      TEXT NOT NULL,
  status          TEXT,
  message         TEXT,
  payload         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pa_events_company
  ON public.pa_events(company_id, created_at DESC);

ALTER TABLE public.pa_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pa_events_select ON public.pa_events;
CREATE POLICY pa_events_select ON public.pa_events
  FOR SELECT TO authenticated
  USING (
    company_id IN (SELECT id FROM public.companies WHERE user_id = auth.uid())
    OR public.firm_can_read(company_id)
  );

-- ────────────────────────────────────────────────────────────────
-- 5. updated_at
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.pa_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_pa_creds_touch ON public.pa_credentials;
CREATE TRIGGER trg_pa_creds_touch BEFORE UPDATE ON public.pa_credentials
  FOR EACH ROW EXECUTE FUNCTION public.pa_touch_updated_at();

DROP TRIGGER IF EXISTS trg_pa_inbound_touch ON public.pa_inbound_invoices;
CREATE TRIGGER trg_pa_inbound_touch BEFORE UPDATE ON public.pa_inbound_invoices
  FOR EACH ROW EXECUTE FUNCTION public.pa_touch_updated_at();

-- ════════════════════════════════════════════════════════════════
-- FIN. Créer ensuite le bucket "pa-inbound" (PRIVÉ, 25 MB).
-- ════════════════════════════════════════════════════════════════
