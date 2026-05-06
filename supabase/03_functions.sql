-- ═══════════════════════════════════════════════════════════════════════════
--  IO BILL — FONCTIONS & TRIGGERS v1.0
--  À exécuter APRÈS 02_security.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────
--  NUMÉROTATION ATOMIQUE & SANS TROU
--  Réservation d'un numéro avec incrément verrouillé.
--  Réinitialisation auto au changement d'année.
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.allocate_document_number(
  p_company_id UUID,
  p_doc_type TEXT                                -- invoice, quote, credit_note
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_company RECORD;
  v_year INT := EXTRACT(YEAR FROM NOW())::INT;
  v_seq INT;
  v_prefix TEXT;
  v_format TEXT;
  v_number TEXT;
BEGIN
  -- Verrouillage de la ligne pour éviter les collisions
  SELECT * INTO v_company FROM public.companies WHERE id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Company not found'; END IF;

  IF p_doc_type = 'invoice' THEN
    IF v_company.invoice_seq_year != v_year THEN
      UPDATE public.companies SET invoice_next_seq = 1, invoice_seq_year = v_year WHERE id = p_company_id;
      v_seq := 1;
    ELSE
      v_seq := v_company.invoice_next_seq;
    END IF;
    UPDATE public.companies SET invoice_next_seq = v_seq + 1 WHERE id = p_company_id;
    v_prefix := COALESCE(v_company.invoice_number_prefix, 'FAC');
    v_format := COALESCE(v_company.invoice_number_format, '{prefix}-{year}-{seq:04}');
  ELSIF p_doc_type = 'quote' THEN
    IF v_company.quote_seq_year != v_year THEN
      UPDATE public.companies SET quote_next_seq = 1, quote_seq_year = v_year WHERE id = p_company_id;
      v_seq := 1;
    ELSE
      v_seq := v_company.quote_next_seq;
    END IF;
    UPDATE public.companies SET quote_next_seq = v_seq + 1 WHERE id = p_company_id;
    v_prefix := COALESCE(v_company.quote_number_prefix, 'DEV');
    v_format := '{prefix}-{year}-{seq:04}';
  ELSIF p_doc_type = 'credit_note' THEN
    IF v_company.credit_note_seq_year != v_year THEN
      UPDATE public.companies SET credit_note_next_seq = 1, credit_note_seq_year = v_year WHERE id = p_company_id;
      v_seq := 1;
    ELSE
      v_seq := v_company.credit_note_next_seq;
    END IF;
    UPDATE public.companies SET credit_note_next_seq = v_seq + 1 WHERE id = p_company_id;
    v_prefix := COALESCE(v_company.credit_note_number_prefix, 'AVO');
    v_format := '{prefix}-{year}-{seq:04}';
  ELSE
    RAISE EXCEPTION 'Unknown doc type: %', p_doc_type;
  END IF;

  v_number := REPLACE(v_format, '{prefix}', v_prefix);
  v_number := REPLACE(v_number, '{year}', v_year::TEXT);
  v_number := REPLACE(v_number, '{seq:04}', LPAD(v_seq::TEXT, 4, '0'));
  v_number := REPLACE(v_number, '{seq:05}', LPAD(v_seq::TEXT, 5, '0'));
  v_number := REPLACE(v_number, '{seq}', v_seq::TEXT);

  RETURN v_number;
END $$;

GRANT EXECUTE ON FUNCTION public.allocate_document_number(UUID, TEXT) TO authenticated;

-- ──────────────────────────────────────────────────────────────
--  CHAÎNE DE HASHS (anti-fraude DGFiP, art 286-I-3 CGI)
--  À l'émission d'une facture (status -> 'issued'),
--  on calcule le hash du contenu et on le chaîne avec le précédent.
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.compute_invoice_hash_chain()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev_hash TEXT;
  v_payload TEXT;
BEGIN
  -- On ne calcule que lors du passage à 'issued' (la première fois)
  IF NEW.status = 'issued' AND (OLD.status IS DISTINCT FROM 'issued' OR OLD.content_hash IS NULL) THEN
    -- Hash de la facture précédente (la plus récemment émise)
    SELECT content_hash INTO v_prev_hash
    FROM public.invoices
    WHERE company_id = NEW.company_id
      AND status IN ('issued','sent','partial','paid','overdue')
      AND id != NEW.id
      AND issued_at IS NOT NULL
    ORDER BY issued_at DESC
    LIMIT 1;

    -- Payload canonique (jamais modifiable après émission)
    v_payload := concat_ws('|',
      NEW.id::TEXT,
      NEW.number,
      NEW.issue_date::TEXT,
      NEW.total_ttc_cents::TEXT,
      NEW.client_snapshot::TEXT,
      COALESCE(v_prev_hash, 'GENESIS')
    );

    NEW.previous_hash := COALESCE(v_prev_hash, 'GENESIS');
    NEW.content_hash := encode(digest(v_payload, 'sha256'), 'hex');
    NEW.issued_at := NOW();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_invoices_hash_chain ON public.invoices;
CREATE TRIGGER trg_invoices_hash_chain
BEFORE UPDATE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.compute_invoice_hash_chain();

-- Idem pour avoirs
CREATE OR REPLACE FUNCTION public.compute_credit_note_hash_chain()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev_hash TEXT;
  v_payload TEXT;
BEGIN
  IF NEW.status = 'issued' AND (OLD.status IS DISTINCT FROM 'issued' OR OLD.content_hash IS NULL) THEN
    SELECT content_hash INTO v_prev_hash
    FROM public.credit_notes
    WHERE company_id = NEW.company_id
      AND status = 'issued'
      AND id != NEW.id
    ORDER BY created_at DESC LIMIT 1;

    v_payload := concat_ws('|',
      NEW.id::TEXT, NEW.number, NEW.issue_date::TEXT,
      NEW.total_ttc_cents::TEXT, NEW.invoice_id::TEXT,
      COALESCE(v_prev_hash, 'GENESIS')
    );
    NEW.previous_hash := COALESCE(v_prev_hash, 'GENESIS');
    NEW.content_hash := encode(digest(v_payload, 'sha256'), 'hex');
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_creditnotes_hash_chain ON public.credit_notes;
CREATE TRIGGER trg_creditnotes_hash_chain
BEFORE UPDATE ON public.credit_notes
FOR EACH ROW EXECUTE FUNCTION public.compute_credit_note_hash_chain();

-- ──────────────────────────────────────────────────────────────
--  PROTECTION : interdire la modification d'une facture émise
--  (sauf champs autorisés : statut, paiements, relances, PDP)
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.protect_issued_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('issued','sent','partial','paid','overdue') THEN
    -- Champs immuables
    IF NEW.number IS DISTINCT FROM OLD.number THEN RAISE EXCEPTION 'Numéro facture immuable'; END IF;
    IF NEW.issue_date IS DISTINCT FROM OLD.issue_date THEN RAISE EXCEPTION 'Date émission immuable'; END IF;
    IF NEW.client_snapshot IS DISTINCT FROM OLD.client_snapshot THEN RAISE EXCEPTION 'Snapshot client immuable'; END IF;
    IF NEW.company_snapshot IS DISTINCT FROM OLD.company_snapshot THEN RAISE EXCEPTION 'Snapshot société immuable'; END IF;
    IF NEW.total_ttc_cents IS DISTINCT FROM OLD.total_ttc_cents THEN RAISE EXCEPTION 'Total TTC immuable — créer un avoir pour rectifier'; END IF;
    IF NEW.subtotal_ht_cents IS DISTINCT FROM OLD.subtotal_ht_cents THEN RAISE EXCEPTION 'Total HT immuable — créer un avoir pour rectifier'; END IF;
    IF NEW.vat_total_cents IS DISTINCT FROM OLD.vat_total_cents THEN RAISE EXCEPTION 'TVA immuable'; END IF;
    IF NEW.content_hash IS DISTINCT FROM OLD.content_hash THEN RAISE EXCEPTION 'Hash immuable'; END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_invoices_protect ON public.invoices;
CREATE TRIGGER trg_invoices_protect
BEFORE UPDATE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.protect_issued_invoice();

-- Pareil sur les lignes : interdiction de modifier les lignes d'une facture émise
CREATE OR REPLACE FUNCTION public.protect_issued_lines()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF (TG_OP = 'UPDATE' OR TG_OP = 'DELETE') THEN
    IF OLD.document_type = 'invoice' THEN
      SELECT status INTO v_status FROM public.invoices WHERE id = OLD.document_id;
      IF v_status IN ('issued','sent','partial','paid','overdue') THEN
        RAISE EXCEPTION 'Impossible de modifier les lignes d''une facture émise';
      END IF;
    ELSIF OLD.document_type = 'credit_note' THEN
      SELECT status INTO v_status FROM public.credit_notes WHERE id = OLD.document_id;
      IF v_status = 'issued' THEN
        RAISE EXCEPTION 'Impossible de modifier les lignes d''un avoir émis';
      END IF;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS trg_lines_protect ON public.document_lines;
CREATE TRIGGER trg_lines_protect
BEFORE UPDATE OR DELETE ON public.document_lines
FOR EACH ROW EXECUTE FUNCTION public.protect_issued_lines();

-- ──────────────────────────────────────────────────────────────
--  AUDIT LOG AUTOMATIQUE
--  Toutes les opérations sensibles écrivent dans audit_log.
--  Le trigger est SECURITY DEFINER pour bypass RLS sur la table.
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.write_audit_log()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_company_id UUID;
  v_action TEXT;
  v_old JSONB;
  v_new JSONB;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_company_id := NEW.company_id;
    v_action := 'INSERT';
    v_new := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    v_company_id := NEW.company_id;
    v_action := 'UPDATE';
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    -- détection action métier spéciale
    IF TG_TABLE_NAME = 'invoices' AND OLD.status != NEW.status THEN
      v_action := 'STATUS_' || UPPER(NEW.status);
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    v_company_id := OLD.company_id;
    v_action := 'DELETE';
    v_old := to_jsonb(OLD);
  END IF;

  INSERT INTO public.audit_log (company_id, user_id, table_name, record_id, action, old_data, new_data)
  VALUES (
    v_company_id,
    auth.uid(),
    TG_TABLE_NAME,
    COALESCE((NEW).id, (OLD).id),
    v_action,
    v_old,
    v_new
  );

  RETURN COALESCE(NEW, OLD);
END $$;

-- Application aux tables sensibles
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['invoices','quotes','credit_notes','payments','vat_returns','urssaf_returns','accounting_exports'])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_audit ON public.%I', t, t);
    EXECUTE format($f$
      CREATE TRIGGER trg_%I_audit
      AFTER INSERT OR UPDATE OR DELETE ON public.%I
      FOR EACH ROW EXECUTE FUNCTION public.write_audit_log()
    $f$, t, t);
  END LOOP;
