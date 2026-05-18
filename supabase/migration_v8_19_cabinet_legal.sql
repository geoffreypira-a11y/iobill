-- ──────────────────────────────────────────────────────────────
-- IO BILL — Migration v8.19.0 — Cabinet activable + offre lancement
-- ──────────────────────────────────────────────────────────────

-- 1) Champ pour identifier les cabinets bénéficiaires de l'offre
--    "10 premiers cabinets gratuits". Permet de :
--    - Identifier les bénéficiaires (audit)
--    - Bloquer Stripe à 0€ via coupon serveur-side
ALTER TABLE public.firms
  ADD COLUMN IF NOT EXISTS lifetime_free BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS lifetime_free_rank INTEGER;

COMMENT ON COLUMN public.firms.lifetime_free IS
  'Cabinet bénéficiant de l''offre de lancement "10 premiers cabinets gratuits"';
COMMENT ON COLUMN public.firms.lifetime_free_rank IS
  'Rang dans l''ordre de souscription (1 à 10 pour l''offre, NULL sinon)';

-- 2) Fonction d'attribution automatique du rang
-- Appelée par le backend lors de la première souscription firm.
-- Retourne le rang attribué (1 à 10) ou NULL si offre épuisée.
CREATE OR REPLACE FUNCTION public.claim_firm_free_slot(p_firm_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_count INTEGER;
  v_rank INTEGER;
BEGIN
  -- Si le firm a déjà sa place, retourner son rang
  SELECT lifetime_free_rank INTO v_rank
    FROM public.firms WHERE id = p_firm_id;
  IF v_rank IS NOT NULL THEN
    RETURN v_rank;
  END IF;

  -- Compter les places déjà prises
  SELECT COUNT(*) INTO v_count
    FROM public.firms WHERE lifetime_free = TRUE;

  IF v_count >= 10 THEN
    RETURN NULL;  -- Plus de places, le firm paiera normalement
  END IF;

  -- Attribuer la place suivante
  UPDATE public.firms
    SET lifetime_free = TRUE,
        lifetime_free_rank = v_count + 1
    WHERE id = p_firm_id
    RETURNING lifetime_free_rank INTO v_rank;

  RETURN v_rank;
END $$;

-- 3) Vue admin pour voir les cabinets bénéficiaires
CREATE OR REPLACE VIEW public.admin_free_firms AS
SELECT
  f.id,
  f.legal_name,
  f.email,
  f.siret,
  f.lifetime_free_rank,
  f.stripe_sub_status,
  f.created_at,
  COUNT(fc.id) AS clients_count
FROM public.firms f
LEFT JOIN public.firm_clients fc ON fc.firm_id = f.id
WHERE f.lifetime_free = TRUE
GROUP BY f.id
ORDER BY f.lifetime_free_rank;

-- FIN migration v8.19.0
