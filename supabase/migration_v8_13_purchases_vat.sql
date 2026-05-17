-- ═══════════════════════════════════════════════════════════
-- IO BILL — Migration v8.13 — Achats + TVA dashboard
-- ═══════════════════════════════════════════════════════════
-- 1) Ajoute paid_cents/payment_partial_at sur purchases
-- 2) Ajoute statut 'partial' (paiement partiel)
-- 3) Active Realtime sur purchases
-- 4) Met à jour dashboard_stats : ajout vat_deductible_pending_cents
-- ═══════════════════════════════════════════════════════════

-- 1) Ajouter colonnes paiement partiel
ALTER TABLE public.purchases
  ADD COLUMN IF NOT EXISTS paid_cents BIGINT DEFAULT 0;

ALTER TABLE public.purchases
  ADD COLUMN IF NOT EXISTS payment_partial_at TIMESTAMPTZ;

-- 2) Activer Realtime
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.purchases;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;

-- 3) Recreer dashboard_stats avec TVA nette (collectée - déductible)
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
    -- TVA collectée sur ventes (mois en cours)
    'vat_collected_pending_cents', COALESCE((
      SELECT SUM(vat_total_cents) FROM public.invoices
      WHERE company_id = v_company_id
        AND status IN ('issued','sent','partial','paid','overdue')
        AND issue_date >= v_month_start
    ), 0),
    -- TVA déductible sur achats (mois en cours)
    'vat_deductible_pending_cents', COALESCE((
      SELECT SUM(vat_total_cents) FROM public.purchases
      WHERE company_id = v_company_id
        AND status IN ('validated','paid','partial','pending')
        AND issue_date >= v_month_start
    ), 0),
    -- TVA collectée annuelle (utile pour la page TVA)
    'vat_collected_year_cents', COALESCE((
      SELECT SUM(vat_total_cents) FROM public.invoices
      WHERE company_id = v_company_id
        AND status IN ('issued','sent','partial','paid','overdue')
        AND issue_date >= v_year_start
    ), 0),
    -- TVA déductible annuelle
    'vat_deductible_year_cents', COALESCE((
      SELECT SUM(vat_total_cents) FROM public.purchases
      WHERE company_id = v_company_id
        AND status IN ('validated','paid','partial','pending')
        AND issue_date >= v_year_start
    ), 0),
    'clients_total', COALESCE((SELECT COUNT(*) FROM public.clients WHERE company_id = v_company_id), 0),
    'clients_active', COALESCE((SELECT COUNT(*) FROM public.clients WHERE company_id = v_company_id AND status IN ('customer','vip')), 0),
    'quotes_pending', COALESCE((SELECT COUNT(*) FROM public.quotes WHERE company_id = v_company_id AND status = 'sent'), 0),
    'purchases_pending_count', COALESCE((
      SELECT COUNT(*) FROM public.purchases
      WHERE company_id = v_company_id AND status IN ('pending','partial')
    ), 0),
    'purchases_pending_cents', COALESCE((
      SELECT SUM(total_ttc_cents - COALESCE(paid_cents, 0)) FROM public.purchases
      WHERE company_id = v_company_id AND status IN ('pending','partial')
    ), 0),
    'dso_days', COALESCE((
      SELECT ROUND(AVG(EXTRACT(EPOCH FROM (p.paid_at - i.issue_date::TIMESTAMPTZ)) / 86400.0)::NUMERIC, 1)
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

-- 4) Reload PostgREST
NOTIFY pgrst, 'reload schema';
