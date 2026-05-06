-- ═══════════════════════════════════════════════════════════════════════════
--  IO BILL - Migration V1.1 : Cabinet, multi-users, multi-devises, PDP, SMS
--  À exécuter APRÈS 04_public_tokens.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────
-- 1) MULTI-UTILISATEURS + ROLES
-- ───────────────────────────────────────────────────────────────────
-- Table de jonction company_users : un user peut appartenir a plusieurs companies
-- avec un role differencie (owner / admin / accountant / readonly).
CREATE TABLE IF NOT EXISTS public.company_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID,                                                 -- NULL tant qu'invitation pas acceptee
  role TEXT NOT NULL CHECK (role IN ('owner','admin','accountant','readonly')),
  invited_email TEXT,
  invited_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  -- Une invitation par email (une fois acceptee, user_id+company_id deviennent uniques via index partiel)
  UNIQUE(company_id, invited_email)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cu_unique_user
  ON public.company_users(company_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cu_user ON public.company_users(user_id);
CREATE INDEX IF NOT EXISTS idx_cu_company ON public.company_users(company_id);

-- Migration douce : pour chaque company existante, on cree une ligne owner
INSERT INTO public.company_users (company_id, user_id, role, accepted_at)
SELECT id, user_id, 'owner', created_at
FROM public.companies
WHERE user_id IS NOT NULL
ON CONFLICT (company_id, user_id) DO NOTHING;

-- ───────────────────────────────────────────────────────────────────
-- 2) PORTAIL CABINET MULTI-CLIENTS (plan V1.2)
-- ───────────────────────────────────────────────────────────────────
-- Une "firm" = un cabinet d'expertise comptable qui supervise plusieurs companies clientes
CREATE TABLE IF NOT EXISTS public.firms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name TEXT NOT NULL,
  trade_name TEXT,
  email TEXT,
  phone TEXT,
  siret TEXT,
  address_line1 TEXT,
  postal_code TEXT,
  city TEXT,
  country TEXT DEFAULT 'FR',
  brand_color TEXT DEFAULT '#d4a843',
  logo_url TEXT,
  -- Stripe abonnement Cabinet (19,90 €/mois ou 199 €/an)
  stripe_customer_id TEXT,
  stripe_sub_id TEXT,
  stripe_sub_status TEXT,
  -- Limites
  max_clients INTEGER DEFAULT 50,
  client_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Membres d'un cabinet
CREATE TABLE IF NOT EXISTS public.firm_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('partner','accountant','assistant')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(firm_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_fu_user ON public.firm_users(user_id);

-- Lien : un cabinet peut superviser N companies
CREATE TABLE IF NOT EXISTS public.firm_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Niveau d'acces : viewer (lecture seule) | editor (peut creer factures/relances)
  access_level TEXT NOT NULL DEFAULT 'viewer' CHECK (access_level IN ('viewer','editor')),
  invited_by UUID,
  invited_at TIMESTAMPTZ DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  -- Le client peut a tout moment revoquer l'acces du cabinet
  revoked_at TIMESTAMPTZ,
  UNIQUE(firm_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_fc_firm ON public.firm_clients(firm_id);
CREATE INDEX IF NOT EXISTS idx_fc_company ON public.firm_clients(company_id);

-- ───────────────────────────────────────────────────────────────────
-- 3) MULTI-DEVISES + TVA EXPORT
-- ───────────────────────────────────────────────────────────────────
-- Sur invoices/quotes/credit_notes : si la devise n'est pas EUR, on stocke
-- le taux de change utilise pour figer la conversion EUR (compta toujours en EUR).
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(12,6);
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS exchange_rate_date DATE;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS subtotal_ht_eur_cents BIGINT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS vat_total_eur_cents BIGINT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS total_ttc_eur_cents BIGINT;

ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(12,6);
ALTER TABLE public.credit_notes ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(12,6);

-- Categorie TVA : standard | export_eu_b2b | export_outside_eu | reverse_charge
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS vat_category TEXT DEFAULT 'standard';
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS vat_category TEXT DEFAULT 'standard';

-- Mention legale obligatoire selon la categorie
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS vat_legal_mention TEXT;
ALTER TABLE public.quotes ADD COLUMN IF NOT EXISTS vat_legal_mention TEXT;

-- ───────────────────────────────────────────────────────────────────
-- 4) E-INVOICING / E-REPORTING (PDP)
-- ───────────────────────────────────────────────────────────────────
-- Trace des transmissions PDP (obligation 2026/2027)
CREATE TABLE IF NOT EXISTS public.pdp_transmissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('invoice','credit_note','e_reporting')),
  document_id UUID,
  -- Provider PDP utilise (iopole / generix / cegid / sage / ppf)
  provider TEXT NOT NULL,
  -- Statut : queued | submitted | accepted | rejected | error
  status TEXT NOT NULL DEFAULT 'queued',
  pdp_reference TEXT,         -- ID renvoye par le PDP
  ppf_reference TEXT,         -- ID dans le Portail Public de Facturation
  -- Payload XML envoye (compresse) + reponse PDP
  payload_xml TEXT,
  response_data JSONB,
  -- Statut du destinataire : received | read | paid | refused
  recipient_status TEXT,
  -- Audit
  submitted_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pdp_company ON public.pdp_transmissions(company_id);
