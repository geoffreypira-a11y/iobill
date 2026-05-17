-- ═══════════════════════════════════════════════════════════
-- IO BILL — Migration v8.13.7 — Policies Storage purchases-attach
-- ═══════════════════════════════════════════════════════════
-- Garantit que le bucket "purchases-attach" existe et a les
-- bonnes policies RLS pour permettre upload/lecture par les
-- utilisateurs authentifies (chacun pour sa company).
-- ═══════════════════════════════════════════════════════════

-- 1) S'assurer que le bucket existe (private)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'purchases-attach',
  'purchases-attach',
  false,
  10485760,  -- 10 MB
  ARRAY['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = 10485760,
  allowed_mime_types = ARRAY['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

-- 2) Drop des anciennes policies (au cas ou)
DROP POLICY IF EXISTS "purchases_attach_insert" ON storage.objects;
DROP POLICY IF EXISTS "purchases_attach_select" ON storage.objects;
DROP POLICY IF EXISTS "purchases_attach_update" ON storage.objects;
DROP POLICY IF EXISTS "purchases_attach_delete" ON storage.objects;

-- 3) Recreer les policies : l'utilisateur peut tout faire dans son dossier company_id
-- Le path doit commencer par <company_id>/...
-- Exemple : 82f4b242-42ac-452f-87c1-0282390ef004/abc-Facture.pdf

CREATE POLICY "purchases_attach_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'purchases-attach'
    AND (storage.foldername(name))[1] = public.current_company_id()::text
  );

CREATE POLICY "purchases_attach_select"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'purchases-attach'
    AND (storage.foldername(name))[1] = public.current_company_id()::text
  );

CREATE POLICY "purchases_attach_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'purchases-attach'
    AND (storage.foldername(name))[1] = public.current_company_id()::text
  );

CREATE POLICY "purchases_attach_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'purchases-attach'
    AND (storage.foldername(name))[1] = public.current_company_id()::text
  );

NOTIFY pgrst, 'reload schema';
