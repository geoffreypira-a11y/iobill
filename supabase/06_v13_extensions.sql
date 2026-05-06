-- ═══════════════════════════════════════════════════════════════════════════
--  IO BILL - Migration V1.3 : push notifs, IA lettrage, devis versions, API publique
--  À exécuter APRÈS 05_v11_extensions.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────
-- 1) WEB PUSH SUBSCRIPTIONS (notifications PWA)
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh_key TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_user ON public.push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_push_company ON public.push_subscriptions(company_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "push_select_own" ON public.push_subscriptions;
CREATE POLICY "push_select_own" ON public.push_subscriptions
  FOR SELECT USING (user_id = auth.uid() OR public.is_admin());
DROP POLICY IF EXISTS "push_insert_own" ON public.push_subscriptions;
CREATE POLICY "push_insert_own" ON public.push_subscriptions
  FOR INSERT WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS "push_delete_own" ON public.push_subscriptions;
CREATE POLICY "push_delete_own" ON public.push_subscriptions
  FOR DELETE USING (user_id = auth.uid());

-- ───────────────────────────────────────────────────────────────────
-- 2) AUTO-LETTRAGE BANCAIRE (matching IA)
-- ───────────────────────────────────────────────────────────────────
-- On stocke les suggestions de matching pour validation par l'utilisateur.
-- Stratégie : un cron analyse les bank_transactions non rapprochées et
-- produit des suggestions classées par confidence_score (0..1).
CREATE TABLE IF NOT EXISTS public.bank_match_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  bank_transaction_id UUID NOT NULL,
  -- Type de matching : invoice (facture cliente) | purchase (achat fournisseur) | other
  match_type TEXT NOT NULL CHECK (match_type IN ('invoice','purchase','other')),
  match_id UUID,                              -- id de la facture ou de l'achat
  confidence_score NUMERIC(3,2),              -- 0.00 à 1.00
  reasoning TEXT,                             -- explication LLM
  status TEXT NOT NULL DEFAULT 'pending'      -- pending | accepted | rejected
    CHECK (status IN ('pending','accepted','rejected')),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bms_company ON public.bank_match_suggestions(company_id);
CREATE INDEX IF NOT EXISTS idx_bms_tx ON public.bank_match_suggestions(bank_transaction_id);
CREATE INDEX IF NOT EXISTS idx_bms_status ON public.bank_match_suggestions(status);

ALTER TABLE public.bank_match_suggestions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bms_select_own" ON public.bank_match_suggestions;
CREATE POLICY "bms_select_own" ON public.bank_match_suggestions
  FOR SELECT USING (company_id = public.current_company_id() OR public.is_admin());

-- Marquer une transaction bancaire comme rapprochée (lien vers facture ou achat)
ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS matched_invoice_id UUID;
ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS matched_purchase_id UUID;
ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS matched_at TIMESTAMPTZ;
ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS matched_by UUID;
CREATE INDEX IF NOT EXISTS idx_btx_matched_inv ON public.bank_transactions(matched_invoice_id) WHERE matched_invoice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_btx_matched_pur ON public.bank_transactions(matched_purchase_id) WHERE matched_purchase_id IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────
-- 3) DEVIS MULTI-VERSIONS
-- ───────────────────────────────────────────────────────────────────
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS root_quote_id UUID;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS superseded_by_id UUID;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_quotes_root ON public.quotes(root_quote_id) WHERE root_quote_id IS NOT NULL;

-- Init : pour chaque devis existant, root = self
UPDATE public.quotes SET root_quote_id = id WHERE root_quote_id IS NULL;

-- ───────────────────────────────────────────────────────────────────
-- 4) API PUBLIQUE (clés API par société)
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Le hash de la cle (la cle en clair n'est jamais stockee)
  key_hash TEXT NOT NULL UNIQUE,
  -- Préfixe affichage : iobill_live_abc... (pour identifier dans dashboard)
  key_prefix TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Scopes : "read", "write", "admin"
  scopes TEXT[] NOT NULL DEFAULT ARRAY['read'],
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  last_used_ip INET,
  revoked_at TIMESTAMPTZ,
  -- Limite d'usage
  rate_limit_per_minute INTEGER DEFAULT 60
);
CREATE INDEX IF NOT EXISTS idx_apikeys_company ON public.api_keys(company_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_apikeys_hash ON public.api_keys(key_hash) WHERE revoked_at IS NULL;

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "apikeys_select_own" ON public.api_keys;
CREATE POLICY "apikeys_select_own" ON public.api_keys
  FOR SELECT USING (company_id = public.current_company_id() OR public.is_admin());
DROP POLICY IF EXISTS "apikeys_insert_admin" ON public.api_keys;
CREATE POLICY "apikeys_insert_admin" ON public.api_keys
  FOR INSERT WITH CHECK (
    company_id = public.current_company_id()
    AND public.has_company_role(company_id, 'admin')
  );
DROP POLICY IF EXISTS "apikeys_update_admin" ON public.api_keys;
CREATE POLICY "apikeys_update_admin" ON public.api_keys
  FOR UPDATE USING (public.has_company_role(company_id, 'admin'));

-- Trace des requetes API (ratelimit + audit)
CREATE TABLE IF NOT EXISTS public.api_request_log (
  id BIGSERIAL PRIMARY KEY,
  api_key_id UUID REFERENCES public.api_keys(id) ON DELETE CASCADE,
  company_id UUID,
  method TEXT,
  path TEXT,
  status_code INTEGER,
  duration_ms INTEGER,
  ip INET,
  request_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_apilog_key ON public.api_request_log(api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_apilog_company ON public.api_request_log(company_id, created_at DESC);

-- Fonction RPC: incrementer last_used d'une cle
CREATE OR REPLACE FUNCTION public.api_key_touch(p_key_hash TEXT, p_ip INET)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.api_keys
     SET last_used_at = NOW(), last_used_ip = p_ip
   WHERE key_hash = p_key_hash AND revoked_at IS NULL;
END $$;

-- ───────────────────────────────────────────────────────────────────
-- 5) WEBHOOKS BRIDGE (suivi des notifications recues)
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bridge_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,            -- account.synced | item.refresh.completed | etc
  bridge_user_uuid TEXT,
  bridge_account_id BIGINT,
  bridge_item_id BIGINT,
  payload JSONB,
  status TEXT NOT NULL DEFAULT 'received',  -- received | processed | failed | ignored
  company_id UUID,
  imported_count INTEGER,
  error_message TEXT,
  received_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bwe_company ON public.bridge_webhook_events(company_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_bwe_status ON public.bridge_webhook_events(status);

-- bank_connections : ajouter l'identifiant Bridge user pour matcher webhooks
ALTER TABLE public.bank_connections ADD COLUMN IF NOT EXISTS bridge_user_uuid TEXT;
ALTER TABLE public.bank_connections ADD COLUMN IF NOT EXISTS last_webhook_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_bcon_bridge_user ON public.bank_connections(bridge_user_uuid)
  WHERE bridge_user_uuid IS NOT NULL;

-- FIN 06_v13_extensions.sql
