-- ═══════════════════════════════════════════════════════════════════
-- v8.38 — IO BILL : Mode garage (mode métier IOCAR)
--
-- Architecture : selon `invoices.external_source`, on active des modes
-- métier dans le rendu PDF Factur-X :
--   • iocar  → mode garage : bloc véhicule encadré, mentions VO/garantie
--   • iobtp  → mode BTP (futur) : chantier, retenue de garantie
--   • etc.
--
-- Cette migration ajoute la structure de données. Le rendu PDF est
-- modifié dans api/_lib/pdf-builder.js qui lit ces colonnes.
-- ═══════════════════════════════════════════════════════════════════

-- ── invoices.vehicle_meta : info véhicule structurée ────────
-- Stocke un JSON {plate, vin, marque, modele, finition, annee, kilometrage,
-- carburant, genre}. Le PDF en mode garage affiche un bloc encadré.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS vehicle_meta JSONB;

COMMENT ON COLUMN public.invoices.vehicle_meta IS
  'Métadonnées véhicule pour les factures venant d''IOCAR. JSON {plate, vin, marque, ...}. Affiché en bloc encadré sur le PDF en mode garage.';

-- ── invoices.business_mode : sous-mode d'affichage PDF ──────
-- Permet d'overrider le mode déduit de external_source si besoin.
-- Valeurs : 'standard' (par défaut), 'garage', 'btp', 'institute'.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS business_mode TEXT DEFAULT 'standard';

COMMENT ON COLUMN public.invoices.business_mode IS
  'Sous-mode métier pour le rendu PDF. Auto-déduit de external_source si non défini.';

-- ── invoices.business_mentions : mentions par-facture ────────
-- JSON {garantie, conditions_vente, cession, ...}. Mentions adaptées à
-- la facture spécifique (ex: durée garantie variable). Prioritaire sur
-- companies.business_mentions (fallback globaux).
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS business_mentions JSONB;

COMMENT ON COLUMN public.invoices.business_mentions IS
  'Mentions métier spécifiques à cette facture. Si null, fallback sur companies.business_mentions. JSON {garantie, conditions_vente, cession, ...}.';

-- ── companies.business_mentions : mentions métier réutilisables ──
-- JSON {garantie, conditions_vente, cession, ...}. Permet de personnaliser
-- les mentions affichées en bas du PDF pour les factures venant d'une
-- app source (au lieu de tout pousser dans `notes` ligne par ligne).
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS business_mentions JSONB;

COMMENT ON COLUMN public.companies.business_mentions IS
  'Mentions métier réutilisables affichées en bas du PDF en mode garage/BTP. JSON {garantie, conditions, cession, ...}.';

-- FIN migration v8.38
