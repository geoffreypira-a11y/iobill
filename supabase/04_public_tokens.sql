-- ═══════════════════════════════════════════════════════════════════════════
--  IO BILL - Migration : tokens publics pour partage sans authentification
--  À exécuter APRES 03_functions.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- Table des tokens publics : chaque token donne acces lecture seule a un document
-- ou a un portail client (multi-documents).
CREATE TABLE IF NOT EXISTS public.public_tokens (
  token TEXT PRIMARY KEY,                       -- token cryptographique (URL-safe)
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Type de partage :
  -- - "quote"   : acces a un devis (consultation + signature)
  -- - "invoice" : acces a une facture (consultation + paiement)
  -- - "portal"  : acces au portail client (toutes les factures du client)
  scope TEXT NOT NULL,
  -- ID du document ou du client cible
  resource_id UUID NOT NULL,
  -- Optionnel : email de la personne qui a recu le lien (pour audit)
  recipient_email TEXT,
  -- Limites
  expires_at TIMESTAMPTZ,
  max_uses INTEGER,                             -- null = illimite
  use_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TIMESTAMPTZ,
  -- Audit
  last_used_at TIMESTAMPTZ,
  last_used_ip INET,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tokens_company ON public.public_tokens(company_id);
CREATE INDEX IF NOT EXISTS idx_tokens_resource ON public.public_tokens(scope, resource_id);

ALTER TABLE public.public_tokens ENABLE ROW LEVEL SECURITY;

-- Le user authentifie peut voir/creer/revoquer ses propres tokens
DROP POLICY IF EXISTS "tokens_select_own" ON public.public_tokens;
DROP POLICY IF EXISTS "tokens_insert_own" ON public.public_tokens;
DROP POLICY IF EXISTS "tokens_update_own" ON public.public_tokens;
DROP POLICY IF EXISTS "tokens_delete_own" ON public.public_tokens;

CREATE POLICY "tokens_select_own" ON public.public_tokens
  FOR SELECT USING (company_id = public.current_company_id() OR public.is_admin());
CREATE POLICY "tokens_insert_own" ON public.public_tokens
  FOR INSERT WITH CHECK (company_id = public.current_company_id());
CREATE POLICY "tokens_update_own" ON public.public_tokens
  FOR UPDATE USING (company_id = public.current_company_id() OR public.is_admin());
CREATE POLICY "tokens_delete_own" ON public.public_tokens
  FOR DELETE USING (company_id = public.current_company_id() OR public.is_admin());

-- Note : les API publiques (consultation sans auth) utilisent service_role
-- cote serveur pour bypasser RLS. La verification du token est faite manuellement.

-- Fonction utilitaire : valide un token et incremente le use_count.
-- Renvoie la ligne si valide, NULL sinon.
CREATE OR REPLACE FUNCTION public.consume_public_token(p_token TEXT, p_ip INET DEFAULT NULL)
RETURNS TABLE (
  company_id UUID,
  scope TEXT,
  resource_id UUID,
  recipient_email TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row RECORD;
BEGIN
  SELECT * INTO v_row FROM public.public_tokens WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF v_row.revoked_at IS NOT NULL THEN RETURN; END IF;
  IF v_row.expires_at IS NOT NULL AND v_row.expires_at < NOW() THEN RETURN; END IF;
  IF v_row.max_uses IS NOT NULL AND v_row.use_count >= v_row.max_uses THEN RETURN; END IF;

  UPDATE public.public_tokens
     SET use_count = use_count + 1,
         last_used_at = NOW(),
         last_used_ip = p_ip
   WHERE token = p_token;

  RETURN QUERY SELECT v_row.company_id, v_row.scope, v_row.resource_id, v_row.recipient_email;
END $$;

GRANT EXECUTE ON FUNCTION public.consume_public_token(TEXT, INET) TO anon, authenticated;

-- FIN 04_public_tokens.sql
