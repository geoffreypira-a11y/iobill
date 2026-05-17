-- ═══════════════════════════════════════════════════════════
-- IO BILL — Migration v8.13.8 — Fix TVA déductible (exigibilité)
-- ═══════════════════════════════════════════════════════════
-- BUG corrigé :
--   La TVA déductible sur achats était filtrée par issue_date (date
--   de facture fournisseur). Or selon CGI art. 271-I-2, la TVA est
--   déductible sur la période où elle devient EXIGIBLE, c'est-à-dire
--   la date de paiement pour les achats payés (et la date du paiement
--   partiel pour les paiements partiels).
--
--   Exemple concret :
--     Facture SOLO INVEST datée du 05/09/2025, payée en 05/2026.
--     → AVANT : déductible jamais visible (hors mois courant)
--     → APRÈS : déductible en mai 2026 (mois du paiement)
--
-- CHANGEMENT :
--   - vat_deductible_pending_cents : filtre sur paid_at / payment_partial_at
--   - vat_deductible_year_cents   : idem
--   - vat_collected_pending_cents : INCHANGÉ (issue_date facture émise)
--     Note : pour les prestations de services soumises à exigibilité
--     sur encaissement, un futur ajustement basé sur payments.paid_at
--     pourra être nécessaire, mais c'est hors scope de ce patch.
-- ═══════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.dashboard_stats(p_company_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions STABLE AS $$
DECLARE
  v_company_id UUID := COALESCE(p_company_id, public.current_company_id());
  v_month_start DATE := DATE_TRUNC('month', CURRENT_DATE)::DATE;
  v_year_start  DATE := DATE_TRUNC('year',  CURRENT_DATE)::DATE;
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
    -- TVA collectée sur ventes émises (mois en cours)
    'vat_collected_pending_cents', COALESCE((
      SELECT SUM(vat_total_cents) FROM public.invoices
      WHERE company_id = v_company_id
        AND status IN ('issued','sent','partial','paid','overdue')
        AND issue_date >= v_month_start
    ), 0),
    -- TVA déductible sur achats (mois en cours)
    -- Règle CGI art. 271-I-2 : déductible sur la période d'EXIGIBILITÉ,
    -- càd la date de paiement (ou de paiement partiel).
    'vat_deductible_pending_cents', COALESCE((
      SELECT SUM(
        CASE
          WHEN status = 'paid' AND paid_at IS NOT NULL
               AND paid_at >= v_month_start
            THEN vat_total_cents
          WHEN status = 'partial' AND payment_partial_at IS NOT NULL
               AND payment_partial_at::DATE >= v_month_start
               AND total_ttc_cents > 0
            THEN ROUND(vat_total_cents * (COALESCE(paid_cents, 0)::NUMERIC / total_ttc_cents))
          ELSE 0
        END
      ) FROM public.purchases
      WHERE company_id = v_company_id
        AND status IN ('paid','partial')
    ), 0),
    -- TVA collectée annuelle
    'vat_collected_year_cents', COALESCE((
      SELECT SUM(vat_total_cents) FROM public.invoices
      WHERE company_id = v_company_id
        AND status IN ('issued','sent','partial','paid','overdue')
        AND issue_date >= v_year_start
    ), 0),
    -- TVA déductible annuelle (même règle : exigibilité = paiement)
    'vat_deductible_year_cents', COALESCE((
      SELECT SUM(
        CASE
          WHEN status = 'paid' AND paid_at IS NOT NULL
               AND paid_at >= v_year_start
            THEN vat_total_cents
          WHEN status = 'partial' AND payment_partial_at IS NOT NULL
               AND payment_partial_at::DATE >= v_year_start
               AND total_ttc_cents > 0
            THEN ROUND(vat_total_cents * (COALESCE(paid_cents, 0)::NUMERIC / total_ttc_cents))
          ELSE 0
        END
      ) FROM public.purchases
      WHERE company_id = v_company_id
        AND status IN ('paid','partial')
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

-- Reload PostgREST
NOTIFY pgrst, 'reload schema';
