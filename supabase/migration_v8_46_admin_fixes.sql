-- ═══════════════════════════════════════════════════════════════════
-- v8.46 — Fix triggers pour permettre les suppressions admin
--
-- Bugs corrigés :
--   1) write_audit_log plantait au DELETE cascade avec
--      "record OLD has no field status" à cause d'un accès typé direct.
--      Fix : accès via JSONB pour tolérer les tables sans champ status.
--
--   2) protect_issued_lines et protect_issued_invoice bloquaient TOUTES
--      les opérations sur factures émises, même depuis l'API admin.
--      Fix : bypass si current_user = 'service_role' (API admin uniquement,
--      les vrais users passent toujours par la protection RLS+trigger).
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1) write_audit_log — accès JSONB au lieu de champ typé ─────
DROP FUNCTION IF EXISTS public.write_audit_log() CASCADE;

CREATE FUNCTION public.write_audit_log()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $BODY$
DECLARE
  v_company_id UUID;
  v_action TEXT;
  v_old JSONB;
  v_new JSONB;
  v_record_id UUID;
  v_old_status TEXT;
  v_new_status TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_company_id := NEW.company_id;
    v_action := 'INSERT';
    v_new := to_jsonb(NEW);
    v_record_id := NEW.id;
  ELSIF TG_OP = 'UPDATE' THEN
    v_company_id := NEW.company_id;
    v_action := 'UPDATE';
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    v_record_id := NEW.id;
    -- v8.46 : accès via JSONB pour éviter les erreurs de type
    IF TG_TABLE_NAME = 'invoices' THEN
      v_old_status := v_old ->> 'status';
      v_new_status := v_new ->> 'status';
      IF v_old_status IS DISTINCT FROM v_new_status THEN
        v_action := 'STATUS_' || UPPER(COALESCE(v_new_status, 'NULL'));
      END IF;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    v_company_id := OLD.company_id;
    v_action := 'DELETE';
    v_old := to_jsonb(OLD);
    v_record_id := OLD.id;
  END IF;

  INSERT INTO public.audit_log (company_id, user_id, table_name, record_id, action, old_data, new_data)
  VALUES (
    v_company_id,
    auth.uid(),
    TG_TABLE_NAME,
    v_record_id,
    v_action,
    v_old,
    v_new
  );

  RETURN COALESCE(NEW, OLD);
END $BODY$;

-- Recrée les triggers d'audit (CASCADE les a supprimés)
DO $recreate$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY['invoices','quotes','credit_notes','payments','vat_returns','urssaf_returns','accounting_exports'])
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%I_audit AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.write_audit_log()', t, t);
  END LOOP;
END $recreate$;

-- ─── 2) protect_issued_lines — bypass service_role ──────────────
CREATE OR REPLACE FUNCTION public.protect_issued_lines()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF current_user = 'service_role' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
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

-- ─── 3) protect_issued_invoice — bypass service_role ────────────
CREATE OR REPLACE FUNCTION public.protect_issued_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('issued','sent','partial','paid','overdue') THEN
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

-- Recharge le cache PostgREST
NOTIFY pgrst, 'reload schema';

-- FIN migration v8.46
