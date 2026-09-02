-- ═══════════════════════════════════════════════════════════
-- IO BILL — Migration v8.55 — Inviter un cabinet pas encore inscrit
-- ═══════════════════════════════════════════════════════════
-- PROBLÈME : l'invitation cabinet ne fonctionne que dans un sens.
--   • Cabinet → client : si le client n'a pas de compte IO BILL, un lien en
--     attente est créé quand même (company_id NULL) et un email part.
--   • Client → cabinet : si le cabinet n'a pas de compte, l'API répond 404 et
--     rien n'est créé. Le client est bloqué.
--
-- CAUSE : `firm_client_links.firm_id` est NOT NULL. Impossible d'y stocker une
-- invitation vers un cabinet qui n'existe pas encore.
--
-- CHOIX : plutôt que d'assouplir cette contrainte — ce qui ferait apparaître
-- des lignes à firm_id NULL dans toutes les requêtes et politiques RLS
-- existantes du mode cabinet — on isole ces demandes dans leur propre table.
-- Elles deviennent de vrais liens le jour où le cabinet s'inscrit.
-- ═══════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────
-- 1) Table des demandes en attente d'inscription du cabinet
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.firm_invitation_requests (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- SIRET ou SIREN saisi par le client : le rapprochement se fait sur les
  -- 9 premiers chiffres (le SIREN), les deux formats étant acceptés.
  invited_siret  TEXT NOT NULL,
  invited_email  TEXT NOT NULL,
  message        TEXT,
  -- pending | converted | canceled
  status         TEXT NOT NULL DEFAULT 'pending',
  -- Renseigné à la conversion, pour tracer quel cabinet a repris la demande.
  firm_id        UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  converted_at   TIMESTAMPTZ,
  canceled_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_firm_req_company
  ON public.firm_invitation_requests (company_id, created_at DESC);
-- Index sur le SIREN : c'est la clé de rapprochement à l'inscription.
CREATE INDEX IF NOT EXISTS idx_firm_req_siren
  ON public.firm_invitation_requests (LEFT(REGEXP_REPLACE(invited_siret, '\D', '', 'g'), 9))
  WHERE status = 'pending';

ALTER TABLE public.firm_invitation_requests ENABLE ROW LEVEL SECURITY;

-- Lecture : la société qui a émis la demande (et les admins).
-- Écriture : service_role uniquement, via /api/firm-invitation.
DROP POLICY IF EXISTS "firm_requests_select" ON public.firm_invitation_requests;
CREATE POLICY "firm_requests_select" ON public.firm_invitation_requests
  FOR SELECT USING (company_id = public.current_company_id() OR public.is_admin());

GRANT SELECT ON public.firm_invitation_requests TO authenticated;

-- ───────────────────────────────────────────────────────────
-- 2) Rattachement automatique à l'inscription du cabinet
-- ───────────────────────────────────────────────────────────
-- Les cabinets sont créés côté client par un INSERT direct sur
-- accounting_firms (FirmOnboardingPage). Un trigger est donc le seul point
-- de passage garanti, quel que soit le chemin de création.
CREATE OR REPLACE FUNCTION public.attach_pending_firm_requests()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_siren TEXT;
  r RECORD;
BEGIN
  v_siren := LEFT(REGEXP_REPLACE(COALESCE(NEW.siret, ''), '\D', '', 'g'), 9);
  IF LENGTH(v_siren) < 9 THEN RETURN NEW; END IF;

  FOR r IN
    SELECT * FROM public.firm_invitation_requests
     WHERE status = 'pending'
       AND LEFT(REGEXP_REPLACE(invited_siret, '\D', '', 'g'), 9) = v_siren
  LOOP
    -- Ne pas doubler un lien déjà existant entre ce cabinet et ce client.
    IF NOT EXISTS (
      SELECT 1 FROM public.firm_client_links
       WHERE firm_id = NEW.id
         AND company_id = r.company_id
         AND status IN ('pending', 'accepted')
    ) THEN
      -- Les colonnes non citées (permissions, block_emission_on_open_signals)
      -- prennent leur valeur par défaut, comme lors d'une invitation normale.
      INSERT INTO public.firm_client_links (
        firm_id, company_id, invited_email, invited_siret,
        invitation_token, initiated_by, status, message_invite
      ) VALUES (
        NEW.id, r.company_id, r.invited_email, r.invited_siret,
        ENCODE(GEN_RANDOM_BYTES(32), 'hex'), 'client', 'pending', r.message
      );
    END IF;

    UPDATE public.firm_invitation_requests
       SET status = 'converted', converted_at = NOW(), firm_id = NEW.id
     WHERE id = r.id;
  END LOOP;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_attach_pending_firm_requests ON public.accounting_firms;
CREATE TRIGGER trg_attach_pending_firm_requests
  AFTER INSERT ON public.accounting_firms
  FOR EACH ROW EXECUTE FUNCTION public.attach_pending_firm_requests();

-- ───────────────────────────────────────────────────────────
-- 3) Vérification — à lire après exécution
-- ───────────────────────────────────────────────────────────
--   SELECT status, COUNT(*) FROM public.firm_invitation_requests GROUP BY status;
