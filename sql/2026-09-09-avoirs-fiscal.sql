-- ═══════════════════════════════════════════════════════════════════
-- Avoirs : de quoi reprendre exactement la TVA de la vente annulée
--
-- Audit du 9 septembre 2026 (iocar/docs/AUDIT-AVOIRS.md, A5/A8/A9).
--
-- `invoices` porte le régime de TVA et les données de marge (art. 297 A) ;
-- `credit_notes` ne portait ni l'un ni l'autre. Trois conséquences :
--
--   • le PDF de l'avoir ne pouvait pas afficher la mention art. 297 A,
--     faute de savoir que la vente relevait de la marge ;
--   • la TVA sur marge d'une vente annulée restait due à jamais, la
--     déclaration n'ayant rien à soustraire ;
--   • le numéro de la facture d'origine — mention obligatoire, et BT-25
--     du Factur-X — n'était nulle part : seul l'UUID interne était connu.
--
-- Colonnes strictement additives, toutes NULL/0 par défaut : les avoirs
-- existants restent lisibles et le code retombe sur son comportement
-- antérieur quand elles sont vides.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.credit_notes
  ADD COLUMN IF NOT EXISTS vat_regime TEXT,
  ADD COLUMN IF NOT EXISTS source_invoice_number TEXT,
  ADD COLUMN IF NOT EXISTS purchase_price_cents BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS marge_cents BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tva_marge_cents BIGINT DEFAULT 0;

-- ── Le document lui-même ────────────────────────────────────────────
-- `invoices` a reçu vehicle_meta et business_mode en v8.38 (mode garage),
-- `credit_notes` jamais. Le pont transmet bien le véhicule et les mentions
-- du garage depuis la v8.183 côté IO CAR, mais l'insertion les jetait faute
-- de colonnes : l'avoir sortait sans bloc véhicule, sans plaque et sans
-- référence au livre de police, là où la facture les affiche.
ALTER TABLE public.credit_notes
  ADD COLUMN IF NOT EXISTS vehicle_meta JSONB,
  ADD COLUMN IF NOT EXISTS business_mentions JSONB,
  ADD COLUMN IF NOT EXISTS business_mode TEXT DEFAULT 'standard',
  -- `terms` existe sur quotes et invoices depuis 01_schema, pas sur
  -- credit_notes : c'est la colonne qu'imprime le PDF sous « CONDITIONS ».
  -- Sans elle, la phrase « Montant à rembourser au client… » transmise par le
  -- pont n'avait nulle part où se ranger.
  ADD COLUMN IF NOT EXISTS terms TEXT;

COMMENT ON COLUMN public.credit_notes.vat_regime IS
  'Régime de la vente annulée : ''standard'' ou ''margin_297a''. Pilote la mention art. 297 A sur le PDF.';
COMMENT ON COLUMN public.credit_notes.source_invoice_number IS
  'Numéro de la facture d''origine (ex. VEH-2026-0107). Mention obligatoire, et BT-25 du Factur-X.';
COMMENT ON COLUMN public.credit_notes.tva_marge_cents IS
  'TVA sur marge à REPRENDRE (art. 297 A). Se soustrait de la TVA sur marge collectée dans la déclaration.';

-- Rattrapage : le numéro de la facture d'origine est déductible du lien
-- existant, pour les avoirs déjà en base.
UPDATE public.credit_notes cn
   SET source_invoice_number = i.number
  FROM public.invoices i
 WHERE cn.invoice_id = i.id
   AND cn.source_invoice_number IS NULL;

-- ═══════════════════════════════════════════════════════════════════
-- Rattrapage : colonnes d'`invoices` écrites par le code mais jamais
-- versionnées (ajoutées à la main dans la console Supabase). Sans elles,
-- un environnement reconstruit depuis ce dépôt serait cassé.
-- Idempotent : sans effet là où elles existent déjà.
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS vat_regime TEXT,
  ADD COLUMN IF NOT EXISTS purchase_price_cents BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS marge_cents BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tva_marge_cents BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS debours JSONB,
  ADD COLUMN IF NOT EXISTS debour_total_cents BIGINT DEFAULT 0;