END $$;

-- ──────────────────────────────────────────────────────────────
--  CALCUL TOTAUX DOCUMENT
--  Recalcule subtotal/TVA/TTC à partir des lignes.
--  Appelé manuellement depuis le client après modif des lignes.
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recalc_document_totals(
  p_doc_type TEXT,
  p_doc_id UUID
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_subtotal BIGINT := 0;
  v_vat BIGINT := 0;
  v_ttc BIGINT := 0;
  v_breakdown JSONB := '[]'::JSONB;
  v_rate_data RECORD;
BEGIN
  -- Totaux globaux
  SELECT
    COALESCE(SUM(line_ht_cents), 0),
    COALESCE(SUM(line_vat_cents), 0),
    COALESCE(SUM(line_ttc_cents), 0)
  INTO v_subtotal, v_vat, v_ttc
  FROM public.document_lines
  WHERE document_type = p_doc_type AND document_id = p_doc_id;

  -- Ventilation par taux TVA
  v_breakdown := COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'rate', vat_rate,
      'base_cents', base_cents,
      'vat_cents', vat_cents
    ) ORDER BY vat_rate)
    FROM (
      SELECT vat_rate,
             SUM(line_ht_cents)  AS base_cents,
             SUM(line_vat_cents) AS vat_cents
      FROM public.document_lines
      WHERE document_type = p_doc_type AND document_id = p_doc_id
      GROUP BY vat_rate
    ) g
  ), '[]'::JSONB);

  IF p_doc_type = 'invoice' THEN
    UPDATE public.invoices
       SET subtotal_ht_cents = v_subtotal,
           vat_total_cents   = v_vat,
           total_ttc_cents   = v_ttc,
           vat_breakdown     = v_breakdown
     WHERE id = p_doc_id
       AND status = 'draft';                  -- on ne touche pas une facture émise
  ELSIF p_doc_type = 'quote' THEN
    UPDATE public.quotes
       SET subtotal_ht_cents = v_subtotal,
           vat_total_cents   = v_vat,
           total_ttc_cents   = v_ttc
     WHERE id = p_doc_id
       AND status IN ('draft','sent');
  ELSIF p_doc_type = 'credit_note' THEN
    UPDATE public.credit_notes
       SET subtotal_ht_cents = v_subtotal,
           vat_total_cents   = v_vat,
           total_ttc_cents   = v_ttc,
           vat_breakdown     = v_breakdown
     WHERE id = p_doc_id
       AND status = 'draft';
  END IF;

  RETURN jsonb_build_object(
    'subtotal_ht_cents', v_subtotal,
    'vat_total_cents',   v_vat,
    'total_ttc_cents',   v_ttc,
    'vat_breakdown',     v_breakdown
  );
