-- ═══════════════════════════════════════════════════════════════════
--  IO BILL — Catalogue produits
--  22 septembre 2026
--
--  AJOUT PUR. Ce script crée une table qui n'existe pas encore et n'en
--  modifie aucune autre. Aucune donnée existante n'est touchée : ni les
--  factures, ni les devis, ni les clients, ni les lignes de documents.
--  Le rejouer deux fois ne casse rien (IF NOT EXISTS partout).
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- Ce qui s'écrit sur la ligne du devis ou de la facture.
  designation   TEXT NOT NULL,
  reference     TEXT,                    -- facultative : votre code article
  description   TEXT,                    -- détail long, repris en désignation si rempli

  -- Le tarif catalogue. Il est COPIÉ dans la ligne au moment de l'insertion,
  -- jamais référencé : modifier un prix ici ne doit rien changer à un document
  -- déjà établi. Une facture qui se met à jour toute seule n'est pas une
  -- facture.
  unit_price_ht_cents INTEGER NOT NULL DEFAULT 0,
  unit          TEXT NOT NULL DEFAULT 'u',
  vat_rate      NUMERIC(5,2) NOT NULL DEFAULT 20,

  -- Un produit retiré du catalogue ne doit plus être proposé, mais le
  -- supprimer ferait perdre son historique de prix. On l'archive.
  archived      BOOLEAN NOT NULL DEFAULT FALSE,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- La recherche se fait à la frappe, sur la désignation et la référence.
CREATE INDEX IF NOT EXISTS products_company_idx
  ON public.products (company_id, archived, designation);

-- ── Sécurité : mêmes règles que les autres tables porteuses de company_id ──
-- Une entreprise ne voit et ne modifie que son propre catalogue.
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "products_select" ON public.products;
DROP POLICY IF EXISTS "products_insert" ON public.products;
DROP POLICY IF EXISTS "products_update" ON public.products;
DROP POLICY IF EXISTS "products_delete" ON public.products;

CREATE POLICY "products_select" ON public.products
  FOR SELECT USING (company_id = public.current_company_id() OR public.is_admin());

CREATE POLICY "products_insert" ON public.products
  FOR INSERT WITH CHECK (company_id = public.current_company_id());

CREATE POLICY "products_update" ON public.products
  FOR UPDATE USING (company_id = public.current_company_id() OR public.is_admin())
             WITH CHECK (company_id = public.current_company_id() OR public.is_admin());

CREATE POLICY "products_delete" ON public.products
  FOR DELETE USING (company_id = public.current_company_id() OR public.is_admin());

-- Vérification : doit renvoyer 4 lignes (select, insert, update, delete).
-- SELECT policyname FROM pg_policies WHERE tablename = 'products';
