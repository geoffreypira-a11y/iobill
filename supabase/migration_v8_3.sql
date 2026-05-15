-- IO BILL - Migration v8.3 : colonnes signature simple + policies bucket company-logos
-- A executer UNE SEULE FOIS dans Supabase SQL Editor.
-- Non-destructif : utilise IF NOT EXISTS partout.

-- ─── 1. Colonnes signature simple sur quotes ───────────────────────
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS signed_by_name TEXT,
  ADD COLUMN IF NOT EXISTS refusal_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_quotes_status_signed
  ON public.quotes(company_id, status)
  WHERE status = 'signed';

-- ─── 2. Policies Storage pour bucket company-logos ───────────────────
-- Permet : upload par l'owner de la company, lecture par service_role
-- (la lecture publique se fait via URL signee generee cote serveur)

-- Supprimer policies existantes si elles existent (idempotent)
DROP POLICY IF EXISTS "company_logos_authenticated_upload" ON storage.objects;
DROP POLICY IF EXISTS "company_logos_authenticated_update" ON storage.objects;
DROP POLICY IF EXISTS "company_logos_authenticated_delete" ON storage.objects;
DROP POLICY IF EXISTS "company_logos_authenticated_read" ON storage.objects;

-- INSERT : un user authentifie peut uploader dans le dossier de SA company
CREATE POLICY "company_logos_authenticated_upload" ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'company-logos'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM public.companies WHERE user_id = auth.uid()
      UNION
      SELECT cu.company_id::text FROM public.company_users cu WHERE cu.user_id = auth.uid()
    )
  );

-- UPDATE : meme chose
CREATE POLICY "company_logos_authenticated_update" ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'company-logos'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM public.companies WHERE user_id = auth.uid()
      UNION
      SELECT cu.company_id::text FROM public.company_users cu WHERE cu.user_id = auth.uid()
    )
  );

-- DELETE
CREATE POLICY "company_logos_authenticated_delete" ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'company-logos'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM public.companies WHERE user_id = auth.uid()
      UNION
      SELECT cu.company_id::text FROM public.company_users cu WHERE cu.user_id = auth.uid()
    )
  );

-- SELECT : authenticated peut voir SES propres logos
CREATE POLICY "company_logos_authenticated_read" ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'company-logos'
    AND (storage.foldername(name))[1] IN (
      SELECT id::text FROM public.companies WHERE user_id = auth.uid()
      UNION
      SELECT cu.company_id::text FROM public.company_users cu WHERE cu.user_id = auth.uid()
    )
  );

-- Recharger les caches Supabase
NOTIFY pgrst, 'reload schema';

-- FIN migration_v8_3.sql
