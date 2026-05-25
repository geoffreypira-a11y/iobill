-- ════════════════════════════════════════════════════════════════════
-- v8.30 — Policies Storage pour le bucket firm-attachments (privé)
--
-- Permet aux firm_members ET aux clients liés (companies.user_id)
-- de lire et écrire les pièces jointes des threads auxquels ils
-- ont accès.
--
-- Path attendu : "thread_<thread_id>/<filename>"
-- ════════════════════════════════════════════════════════════════════

-- ─── INSERT : autoriser l'upload si user a accès au thread ───────────
DROP POLICY IF EXISTS "fa_insert" ON storage.objects;
CREATE POLICY "fa_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'firm-attachments'
    AND EXISTS (
      SELECT 1 FROM public.firm_threads t
      WHERE ('thread_' || t.id::text) = split_part(name, '/', 1)
        AND (
          EXISTS (
            SELECT 1 FROM public.firm_members fm
            WHERE fm.firm_id = t.firm_id AND fm.user_id = auth.uid()
          )
          OR EXISTS (
            SELECT 1 FROM public.companies c
            WHERE c.id = t.company_id AND c.user_id = auth.uid()
          )
        )
    )
  );

-- ─── SELECT : autoriser la lecture (même condition) ──────────────────
DROP POLICY IF EXISTS "fa_select" ON storage.objects;
CREATE POLICY "fa_select" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'firm-attachments'
    AND EXISTS (
      SELECT 1 FROM public.firm_threads t
      WHERE ('thread_' || t.id::text) = split_part(name, '/', 1)
        AND (
          EXISTS (
            SELECT 1 FROM public.firm_members fm
            WHERE fm.firm_id = t.firm_id AND fm.user_id = auth.uid()
          )
          OR EXISTS (
            SELECT 1 FROM public.companies c
            WHERE c.id = t.company_id AND c.user_id = auth.uid()
          )
        )
    )
  );

-- Note : pour les URLs signées (créées par l'API en service_role),
-- ces policies ne sont pas nécessaires côté lecture. Mais on les met
-- quand même au cas où on veut un accès direct depuis le client.