CREATE INDEX IF NOT EXISTS idx_pdp_doc ON public.pdp_transmissions(document_type, document_id);
CREATE INDEX IF NOT EXISTS idx_pdp_status ON public.pdp_transmissions(status);

-- Stocke la config PDP par societe
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS pdp_provider TEXT;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS pdp_account_id TEXT;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS pdp_api_key_encrypted TEXT;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS pdp_enabled BOOLEAN DEFAULT FALSE;

-- ───────────────────────────────────────────────────────────────────
-- 5) RELANCES SMS
-- ───────────────────────────────────────────────────────────────────
-- Activer les relances SMS par societe (pas tout le monde en a l'usage)
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS sms_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS sms_provider TEXT DEFAULT 'ovh';
-- Compteur SMS du mois en cours (reset cron mensuel) — pour billing
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS sms_count_month INTEGER DEFAULT 0;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS sms_reset_at DATE;

-- Telephone du contact client (pour SMS)
-- Deja present sous forme phone dans clients, on s'en sert.

-- Trace des SMS envoyes
CREATE TABLE IF NOT EXISTS public.sms_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id UUID,
  recipient_phone TEXT NOT NULL,
  message TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_ref TEXT,
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | sent | delivered | failed
  error_message TEXT,
  sent_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sms_company ON public.sms_log(company_id);
CREATE INDEX IF NOT EXISTS idx_sms_invoice ON public.sms_log(invoice_id);

-- ───────────────────────────────────────────────────────────────────
-- 6) INBOX EMAIL OCR
-- ───────────────────────────────────────────────────────────────────
-- Chaque company a une adresse email unique pour recevoir des factures fournisseurs
-- ex: achats-3f7a@inbox.iobill.fr -> Cloudflare Email Routing -> /api/inbox-purchase
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS inbox_alias TEXT UNIQUE;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS inbox_enabled BOOLEAN DEFAULT FALSE;

-- Trace des emails recus (avant OCR)
CREATE TABLE IF NOT EXISTS public.inbox_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  sender_email TEXT,
  subject TEXT,
  attachment_count INTEGER DEFAULT 0,
  -- Statut : received | processed | failed | rejected (pas attachment)
  status TEXT NOT NULL DEFAULT 'received',
  purchase_ids UUID[],     -- les achats crees a partir de cet email
  error_message TEXT,
  raw_size_bytes INTEGER,
  received_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inbox_company ON public.inbox_messages(company_id);
CREATE INDEX IF NOT EXISTS idx_inbox_alias ON public.inbox_messages(alias);

-- ───────────────────────────────────────────────────────────────────
-- 7) OBSERVABILITE — events produit + module usage
-- ───────────────────────────────────────────────────────────────────
-- Aggregat journalier d'usage par societe (rempli par le frontend posthog OU
-- par triggers internes). Pour le dashboard admin "Stats produit".
CREATE TABLE IF NOT EXISTS public.module_usage_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  module_key TEXT NOT NULL,
  event_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(company_id, day, module_key)
);
CREATE INDEX IF NOT EXISTS idx_usage_day ON public.module_usage_daily(day);
CREATE INDEX IF NOT EXISTS idx_usage_module ON public.module_usage_daily(module_key);

