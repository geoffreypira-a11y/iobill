-- ══════════════════════════════════════════════════════════════════
-- IO BILL — Migration v8.27.0 — Mode Comptable Sprint 3
-- Vue lecture client + Signalements universels
-- ══════════════════════════════════════════════════════════════════
-- 
-- Approche : 
--   1. Helper firm_can_read(company_id) RÉUTILISABLE partout
--   2. RLS sur invoices, purchases, payments, clients pour lecture firm
--   3. RLS firm_signals enrichies (création par firm, lecture des 2 côtés)
--   4. Table notifications_firm utilisée pour notif client
-- ══════════════════════════════════════════════════════════════════

-- ════════════════════════════════════════════════════════════════════
-- 1) HELPER firm_can_read(company_id) → SECURITY DEFINER
-- ════════════════════════════════════════════════════════════════════
-- Retourne TRUE si auth.uid() est firm_member d'un cabinet rattaché
-- à cette company avec status='accepted'

CREATE OR REPLACE FUNCTION public.firm_can_read(p_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.firm_client_links fcl
    JOIN public.firm_members fm ON fm.firm_id = fcl.firm_id
    WHERE fcl.company_id = p_company_id
      AND fcl.status = 'accepted'
      AND fm.user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.firm_can_read(UUID) TO authenticated;

COMMENT ON FUNCTION public.firm_can_read(UUID) IS 
  'TRUE si auth.uid() est firm_member dun cabinet liè (accepted) à la company. Utilisé dans les policies RLS pour permettre la lecture cross-company.';


-- ════════════════════════════════════════════════════════════════════
-- 2) RLS — invoices : autoriser lecture par firm
-- ════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  -- Drop si existe (idempotent)
  EXECUTE 'DROP POLICY IF EXISTS "invoices_firm_select" ON public.invoices';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE POLICY "invoices_firm_select" ON public.invoices FOR SELECT TO authenticated
  USING (public.firm_can_read(company_id));


-- ════════════════════════════════════════════════════════════════════
-- 3) RLS — invoice_lines
-- ════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "invoice_lines_firm_select" ON public.invoice_lines';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE POLICY "invoice_lines_firm_select" ON public.invoice_lines FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.invoices i
      WHERE i.id = invoice_lines.invoice_id 
        AND public.firm_can_read(i.company_id)
    )
  );


-- ════════════════════════════════════════════════════════════════════
-- 4) RLS — purchases
-- ════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "purchases_firm_select" ON public.purchases';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE POLICY "purchases_firm_select" ON public.purchases FOR SELECT TO authenticated
  USING (public.firm_can_read(company_id));


-- ════════════════════════════════════════════════════════════════════
-- 5) RLS — payments
-- ════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "payments_firm_select" ON public.payments';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE POLICY "payments_firm_select" ON public.payments FOR SELECT TO authenticated
  USING (public.firm_can_read(company_id));


-- ════════════════════════════════════════════════════════════════════
-- 6) RLS — clients (carnet d'adresses clients du client final)
-- ════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "clients_firm_select" ON public.clients';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE POLICY "clients_firm_select" ON public.clients FOR SELECT TO authenticated
  USING (public.firm_can_read(company_id));


-- ════════════════════════════════════════════════════════════════════
-- 7) RLS — firm_signals : refaire propre avec auth.jwt() et helper
-- ════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "fs_select" ON public.firm_signals;
DROP POLICY IF EXISTS "fs_insert" ON public.firm_signals;
DROP POLICY IF EXISTS "fs_update" ON public.firm_signals;
DROP POLICY IF EXISTS "fs_delete" ON public.firm_signals;

-- SELECT : cabinet voit ses signaux + client voit les signaux visibles
CREATE POLICY "fs_select" ON public.firm_signals FOR SELECT TO authenticated
  USING (
    -- Cabinet membre
    EXISTS (
      SELECT 1 FROM public.firm_members fm 
      WHERE fm.firm_id = firm_signals.firm_id 
        AND fm.user_id = auth.uid()
    )
    OR
    -- Client owner de la company ET le signal lui est visible
    (visible_to_client = TRUE 
      AND EXISTS (
        SELECT 1 FROM public.companies c 
        WHERE c.id = firm_signals.company_id 
          AND c.user_id = auth.uid()
      ))
    OR
    -- Admin
    EXISTS (
      SELECT 1 FROM public.companies 
      WHERE user_id = auth.uid() AND is_admin = TRUE
    )
  );

-- INSERT : seuls les firm_members (owner/partner/staff) peuvent créer
CREATE POLICY "fs_insert" ON public.firm_signals FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.firm_members fm 
      WHERE fm.firm_id = firm_signals.firm_id 
        AND fm.user_id = auth.uid()
        AND fm.role IN ('owner', 'partner', 'staff')
    )
    AND
    -- Et le cabinet doit être lié à cette company
    public.firm_can_read(firm_signals.company_id)
  );

-- UPDATE : cabinet (changer status) ou client (répondre/résoudre)
CREATE POLICY "fs_update" ON public.firm_signals FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm 
      WHERE fm.firm_id = firm_signals.firm_id 
        AND fm.user_id = auth.uid()
    )
    OR
    EXISTS (
      SELECT 1 FROM public.companies c 
      WHERE c.id = firm_signals.company_id 
        AND c.user_id = auth.uid()
    )
  );

-- DELETE : seuls les firm_members owner/partner
CREATE POLICY "fs_delete" ON public.firm_signals FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.firm_members fm 
      WHERE fm.firm_id = firm_signals.firm_id 
        AND fm.user_id = auth.uid()
        AND fm.role IN ('owner', 'partner')
    )
  );


-- ════════════════════════════════════════════════════════════════════
-- 8) Index utiles
-- ════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_fs_company_status ON public.firm_signals(company_id, status);
CREATE INDEX IF NOT EXISTS idx_fs_firm_status ON public.firm_signals(firm_id, status);
CREATE INDEX IF NOT EXISTS idx_fs_target ON public.firm_signals(target_type, target_id);


-- ════════════════════════════════════════════════════════════════════
-- 9) Realtime sur firm_signals (pour notif live côté client)
-- ════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.firm_signals;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- FIN v8.27.0
