-- ──────────────────────────────────────────────────────────────
-- IO BILL — Migration v8.14.5
-- Toggle d'affichage de l'IBAN par facture + default société
-- ──────────────────────────────────────────────────────────────

-- 1) Sur invoices : flag par facture
-- NULL traité comme TRUE (rétro-compat factures existantes)
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS show_payment_iban BOOLEAN;

COMMENT ON COLUMN public.invoices.show_payment_iban IS
  'Affiche l''IBAN sur le PDF de la facture. NULL traité comme TRUE pour rétro-compat.';

-- 2) Sur companies : default appliqué aux nouvelles factures
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS show_payment_iban_default BOOLEAN DEFAULT TRUE;

COMMENT ON COLUMN public.companies.show_payment_iban_default IS
  'Valeur par défaut de show_payment_iban appliquée à toute nouvelle facture.';

-- FIN migration v8.14.5