-- Increment safe via RPC
CREATE OR REPLACE FUNCTION public.bump_module_usage(p_company_id UUID, p_module TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.module_usage_daily (company_id, day, module_key, event_count)
  VALUES (p_company_id, CURRENT_DATE, p_module, 1)
  ON CONFLICT (company_id, day, module_key)
  DO UPDATE SET event_count = module_usage_daily.event_count + 1;
END $$;
GRANT EXECUTE ON FUNCTION public.bump_module_usage(UUID, TEXT) TO authenticated;

-- Vue admin : taux d'adoption modules (sur 30j glissants)
CREATE OR REPLACE VIEW public.v_module_adoption AS
SELECT
  module_key,
  COUNT(DISTINCT company_id) AS active_companies,
  SUM(event_count) AS total_events
FROM public.module_usage_daily
WHERE day >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY module_key
ORDER BY active_companies DESC;

-- Vue admin : taux de conversion devis -> facture (90j glissants)
CREATE OR REPLACE VIEW public.v_quote_conversion AS
SELECT
  c.id AS company_id,
  c.legal_name,
  COUNT(q.id) AS quotes_sent,
  COUNT(q.id) FILTER (WHERE q.status IN ('signed','converted')) AS quotes_won,
  COUNT(q.id) FILTER (WHERE q.status = 'converted') AS quotes_converted,
  ROUND(100.0 * COUNT(q.id) FILTER (WHERE q.status IN ('signed','converted')) / NULLIF(COUNT(q.id), 0), 1) AS win_rate_pct
FROM public.companies c
LEFT JOIN public.quotes q ON q.company_id = c.id
  AND q.issue_date >= CURRENT_DATE - INTERVAL '90 days'
  AND q.status != 'draft'
GROUP BY c.id, c.legal_name
HAVING COUNT(q.id) > 0;

-- ───────────────────────────────────────────────────────────────────
-- 8) RLS pour les nouvelles tables
-- ───────────────────────────────────────────────────────────────────
ALTER TABLE public.company_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firm_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firm_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pdp_transmissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.module_usage_daily ENABLE ROW LEVEL SECURITY;

-- company_users : un user voit ses propres lignes
DROP POLICY IF EXISTS "cu_select_own" ON public.company_users;
CREATE POLICY "cu_select_own" ON public.company_users
  FOR SELECT USING (user_id = auth.uid() OR public.is_admin());

DROP POLICY IF EXISTS "cu_insert_owner" ON public.company_users;
CREATE POLICY "cu_insert_owner" ON public.company_users
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.company_users WHERE company_id = NEW.company_id
            AND user_id = auth.uid() AND role IN ('owner','admin'))
    OR public.is_admin()
  );

-- firms : visible par les firm_users
DROP POLICY IF EXISTS "firms_select_member" ON public.firms;
CREATE POLICY "firms_select_member" ON public.firms
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.firm_users fu WHERE fu.firm_id = firms.id AND fu.user_id = auth.uid())
    OR public.is_admin()
  );

DROP POLICY IF EXISTS "firms_insert_self" ON public.firms;
CREATE POLICY "firms_insert_self" ON public.firms
  FOR INSERT WITH CHECK (true); -- tout user authentifie peut creer un firm

DROP POLICY IF EXISTS "firms_update_partner" ON public.firms;
CREATE POLICY "firms_update_partner" ON public.firms
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.firm_users fu WHERE fu.firm_id = firms.id
            AND fu.user_id = auth.uid() AND fu.role = 'partner')
    OR public.is_admin()
  );

-- firm_users : visible par les autres membres du meme firm
DROP POLICY IF EXISTS "fu_select_same_firm" ON public.firm_users;
CREATE POLICY "fu_select_same_firm" ON public.firm_users
  FOR SELECT USING (
    user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.firm_users fu2 WHERE fu2.firm_id = firm_users.firm_id AND fu2.user_id = auth.uid())
    OR public.is_admin()
  );

-- firm_clients : visible par les firm_users du firm OU les company_users de la company
DROP POLICY IF EXISTS "fc_select" ON public.firm_clients;
CREATE POLICY "fc_select" ON public.firm_clients
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.firm_users fu WHERE fu.firm_id = firm_clients.firm_id AND fu.user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.company_users cu WHERE cu.company_id = firm_clients.company_id AND cu.user_id = auth.uid())
    OR public.is_admin()
  );

-- PDP transmissions : meme RLS que les autres tables company-scopees
DROP POLICY IF EXISTS "pdp_select_own" ON public.pdp_transmissions;
CREATE POLICY "pdp_select_own" ON public.pdp_transmissions
  FOR SELECT USING (company_id = public.current_company_id() OR public.is_admin());

-- SMS log : idem
DROP POLICY IF EXISTS "sms_select_own" ON public.sms_log;
CREATE POLICY "sms_select_own" ON public.sms_log
  FOR SELECT USING (company_id = public.current_company_id() OR public.is_admin());

-- Inbox : idem
DROP POLICY IF EXISTS "inbox_select_own" ON public.inbox_messages;
CREATE POLICY "inbox_select_own" ON public.inbox_messages
  FOR SELECT USING (company_id = public.current_company_id() OR public.is_admin());

-- module_usage : visible uniquement par l'admin platform et la societe concernee
DROP POLICY IF EXISTS "usage_select" ON public.module_usage_daily;
CREATE POLICY "usage_select" ON public.module_usage_daily
  FOR SELECT USING (company_id = public.current_company_id() OR public.is_admin());

