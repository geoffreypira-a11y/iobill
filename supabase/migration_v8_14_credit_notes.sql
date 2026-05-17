-- ═══════════════════════════════════════════════════════════
-- IO BILL — Migration v8.14 — Avoirs : finition métier
-- ═══════════════════════════════════════════════════════════
-- Apporte :
--   1) Colonnes manquantes sur credit_notes (alignées sur invoices)
--      pour permettre génération PDF/Factur-X, envoi email, transmission PDP
--   2) Trigger anti-dépassement : SUM(avoirs émis) ≤ total facture
--   3) dashboard_stats mis à jour : intègre les avoirs en déduction
--      du CA HT et de la TVA collectée
--   4) Realtime activé sur credit_notes
-- ═══════════════════════════════════════════════════════════

-- ─── 1) Colonnes manquantes ─────────────────────────────────
ALTER TABLE public.credit_notes
  ADD COLUMN IF NOT EXISTS facturx_status TEXT,
  ADD COLUMN IF NOT EXISTS facturx_pdf_url TEXT,
  ADD COLUMN IF NOT EXISTS facturx_xml_url TEXT,
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pdp_provider TEXT,
  ADD COLUMN IF NOT EXISTS pdp_transmission_id TEXT,
  ADD COLUMN IF NOT EXISTS pdp_transmitted_at TIMESTAMPTZ;

-- ─── 2) Trigger anti-dépassement ────────────────────────────
-- Empêche d'émettre un avoir qui ferait dépasser le total de la
-- facture source par la somme des avoirs déjà émis dessus.
CREATE OR REPLACE FUNCTION public.check_credit_note_total()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_invoice_total BIGINT;
  v_already_credited BIGINT;
  v_invoice_number TEXT;
BEGIN
  -- On contrôle uniquement au passage à 'issued'
  IF NEW.status = 'issued' AND (OLD.status IS DISTINCT FROM 'issued') THEN
    SELECT total_ttc_cents, number
      INTO v_invoice_total, v_invoice_number
    FROM public.invoices
    WHERE id = NEW.invoice_id;

    IF v_invoice_total IS NULL THEN
      RAISE EXCEPTION 'Facture source introuvable pour cet avoir';
    END IF;

    SELECT COALESCE(SUM(total_ttc_cents), 0)
      INTO v_already_credited
    FROM public.credit_notes
    WHERE invoice_id = NEW.invoice_id
      AND status = 'issued'
      AND id != NEW.id;

    IF (v_already_credited + NEW.total_ttc_cents) > v_invoice_total THEN
      RAISE EXCEPTION
        'Cet avoir ferait dépasser le total de la facture %. Total facture: % cts, déjà crédité: % cts, cet avoir: % cts.',
        v_invoice_number, v_invoice_total, v_already_credited, NEW.total_ttc_cents;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_creditnotes_check_total ON public.credit_notes;
CREATE TRIGGER trg_creditnotes_check_total
BEFORE UPDATE ON public.credit_notes
FOR EACH ROW EXECUTE FUNCTION public.check_credit_note_total();

-- ─── 3) Realtime sur credit_notes ───────────────────────────
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.credit_notes;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;

-- ─── 4) dashboard_stats : intégration des avoirs ────────────
-- Le CA HT et la TVA collectée doivent être NETS des avoirs émis.
-- Règle : un avoir vient en déduction sur la période de SON émission
-- (pas celle de la facture d'origine), c'est la règle TVA classique.
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
    -- CA HT NET = factures émises − avoirs émis (sur leur date d'émission)
    'ca_ht_month_cents', COALESCE((
      SELECT SUM(subtotal_ht_cents) FROM public.invoices
      WHERE company_id = v_company_id
        AND status IN ('issued','sent','partial','paid','overdue')
        AND issue_date >= v_month_start
    ), 0) - COALESCE((
      SELECT SUM(subtotal_ht_cents) FROM public.credit_notes
      WHERE company_id = v_company_id
        AND status = 'issued'
        AND issue_date >= v_month_start
    ), 0),
    'ca_ht_year_cents', COALESCE((
      SELECT SUM(subtotal_ht_cents) FROM public.invoices
      WHERE company_id = v_company_id
        AND status IN ('issued','sent','partial','paid','overdue')
        AND issue_date >= v_year_start
    ), 0) - COALESCE((
      SELECT SUM(subtotal_ht_cents) FROM public.credit_notes
      WHERE company_id = v_company_id
        AND status = 'issued'
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
    -- TVA collectée NETTE des avoirs (mois)
    'vat_collected_pending_cents', COALESCE((
      SELECT SUM(vat_total_cents) FROM public.invoices
      WHERE company_id = v_company_id
        AND status IN ('issued','sent','partial','paid','overdue')
        AND issue_date >= v_month_start
    ), 0) - COALESCE((
      SELECT SUM(vat_total_cents) FROM public.credit_notes
      WHERE company_id = v_company_id
        AND status = 'issued'
        AND issue_date >= v_month_start
    ), 0),
    -- TVA déductible (achats payés — règle CGI art. 271-I-2)
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
    -- TVA collectée annuelle (nette des avoirs)
    'vat_collected_year_cents', COALESCE((
      SELECT SUM(vat_total_cents) FROM public.invoices
      WHERE company_id = v_company_id
        AND status IN ('issued','sent','partial','paid','overdue')
        AND issue_date >= v_year_start
    ), 0) - COALESCE((
      SELECT SUM(vat_total_cents) FROM public.credit_notes
      WHERE company_id = v_company_id
        AND status = 'issued'
        AND issue_date >= v_year_start
    ), 0),
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
    -- Nouveaux KPIs sur les avoirs
    'credit_notes_month_cents', COALESCE((
      SELECT SUM(total_ttc_cents) FROM public.credit_notes
      WHERE company_id = v_company_id AND status = 'issued'
        AND issue_date >= v_month_start
    ), 0),
    'credit_notes_year_cents', COALESCE((
      SELECT SUM(total_ttc_cents) FROM public.credit_notes
      WHERE company_id = v_company_id AND status = 'issued'
        AND issue_date >= v_year_start
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

NOTIFY pgrst, 'reload schema';
