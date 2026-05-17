-- ═══════════════════════════════════════════════════════════
-- IO BILL — Migration v8.10 — Fix trigger hash_chain
-- ═══════════════════════════════════════════════════════════
-- Probleme : la fonction compute_invoice_hash_chain utilise digest()
-- de l'extension pgcrypto, qui est installee dans le schema "extensions"
-- sur Supabase (et non dans "public"). Le SET search_path=public empeche
-- la fonction de trouver digest() → erreur SQL → UPDATE invoice rejete.
--
-- Solution : etendre le search_path a "public, extensions".
-- ═══════════════════════════════════════════════════════════

-- 1) Fix trigger INVOICES
CREATE OR REPLACE FUNCTION public.compute_invoice_hash_chain()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
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

-- 2) Fix trigger CREDIT NOTES (idem)
CREATE OR REPLACE FUNCTION public.compute_credit_note_hash_chain()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
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
      AND issued_at IS NOT NULL
    ORDER BY issued_at DESC
    LIMIT 1;

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

-- 3) Garantir que l'extension pgcrypto est bien installee dans "extensions"
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;

-- 4) Force PostgREST a recharger le schema
NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════
-- FIN MIGRATION v8.10
-- ═══════════════════════════════════════════════════════════
