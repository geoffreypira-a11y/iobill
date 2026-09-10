-- ════════════════════════════════════════════════════════════════════
-- 2026-09-10 — Accès cabinet : avoirs manquants + migration v8.27 cassée
-- ════════════════════════════════════════════════════════════════════
--
-- ── CONSTAT 1 : les avoirs sont invisibles pour le cabinet ──────────
-- Le module cabinet donne au comptable un accès LECTURE aux factures,
-- achats, encaissements et clients de son client (helper firm_can_read).
-- `credit_notes` n'a jamais reçu de policy.
--
-- Conséquence fiscale : l'onglet TVA de la fiche client calcule la TVA
-- collectée et la « TVA nette à reverser » à partir des seules factures.
-- Un avoir émis ne vient jamais en déduction → le comptable déclare une
-- TVA collectée et un CA SURÉVALUÉS (art. 272-1 CGI : la TVA d'un avoir
-- régulier est récupérable).
--
-- ── CONSTAT 2 : migration_v8_27_sprint3.sql visait une table absente ─
-- Elle crée une policy « invoice_lines_firm_select » ON public.invoice_lines.
-- Cette table N'EXISTE PAS dans le schéma : les lignes de document sont
-- dans public.document_lines (colonnes document_type / document_id).
-- `invoice_lines` n'apparaît nulle part ailleurs — ni dans 01_schema.sql,
-- ni dans src/, ni dans api/.
--
-- Si la table est bien absente en base, ce CREATE POLICY a levé
-- « relation "public.invoice_lines" does not exist » et, l'éditeur SQL
-- Supabase exécutant le script dans UNE transaction, TOUT le fichier a
-- été annulé : firm_can_read, et les policies invoices / purchases /
-- payments / clients / firm_signals n'existent alors pas. Le cabinet ne
-- verrait donc RIEN chez ses clients. Le bug est resté invisible parce
-- que le module cabinet n'a pas encore de client réel en production.
--
-- Ce fichier est donc RÉPARATEUR et IDEMPOTENT : il rétablit le helper
-- et les policies de lecture cabinet quel que soit l'état de la base, et
-- remplace la policy fantôme par la bonne, sur document_lines.
-- Toutes les policies cabinet sont en LECTURE SEULE (FOR SELECT).
-- ════════════════════════════════════════════════════════════════════


-- ── 1) Helper (rétabli à l'identique de v8.27) ──────────────────────
CREATE OR REPLACE FUNCTION public.firm_can_read(p_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.firm_client_links fcl
    JOIN public.firm_members fm ON fm.firm_id = fcl.firm_id
    WHERE fcl.company_id = p_company_id
      AND fcl.status = 'accepted'
      AND fm.user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.firm_can_read(UUID) TO authenticated;


-- ── 2) LA correction attendue : les avoirs ──────────────────────────
DROP POLICY IF EXISTS "credit_notes_firm_select" ON public.credit_notes;
CREATE POLICY "credit_notes_firm_select" ON public.credit_notes
  FOR SELECT TO authenticated
  USING (public.firm_can_read(company_id));

COMMENT ON POLICY "credit_notes_firm_select" ON public.credit_notes IS
  'Le cabinet lié (firm_client_links.status = accepted) lit les avoirs de son client. Lecture seule.';


-- ── 3) Lignes de document : la bonne table ──────────────────────────
-- Remplace la policy fantôme « invoice_lines_firm_select ». Couvre les
-- lignes de facture ET d'avoir, chacune via son document parent.
DROP POLICY IF EXISTS "document_lines_firm_select" ON public.document_lines;
CREATE POLICY "document_lines_firm_select" ON public.document_lines
  FOR SELECT TO authenticated
  USING (public.firm_can_read(company_id));

-- Ménage : supprimer la policy fantôme si la table existait malgré tout.
DO $$ BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "invoice_lines_firm_select" ON public.invoice_lines';
EXCEPTION WHEN undefined_table THEN NULL;
END $$;


-- ── 4) Rétablissement défensif des policies de v8.27 ────────────────
-- Sans effet si elles sont déjà en place (DROP + CREATE à l'identique).
DROP POLICY IF EXISTS "invoices_firm_select" ON public.invoices;
CREATE POLICY "invoices_firm_select" ON public.invoices
  FOR SELECT TO authenticated USING (public.firm_can_read(company_id));

DROP POLICY IF EXISTS "purchases_firm_select" ON public.purchases;
CREATE POLICY "purchases_firm_select" ON public.purchases
  FOR SELECT TO authenticated USING (public.firm_can_read(company_id));

DROP POLICY IF EXISTS "payments_firm_select" ON public.payments;
CREATE POLICY "payments_firm_select" ON public.payments
  FOR SELECT TO authenticated USING (public.firm_can_read(company_id));

DROP POLICY IF EXISTS "clients_firm_select" ON public.clients;
CREATE POLICY "clients_firm_select" ON public.clients
  FOR SELECT TO authenticated USING (public.firm_can_read(company_id));


-- ════════════════════════════════════════════════════════════════════
-- VÉRIFICATION — à passer APRÈS, et à me renvoyer
-- ════════════════════════════════════════════════════════════════════
--
-- A) Toutes les policies d'accès cabinet, avec leur commande.
--    Attendu : 5 lignes cmd = SELECT (credit_notes, document_lines,
--    invoices, purchases, payments, clients = 6), plus les policies
--    firm_signals. AUCUNE autre ligne en UPDATE/INSERT/DELETE/ALL que
--    fs_insert / fs_update sur firm_signals.
--
--   SELECT tablename, policyname, cmd
--   FROM pg_policies
--   WHERE schemaname = 'public'
--     AND (COALESCE(qual,'') || COALESCE(with_check,'')) LIKE '%firm_can_read%'
--   ORDER BY cmd, tablename;
--
-- B) La table fantôme et la table réellement lue par la page cabinet.
--    invoice_lines DOIT renvoyer 0 (elle n'existe pas et c'est normal).
--    bank_statements : si 0, l'onglet « Relevés » du cabinet lit une
--    table inexistante — à me dire.
--
--   SELECT
--     to_regclass('public.invoice_lines')   AS invoice_lines,
--     to_regclass('public.document_lines')  AS document_lines,
--     to_regclass('public.bank_statements') AS bank_statements;
--
-- C) Les policies firm_signals ont-elles survécu à v8.27 ?
--    Attendu : fs_select, fs_insert, fs_update, fs_delete.
--
--   SELECT policyname, cmd FROM pg_policies
--   WHERE schemaname = 'public' AND tablename = 'firm_signals'
--   ORDER BY policyname;
-- ════════════════════════════════════════════════════════════════════
