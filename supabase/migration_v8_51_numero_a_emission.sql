-- ═══════════════════════════════════════════════════════════
-- IO BILL — Migration v8.51 — Numéro de facture attribué à l'ÉMISSION
-- ═══════════════════════════════════════════════════════════
-- PROBLÈME : `allocate_document_number` incrémentait le compteur dès
-- l'enregistrement du BROUILLON. Supprimer un brouillon laissait donc le
-- compteur avancé et le numéro définitivement perdu :
--   créer FAC-2026-0032 (brouillon) → supprimer → la suivante est 0033.
-- La suite des factures émises comportait donc des trous, ce que la règle
-- fiscale française n'admet pas (numérotation continue, sans rupture).
--
-- PRINCIPE RETENU : un brouillon n'est pas une facture. Il reçoit un numéro
-- PROVISOIRE (`BROUILLON-0001`) qui ne consomme pas la séquence légale. Le
-- vrai numéro n'est attribué qu'au passage en « émise », dans le même UPDATE
-- que le statut — donc couvert par la chaîne de hashs anti-fraude.
--
-- Conséquence voulue : la numérotation suit l'ordre d'ÉMISSION, pas l'ordre
-- de création. Deux brouillons en attente, le second émis en premier reçoit
-- le plus petit numéro. C'est exactement ce que demande la chronologie légale.
--
-- NOTE : cette migration ne rattrape PAS les trous déjà créés. Reculer le
-- compteur entrerait en collision avec les brouillons existants, qui portent
-- déjà de vrais numéros et les garderont à l'émission. Les trous passés
-- restent donc, les nouveaux ne se produiront plus.
-- ═══════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────
-- 1) Compteur dédié aux brouillons (séparé de la séquence légale)
-- ───────────────────────────────────────────────────────────
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS draft_next_seq INTEGER NOT NULL DEFAULT 1;

-- ───────────────────────────────────────────────────────────
-- 2) Numéro provisoire de brouillon
-- ───────────────────────────────────────────────────────────
-- Volontairement non réinitialisé chaque année : ce n'est pas un numéro
-- légal, il sert uniquement à distinguer deux brouillons et à garantir
-- l'unicité (contrainte UNIQUE (company_id, number)).
CREATE OR REPLACE FUNCTION public.allocate_draft_number(p_company_id UUID)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_seq INTEGER;
BEGIN
  SELECT draft_next_seq INTO v_seq
    FROM public.companies WHERE id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Company not found'; END IF;

  UPDATE public.companies SET draft_next_seq = v_seq + 1 WHERE id = p_company_id;

  RETURN 'BROUILLON-' || LPAD(v_seq::TEXT, 4, '0');
END $$;

GRANT EXECUTE ON FUNCTION public.allocate_draft_number(UUID) TO authenticated, service_role;

-- L'attribution du numéro légal se fait désormais côté serveur, à l'émission
-- (api/generate-facturx.js), avec la clé service_role.
GRANT EXECUTE ON FUNCTION public.allocate_document_number(UUID, TEXT) TO service_role;
