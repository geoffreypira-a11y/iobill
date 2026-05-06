-- ═══════════════════════════════════════════════════════════════════════════
--  IO BILL — SÉCURITÉ (RLS) v1.0
--  À exécuter APRÈS 01_schema.sql
-- ═══════════════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────
--  ACTIVATION RLS sur toutes les tables
-- ──────────────────────────────────────────────────────────────
ALTER TABLE public.companies            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_interactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quotes               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_lines       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_notes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchases            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vat_returns          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.urssaf_returns       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_exports   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_connections     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_transactions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log            ENABLE ROW LEVEL SECURITY;

-- ──────────────────────────────────────────────────────────────
--  FONCTIONS UTILITAIRES
-- ──────────────────────────────────────────────────────────────

-- Renvoie l'ID de l'entreprise du user courant
CREATE OR REPLACE FUNCTION public.current_company_id()
RETURNS UUID
LANGUAGE SQL SECURITY DEFINER SET search_path = public STABLE
AS $$
  SELECT id FROM public.companies WHERE user_id = auth.uid() LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.current_company_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_company_id() TO authenticated;

-- Admin platform (pour Anthony)
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE SQL SECURITY DEFINER SET search_path = public STABLE
AS $$
  SELECT COALESCE((SELECT is_admin FROM public.companies WHERE user_id = auth.uid() LIMIT 1), FALSE);
$$;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- ──────────────────────────────────────────────────────────────
--  POLICIES — COMPANIES
-- ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "companies_select_own" ON public.companies;
DROP POLICY IF EXISTS "companies_insert_own" ON public.companies;
DROP POLICY IF EXISTS "companies_update_own" ON public.companies;
DROP POLICY IF EXISTS "companies_delete_own" ON public.companies;

CREATE POLICY "companies_select_own" ON public.companies
  FOR SELECT USING (user_id = auth.uid() OR public.is_admin());

CREATE POLICY "companies_insert_own" ON public.companies
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "companies_update_own" ON public.companies
  FOR UPDATE USING (user_id = auth.uid() OR public.is_admin())
              WITH CHECK (user_id = auth.uid() OR public.is_admin());

CREATE POLICY "companies_delete_own" ON public.companies
  FOR DELETE USING (user_id = auth.uid() OR public.is_admin());

-- ──────────────────────────────────────────────────────────────
--  POLICIES GÉNÉRIQUES (toutes les tables ayant company_id)
-- ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'clients','client_interactions','quotes','invoices','document_lines',
    'credit_notes','payments','purchases','vat_returns','urssaf_returns',
    'accounting_exports','bank_connections','bank_transactions'
  ]) LOOP
    EXECUTE format('DROP POLICY IF EXISTS "%I_select" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%I_insert" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%I_update" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "%I_delete" ON public.%I', t, t);

    EXECUTE format($f$
      CREATE POLICY "%I_select" ON public.%I
        FOR SELECT USING (company_id = public.current_company_id() OR public.is_admin())
    $f$, t, t);

    EXECUTE format($f$
      CREATE POLICY "%I_insert" ON public.%I
        FOR INSERT WITH CHECK (company_id = public.current_company_id())
    $f$, t, t);

    EXECUTE format($f$
      CREATE POLICY "%I_update" ON public.%I
        FOR UPDATE USING (company_id = public.current_company_id() OR public.is_admin())
                   WITH CHECK (company_id = public.current_company_id() OR public.is_admin())
    $f$, t, t);

    EXECUTE format($f$
      CREATE POLICY "%I_delete" ON public.%I
        FOR DELETE USING (company_id = public.current_company_id() OR public.is_admin())
    $f$, t, t);
  END LOOP;
END $$;

-- ──────────────────────────────────────────────────────────────
--  AUDIT LOG : lecture seule pour le user, écriture serveur uniquement
-- ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "audit_select_own" ON public.audit_log;
DROP POLICY IF EXISTS "audit_no_user_write" ON public.audit_log;

CREATE POLICY "audit_select_own" ON public.audit_log
  FOR SELECT USING (company_id = public.current_company_id() OR public.is_admin());

-- Aucun INSERT/UPDATE/DELETE depuis le client : on n'ajoute pas de policy permissive
-- Les triggers s'exécutent en SECURITY DEFINER, donc bypass RLS.

-- ──────────────────────────────────────────────────────────────
--  STORAGE BUCKETS (à exécuter dans Supabase Dashboard manuellement
--  OU via API, voir 03_functions.sql pour le détail)
-- ──────────────────────────────────────────────────────────────
-- Bucket "invoices-pdf"     : public:false, factures émises (PDF + Factur-X)
-- Bucket "purchases-attach" : public:false, fichiers achats fournisseurs
-- Bucket "company-assets"   : public:false, logos et brandings
-- Policies : seules les fichiers dont le path commence par "<company_id>/" sont accessibles

-- FIN 02_security.sql