-- ───────────────────────────────────────────────────────────────────
-- 9) Helper : current_company_id() étendu pour multi-companies
-- ───────────────────────────────────────────────────────────────────
-- L'ancienne version regardait companies.user_id. Avec multi-users, on doit
-- regarder company_users. On etend la fonction pour rester compatible.
-- Le mode est : current_company_id() = la company "active" du user
-- (premiere company dont il est membre — V1.1 single context)
CREATE OR REPLACE FUNCTION public.current_company_id()
RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id UUID;
BEGIN
  -- 1) Essai via company_users (multi-tenant V1.1)
  SELECT cu.company_id INTO v_id
  FROM public.company_users cu
  WHERE cu.user_id = auth.uid() AND cu.accepted_at IS NOT NULL
  ORDER BY cu.created_at ASC
  LIMIT 1;

  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  -- 2) Fallback : company.user_id (single-user V1)
  SELECT id INTO v_id FROM public.companies WHERE user_id = auth.uid() LIMIT 1;
  RETURN v_id;
END $$;

-- Fonction utilitaire : le user a-t-il un role minimum sur la company ?
CREATE OR REPLACE FUNCTION public.has_company_role(p_company_id UUID, p_min_role TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_role TEXT;
  v_rank INTEGER;
  v_min_rank INTEGER;
BEGIN
  SELECT role INTO v_role FROM public.company_users
   WHERE company_id = p_company_id AND user_id = auth.uid() AND accepted_at IS NOT NULL;
  IF v_role IS NULL THEN RETURN FALSE; END IF;
  v_rank := CASE v_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'accountant' THEN 2 WHEN 'readonly' THEN 1 ELSE 0 END;
  v_min_rank := CASE p_min_role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 WHEN 'accountant' THEN 2 WHEN 'readonly' THEN 1 ELSE 0 END;
  RETURN v_rank >= v_min_rank;
END $$;

GRANT EXECUTE ON FUNCTION public.has_company_role(UUID, TEXT) TO authenticated;

-- Increment client_count d'un firm de maniere safe
CREATE OR REPLACE FUNCTION public.firm_client_count_inc(p_firm_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.firms
     SET client_count = (
       SELECT COUNT(*) FROM public.firm_clients
       WHERE firm_id = p_firm_id AND accepted_at IS NOT NULL AND revoked_at IS NULL
     )
   WHERE id = p_firm_id;
END $$;
GRANT EXECUTE ON FUNCTION public.firm_client_count_inc(UUID) TO authenticated;

-- ───────────────────────────────────────────────────────────────────
-- 10) Generation auto de l'inbox alias quand on cree une company
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generate_inbox_alias()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.inbox_alias IS NULL THEN
    -- ex: achats-3f7a91@inbox.iobill.fr  (suffixe stable / collision quasi nulle)
    NEW.inbox_alias := 'achats-' || substr(NEW.id::text, 1, 8) || '@inbox.iobill.fr';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_company_inbox_alias ON public.companies;
CREATE TRIGGER trg_company_inbox_alias
  BEFORE INSERT ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.generate_inbox_alias();

-- Backfill pour companies existantes
UPDATE public.companies
   SET inbox_alias = 'achats-' || substr(id::text, 1, 8) || '@inbox.iobill.fr'
 WHERE inbox_alias IS NULL;

-- ───────────────────────────────────────────────────────────────────
-- 11) Auto-acceptance des invitations company_users + firm_users
-- ───────────────────────────────────────────────────────────────────
-- Quand un user se crée dans auth.users, on regarde s'il y a des invitations
-- en attente avec son email, et on resout user_id + accepted_at.
CREATE OR REPLACE FUNCTION public.resolve_pending_invitations()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- company_users
  UPDATE public.company_users
     SET user_id = NEW.id, accepted_at = NOW()
   WHERE invited_email = NEW.email AND user_id IS NULL;

  -- firm_users (sur invitations futures)
  UPDATE public.firm_users
     SET user_id = NEW.id
   WHERE user_id IS NULL
     AND firm_id IN (SELECT firm_id FROM public.firm_users WHERE user_id = NEW.id);

  RETURN NEW;
END $$;

-- Le trigger doit etre cree dans le schema auth (necessite super-user)
-- Si Supabase Pro : ce trigger sera installable.
-- Sinon : un cron RPC qui scanne les nouveaux users (V1.2).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'auth' AND table_name = 'users') THEN
    -- Tentative de creation du trigger (peut echouer en mode managed sans super-user)
    BEGIN
      DROP TRIGGER IF EXISTS trg_resolve_invitations ON auth.users;
      CREATE TRIGGER trg_resolve_invitations
        AFTER INSERT ON auth.users
        FOR EACH ROW EXECUTE FUNCTION public.resolve_pending_invitations();
    EXCEPTION WHEN insufficient_privilege OR undefined_object THEN
      RAISE NOTICE 'Trigger auth.users non installable (manque privilege super-user). Utiliser /api/team-resolve-invitations en cron a la place.';
    END;
  END IF;
END $$;

-- FIN 05_v11_extensions.sql
