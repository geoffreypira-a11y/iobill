-- ═══════════════════════════════════════════════════════════
-- IO BILL — Migration v8.11 — Notifications + Dashboard fix
-- ═══════════════════════════════════════════════════════════
-- 1) Recreation de dashboard_stats (au cas ou pas deployee)
-- 2) Tables notifications + notification_preferences
-- 3) Helpers SQL pour creer des notifs
-- 4) Triggers automatiques (devis signe/refuse, etc.)
-- ═══════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────
-- 1) RECREATE dashboard_stats (au cas ou absente)
-- ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.dashboard_stats(p_company_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions STABLE AS $$
DECLARE
  v_company_id UUID := COALESCE(p_company_id, public.current_company_id());
  v_month_start DATE := DATE_TRUNC('month', CURRENT_DATE)::DATE;
  v_year_start DATE := DATE_TRUNC('year', CURRENT_DATE)::DATE;
  v_stats JSONB;
BEGIN
  IF v_company_id IS NULL THEN RETURN '{}'::JSONB; END IF;

  SELECT jsonb_build_object(
    'ca_ht_month_cents', COALESCE((
      SELECT SUM(subtotal_ht_cents) FROM public.invoices
      WHERE company_id = v_company_id
        AND status IN ('issued','sent','partial','paid','overdue')
        AND issue_date >= v_month_start
    ), 0),
    'ca_ht_year_cents', COALESCE((
      SELECT SUM(subtotal_ht_cents) FROM public.invoices
      WHERE company_id = v_company_id
        AND status IN ('issued','sent','partial','paid','overdue')
        AND issue_date >= v_year_start
    ), 0),
    'unpaid_cents', COALESCE((
      SELECT SUM(total_ttc_cents - paid_cents) FROM public.invoices
      WHERE company_id = v_company_id
        AND status IN ('issued','sent','partial','overdue')
    ), 0),
    'unpaid_count', COALESCE((
      SELECT COUNT(*) FROM public.invoices
      WHERE company_id = v_company_id
        AND status IN ('issued','sent','partial','overdue')
    ), 0),
    'overdue_cents', COALESCE((
      SELECT SUM(total_ttc_cents - paid_cents) FROM public.invoices
      WHERE company_id = v_company_id
        AND status IN ('issued','sent','partial','overdue')
        AND due_date < CURRENT_DATE
    ), 0),
    'vat_collected_pending_cents', COALESCE((
      SELECT SUM(vat_total_cents) FROM public.invoices
      WHERE company_id = v_company_id
        AND status IN ('issued','sent','partial','paid','overdue')
        AND issue_date >= v_month_start
    ), 0),
    'clients_total', COALESCE((SELECT COUNT(*) FROM public.clients WHERE company_id = v_company_id), 0),
    'clients_active', COALESCE((SELECT COUNT(*) FROM public.clients WHERE company_id = v_company_id AND status IN ('customer','vip')), 0),
    'quotes_pending', COALESCE((SELECT COUNT(*) FROM public.quotes WHERE company_id = v_company_id AND status = 'sent'), 0),
    'dso_days', COALESCE((
      SELECT ROUND(AVG(EXTRACT(EPOCH FROM (p.paid_at - i.issue_date)) / 86400)::NUMERIC, 1)
      FROM public.invoices i
      JOIN public.payments p ON p.invoice_id = i.id
      WHERE i.company_id = v_company_id
        AND i.status = 'paid'
        AND i.issue_date >= v_year_start
    ), 0)
  ) INTO v_stats;

  RETURN v_stats;
END $$;

GRANT EXECUTE ON FUNCTION public.dashboard_stats(UUID) TO authenticated;


-- ───────────────────────────────────────────────────────────
-- 2) TABLE notifications
-- ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES auth.users(id) ON DELETE CASCADE,  -- NULL = pour toute la company
  notif_type    TEXT NOT NULL,            -- ex: 'quote_accepted', 'invoice_overdue', etc.
  title         TEXT NOT NULL,
  body          TEXT,
  url           TEXT,                     -- URL interne (/quotes/xyz, /invoices/xyz)
  severity      TEXT NOT NULL DEFAULT 'info', -- 'info' | 'success' | 'warning' | 'critical'
  icon          TEXT,                     -- emoji a afficher
  metadata      JSONB DEFAULT '{}'::JSONB,
  read_at       TIMESTAMPTZ,
  email_sent_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_company_unread
  ON public.notifications (company_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_company_all
  ON public.notifications (company_id, created_at DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notifications_select" ON public.notifications;
CREATE POLICY "notifications_select" ON public.notifications
  FOR SELECT USING (company_id = public.current_company_id() OR public.is_admin());

DROP POLICY IF EXISTS "notifications_update" ON public.notifications;
CREATE POLICY "notifications_update" ON public.notifications
  FOR UPDATE USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());

DROP POLICY IF EXISTS "notifications_delete" ON public.notifications;
CREATE POLICY "notifications_delete" ON public.notifications
  FOR DELETE USING (company_id = public.current_company_id());

-- INSERT : seul le service_role peut creer des notifs (via triggers ou API)


-- ───────────────────────────────────────────────────────────
-- 3) TABLE notification_preferences
-- ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.notification_preferences (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  notif_type    TEXT NOT NULL,
  in_app        BOOLEAN NOT NULL DEFAULT TRUE,  -- afficher dans la cloche
  email         BOOLEAN NOT NULL DEFAULT TRUE,  -- envoyer aussi par email
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, notif_type)
);

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notif_prefs_all" ON public.notification_preferences;
CREATE POLICY "notif_prefs_all" ON public.notification_preferences
  FOR ALL USING (company_id = public.current_company_id())
  WITH CHECK (company_id = public.current_company_id());


