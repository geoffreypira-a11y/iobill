-- ═══════════════════════════════════════════════════════════════════
-- v8.35 — Support tickets ouverts aux cabinets comptables
--
-- Avant cette migration, support_tickets exigeait company_id NOT NULL
-- → impossible pour un membre cabinet (qui n'a pas de company) d'ouvrir
--   un ticket via /api/admin?action=create_ticket.
--
-- Cette migration :
--   1) Rend company_id nullable
--   2) Ajoute firm_id (FK accounting_firms) nullable
--   3) Garantit qu'au moins UN des deux est rempli (CHECK)
--   4) Met à jour les RLS pour autoriser les firm_members
-- ═══════════════════════════════════════════════════════════════════

-- 1) company_id devient nullable
ALTER TABLE public.support_tickets
  ALTER COLUMN company_id DROP NOT NULL;

-- 2) Ajouter firm_id (idempotent)
ALTER TABLE public.support_tickets
  ADD COLUMN IF NOT EXISTS firm_id UUID
    REFERENCES public.accounting_firms(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_support_tickets_firm
  ON public.support_tickets(firm_id);

-- 3) CHECK : au moins l'un des deux doit être rempli
--    On drop d'abord si elle existe pour rester idempotent
ALTER TABLE public.support_tickets
  DROP CONSTRAINT IF EXISTS support_tickets_owner_check;

ALTER TABLE public.support_tickets
  ADD CONSTRAINT support_tickets_owner_check
  CHECK (company_id IS NOT NULL OR firm_id IS NOT NULL);

-- 4) RLS — autoriser les firm_members à voir leurs tickets cabinet
--    (l'admin garde sa vue globale via la clause is_admin)
DROP POLICY IF EXISTS st_select ON public.support_tickets;
CREATE POLICY st_select ON public.support_tickets FOR SELECT TO authenticated USING (
  user_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.companies
    WHERE user_id = auth.uid() AND is_admin = TRUE
  )
  OR (
    firm_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.firm_members fm
      WHERE fm.firm_id = support_tickets.firm_id
        AND fm.user_id = auth.uid()
    )
  )
);

-- INSERT : un user peut créer un ticket sur son user_id
-- (le backend impose company_id OU firm_id côté API)
DROP POLICY IF EXISTS st_insert ON public.support_tickets;
CREATE POLICY st_insert ON public.support_tickets FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- UPDATE/DELETE : admin uniquement (inchangé)
DROP POLICY IF EXISTS st_update ON public.support_tickets;
CREATE POLICY st_update ON public.support_tickets FOR UPDATE TO authenticated USING (
  EXISTS (SELECT 1 FROM public.companies WHERE user_id = auth.uid() AND is_admin = TRUE)
);

DROP POLICY IF EXISTS st_delete ON public.support_tickets;
CREATE POLICY st_delete ON public.support_tickets FOR DELETE TO authenticated USING (
  EXISTS (SELECT 1 FROM public.companies WHERE user_id = auth.uid() AND is_admin = TRUE)
);

COMMENT ON COLUMN public.support_tickets.firm_id IS
  'Si rempli : ticket ouvert par un membre cabinet. Mutuellement exclusif avec company_id en pratique mais le CHECK n''interdit pas les deux remplis.';

-- FIN migration v8.35.0
