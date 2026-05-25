-- ════════════════════════════════════════════════════════════════════
-- v8.32 — Crédit de TVA reporté (CA3 ligne 22, CA12)
--
-- Quand une déclaration finit en crédit (déductible > collectée),
-- le crédit s'impute sur la déclaration suivante au moment où l'utilisateur
-- clique "Marquer déclarée" (officialisation juridique).
--
-- Cette colonne stocke le crédit REÇU de la déclaration précédente,
-- pour calcul transparent et historique.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.vat_returns
  ADD COLUMN IF NOT EXISTS credit_carried_in_cents BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.vat_returns.credit_carried_in_cents IS
  'Crédit de TVA reporté depuis la déclaration précédente (CA3 ligne 22). En cents.';

ALTER TABLE public.vat_returns
  ADD COLUMN IF NOT EXISTS credit_remaining_cents BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.vat_returns.credit_remaining_cents IS
  'Crédit de TVA restant à reporter sur la prochaine déclaration. En cents.
   = max(0, deductible + credit_carried_in - collected).';

CREATE INDEX IF NOT EXISTS idx_vat_returns_company_declared_period
  ON public.vat_returns (company_id, status, period_end DESC);