-- ───────────────────────────────────────────────────────────
-- 4) HELPER : create_notification (utilisable depuis triggers ou API)
-- ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_notification(
  p_company_id UUID,
  p_notif_type TEXT,
  p_title TEXT,
  p_body TEXT DEFAULT NULL,
  p_url TEXT DEFAULT NULL,
  p_severity TEXT DEFAULT 'info',
  p_icon TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::JSONB
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pref RECORD;
  v_id UUID;
BEGIN
  -- Recuperer les preferences pour ce type (defaut : tout activé)
  SELECT in_app, email INTO v_pref
  FROM public.notification_preferences
  WHERE company_id = p_company_id AND notif_type = p_notif_type;

  -- Si pas de preferences, on insere quand meme (defaut: in_app=true)
  IF v_pref IS NULL OR v_pref.in_app THEN
    INSERT INTO public.notifications (
      company_id, notif_type, title, body, url, severity, icon, metadata
    ) VALUES (
      p_company_id, p_notif_type, p_title, p_body, p_url, p_severity, p_icon, p_metadata
    ) RETURNING id INTO v_id;
  END IF;

  -- NOTE : email_sent_at sera mis a jour par le job/api d'envoi email
  -- qui regardera read_at IS NULL AND email_sent_at IS NULL pour determiner
  -- quoi envoyer (avec respect de pref.email)

  RETURN v_id;
END $$;

GRANT EXECUTE ON FUNCTION public.create_notification(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;


-- ───────────────────────────────────────────────────────────
-- 5) TRIGGERS AUTOMATIQUES
-- ───────────────────────────────────────────────────────────

-- Quote: passage en status=signed → notif "Devis accepte"
CREATE OR REPLACE FUNCTION public.notify_quote_signed()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_client_name TEXT;
BEGIN
  IF NEW.status = 'signed' AND (OLD.status IS NULL OR OLD.status <> 'signed') THEN
    v_client_name := COALESCE(NEW.signed_by_name,
                              NEW.client_snapshot->>'legal_name',
                              CONCAT_WS(' ', NEW.client_snapshot->>'first_name', NEW.client_snapshot->>'last_name'),
                              'Client');
    PERFORM public.create_notification(
      NEW.company_id,
      'quote_accepted',
      'Devis accepté',
      CONCAT('Devis ', COALESCE(NEW.number, ''), ' accepté par ', v_client_name),
      CONCAT('/quotes/', NEW.id::TEXT),
      'success',
      '✍️',
      jsonb_build_object('quote_id', NEW.id, 'quote_number', NEW.number, 'client', v_client_name)
    );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_notify_quote_signed ON public.quotes;
CREATE TRIGGER trg_notify_quote_signed
AFTER UPDATE ON public.quotes
FOR EACH ROW EXECUTE FUNCTION public.notify_quote_signed();


-- Quote: passage en status=refused → notif "Devis refuse"
CREATE OR REPLACE FUNCTION public.notify_quote_refused()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_client_name TEXT;
BEGIN
  IF NEW.status = 'refused' AND (OLD.status IS NULL OR OLD.status <> 'refused') THEN
    v_client_name := COALESCE(NEW.client_snapshot->>'legal_name',
                              CONCAT_WS(' ', NEW.client_snapshot->>'first_name', NEW.client_snapshot->>'last_name'),
                              'Client');
    PERFORM public.create_notification(
      NEW.company_id,
      'quote_refused',
      'Devis refusé',
      CONCAT('Devis ', COALESCE(NEW.number, ''), ' refusé',
             CASE WHEN NEW.refusal_reason IS NOT NULL AND LENGTH(NEW.refusal_reason) > 0
                  THEN CONCAT(' · Motif : ', NEW.refusal_reason)
                  ELSE '' END),
      CONCAT('/quotes/', NEW.id::TEXT),
      'critical',
      '❌',
      jsonb_build_object('quote_id', NEW.id, 'quote_number', NEW.number, 'client', v_client_name, 'reason', NEW.refusal_reason)
    );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_notify_quote_refused ON public.quotes;
CREATE TRIGGER trg_notify_quote_refused
AFTER UPDATE ON public.quotes
FOR EACH ROW EXECUTE FUNCTION public.notify_quote_refused();


-- Invoice: passage en status=issued → notif "Facture emise"
CREATE OR REPLACE FUNCTION public.notify_invoice_issued()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'issued' AND (OLD.status IS NULL OR OLD.status <> 'issued') THEN
    PERFORM public.create_notification(
      NEW.company_id,
      'invoice_issued',
      'Facture émise',
      CONCAT('Facture ', COALESCE(NEW.number, ''), ' émise et verrouillée'),
      CONCAT('/invoices/', NEW.id::TEXT),
      'success',
      '🔒',
      jsonb_build_object('invoice_id', NEW.id, 'invoice_number', NEW.number)
    );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_notify_invoice_issued ON public.invoices;
CREATE TRIGGER trg_notify_invoice_issued
AFTER UPDATE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.notify_invoice_issued();


-- Invoice: passage en pdp_transmitted_at NOT NULL → notif "Facture transmise"
CREATE OR REPLACE FUNCTION public.notify_invoice_pdp_transmitted()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.pdp_transmitted_at IS NOT NULL AND OLD.pdp_transmitted_at IS NULL THEN
    PERFORM public.create_notification(
      NEW.company_id,
      'invoice_pdp_transmitted',
      'Facture transmise à l''administration',
      CONCAT('Facture ', COALESCE(NEW.number, ''),
             ' transmise via ', COALESCE(NEW.pdp_provider, 'PDP'),
             ' (ID: ', COALESCE(NEW.pdp_transmission_id, '—'), ')'),
      CONCAT('/invoices/', NEW.id::TEXT),
      'success',
      '🏛️',
      jsonb_build_object('invoice_id', NEW.id, 'provider', NEW.pdp_provider)
    );
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_notify_invoice_pdp_transmitted ON public.invoices;
CREATE TRIGGER trg_notify_invoice_pdp_transmitted
AFTER UPDATE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.notify_invoice_pdp_transmitted();


-- Client: creation → notif "Nouveau client"
CREATE OR REPLACE FUNCTION public.notify_client_created()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name TEXT;
BEGIN
  v_name := COALESCE(NEW.legal_name,
                     CONCAT_WS(' ', NEW.first_name, NEW.last_name),
                     'Sans nom');
  PERFORM public.create_notification(
    NEW.company_id,
    'client_created',
    'Nouveau client',
    CONCAT('Client "', v_name, '" ajouté à votre annuaire'),
    CONCAT('/clients/', NEW.id::TEXT),
    'info',
    '🆕',
    jsonb_build_object('client_id', NEW.id, 'name', v_name)
  );
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_notify_client_created ON public.clients;
CREATE TRIGGER trg_notify_client_created
AFTER INSERT ON public.clients
FOR EACH ROW EXECUTE FUNCTION public.notify_client_created();


-- ───────────────────────────────────────────────────────────
-- 6) RPC: marquer toutes les notifs lues
-- ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mark_all_notifications_read(p_company_id UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_company_id UUID := COALESCE(p_company_id, public.current_company_id());
  v_count INTEGER;
BEGIN
  IF v_company_id IS NULL THEN RETURN 0; END IF;
  UPDATE public.notifications
  SET read_at = NOW()
  WHERE company_id = v_company_id AND read_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $$;

GRANT EXECUTE ON FUNCTION public.mark_all_notifications_read(UUID) TO authenticated;


-- ───────────────────────────────────────────────────────────
-- 7) consume_public_token : retourner use_count (utile pour notif "consulté")
-- ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.consume_public_token(p_token TEXT, p_ip INET DEFAULT NULL)
RETURNS TABLE (
  company_id UUID,
  scope TEXT,
  resource_id UUID,
  recipient_email TEXT,
  use_count INTEGER
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row RECORD;
  v_new_count INTEGER;
BEGIN
  SELECT * INTO v_row FROM public.public_tokens WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_row.revoked_at IS NOT NULL THEN RETURN; END IF;
  IF v_row.expires_at IS NOT NULL AND v_row.expires_at < NOW() THEN RETURN; END IF;
  IF v_row.max_uses IS NOT NULL AND v_row.use_count >= v_row.max_uses THEN RETURN; END IF;

  v_new_count := v_row.use_count + 1;

  UPDATE public.public_tokens
     SET use_count = v_new_count,
         last_used_at = NOW(),
         last_used_ip = p_ip
   WHERE token = p_token;

  RETURN QUERY SELECT v_row.company_id, v_row.scope, v_row.resource_id, v_row.recipient_email, v_new_count;
END $$;

GRANT EXECUTE ON FUNCTION public.consume_public_token(TEXT, INET) TO anon, authenticated;


-- ───────────────────────────────────────────────────────────
-- 8) Force PostgREST reload
-- ───────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════
-- FIN MIGRATION v8.11
-- ═══════════════════════════════════════════════════════════