END $$;

GRANT EXECUTE ON FUNCTION public.recalc_document_totals(TEXT, UUID) TO authenticated;

-- ──────────────────────────────────────────────────────────────
--  STATS TABLEAU DE BORD (vue matérialisée légère via fonction)
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.dashboard_stats(p_company_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE AS $$
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

-- ──────────────────────────────────────────────────────────────
--  SUIVI SEUIL FRANCHISE TVA (auto-entrepreneur)
-- ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.micro_threshold_progress(p_company_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public STABLE AS $$
DECLARE
  v_company_id UUID := COALESCE(p_company_id, public.current_company_id());
  v_threshold NUMERIC;
  v_year_start DATE := DATE_TRUNC('year', CURRENT_DATE)::DATE;
  v_ca BIGINT;
BEGIN
  IF v_company_id IS NULL THEN RETURN '{}'::JSONB; END IF;

  SELECT micro_threshold INTO v_threshold FROM public.companies WHERE id = v_company_id;
  IF v_threshold IS NULL THEN RETURN '{}'::JSONB; END IF;

  SELECT COALESCE(SUM(subtotal_ht_cents), 0) INTO v_ca
  FROM public.invoices
  WHERE company_id = v_company_id
    AND status IN ('issued','sent','partial','paid','overdue')
    AND issue_date >= v_year_start;

  RETURN jsonb_build_object(
    'ca_ytd_cents', v_ca,
    'threshold_cents', (v_threshold * 100)::BIGINT,
    'pct', LEAST(100, ROUND((v_ca::NUMERIC / (v_threshold * 100)) * 100, 1)),
    'remaining_cents', GREATEST(0, (v_threshold * 100)::BIGINT - v_ca)
  );
END $$;

GRANT EXECUTE ON FUNCTION public.micro_threshold_progress(UUID) TO authenticated;

-- FIN 03_functions.sql
