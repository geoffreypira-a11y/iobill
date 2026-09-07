-- ═══════════════════════════════════════════════════════════════════════════
-- IO BILL — Mémoriser le plan souscrit (mensuel / annuel)
-- ═══════════════════════════════════════════════════════════════════════════
-- Le webhook Stripe n'enregistrait que `stripe_subscription_id` : impossible
-- de savoir si un abonné payait au mois ou à l'année. Le MRR comptait donc
-- TOUS les abonnés au tarif mensuel.
--
-- `sub_plan` est renseigné à partir du checkout. NULL = inconnu (tout
-- l'existant) → traité comme mensuel, exactement comme avant.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS sub_plan text;

ALTER TABLE companies
  DROP CONSTRAINT IF EXISTS companies_sub_plan_chk;
ALTER TABLE companies
  ADD CONSTRAINT companies_sub_plan_chk
  CHECK (sub_plan IS NULL OR sub_plan IN ('pro_monthly', 'pro_yearly'));

-- ─── Reprise des abonnés déjà en place ────────────────────────────────────
-- Les abonnements souscrits avant cette colonne ne sont pas rattrapables
-- automatiquement : à renseigner à la main pour ceux qui sont à l'année.
--
-- Remplace le SIRET par celui de la société concernée, puis exécute :
--
-- UPDATE companies SET sub_plan = 'pro_yearly' WHERE siret = '82887201000024';
--
-- Contrôle :
SELECT legal_name, siret, sub_status, is_exempt, sub_plan, subscribed_at
  FROM companies
 WHERE sub_status = 'active'
 ORDER BY subscribed_at NULLS LAST;
