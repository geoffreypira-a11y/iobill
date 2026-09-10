-- ═══════════════════════════════════════════════════════════════════
-- Chaîne d'inaltérabilité : couvrir aussi les documents INSÉRÉS en
-- statut final (audit du 10/09/2026, C1)
--
-- Les deux déclencheurs étaient posés en BEFORE UPDATE seulement. Un
-- document créé directement dans son statut définitif — jamais mis à
-- jour ensuite — ne les déclenchait donc jamais, et repartait sans
-- content_hash ni previous_hash.
--
-- Deux cas réels :
--   • TOUS les avoirs. Le pont les insère en 'issued' dès leur création
--     (IO CAR v8.183, correction A10) : aucun n'a jamais été chaîné.
--   • Les factures poussées directement en 'paid' par le chemin de repli
--     de mark_invoice_paid, quand le push en brouillon n'a pas eu lieu.
--
-- Le parcours nominal d'une facture (draft → issued) passait, lui, par
-- un UPDATE : les factures ordinaires sont bien chaînées.
--
-- Deux corrections :
--   1. les fonctions gèrent TG_OP = 'INSERT', où OLD n'existe pas
--      (y référer lève « record old is not assigned yet ») ;
--   2. la condition porte sur « sortir de brouillon » plutôt que sur le
--      seul statut 'issued' — une facture insérée en 'paid' est tout
--      aussi définitive.
--
-- L'immuabilité est préservée : on ne calcule que si content_hash est
-- encore NULL, jamais de recalcul.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.compute_invoice_hash_chain()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev_hash TEXT;
  v_payload TEXT;
BEGIN
  IF NEW.status IN ('issued','sent','partial','paid','overdue')
     AND (TG_OP = 'INSERT' OR OLD.content_hash IS NULL)
     AND NEW.content_hash IS NULL THEN

    SELECT content_hash INTO v_prev_hash
    FROM public.invoices
    WHERE company_id = NEW.company_id
      AND status IN ('issued','sent','partial','paid','overdue')
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
    NEW.issued_at := COALESCE(NEW.issued_at, NOW());
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_invoices_hash_chain ON public.invoices;
CREATE TRIGGER trg_invoices_hash_chain
BEFORE INSERT OR UPDATE ON public.invoices
FOR EACH ROW EXECUTE FUNCTION public.compute_invoice_hash_chain();

CREATE OR REPLACE FUNCTION public.compute_credit_note_hash_chain()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev_hash TEXT;
  v_payload TEXT;
BEGIN
  IF NEW.status = 'issued'
     AND (TG_OP = 'INSERT' OR OLD.content_hash IS NULL)
     AND NEW.content_hash IS NULL THEN

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
BEFORE INSERT OR UPDATE ON public.credit_notes
FOR EACH ROW EXECUTE FUNCTION public.compute_credit_note_hash_chain();
