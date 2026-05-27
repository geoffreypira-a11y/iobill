-- ═══════════════════════════════════════════════════════════════════
-- IO BILL — v8.45 — RESET clients (avant resync depuis IOCAR)
--
-- ⚠️ ATTENTION : supprime TOUS les clients qui n'ont PAS de factures liées.
-- Les clients avec factures sont conservés mais déverrouillés (external_managed=false)
-- pour que le sync IOCAR les ré-attribue via external_id au prochain push.
-- ═══════════════════════════════════════════════════════════════════

-- 1. Vérification AVANT (montre ce qui va être touché)
-- Décommente pour vérifier avant de lancer la suppression
/*
SELECT
  COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM invoices WHERE client_id = clients.id)
                    AND NOT EXISTS (SELECT 1 FROM credit_notes WHERE client_id = clients.id)) AS to_delete,
  COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM invoices WHERE client_id = clients.id)
                    OR EXISTS (SELECT 1 FROM credit_notes WHERE client_id = clients.id)) AS to_keep_unlocked,
  COUNT(*) AS total
FROM clients;
*/

-- 2. Suppression des clients SANS facture ni avoir liés
DELETE FROM public.clients
WHERE NOT EXISTS (SELECT 1 FROM public.invoices WHERE client_id = clients.id)
  AND NOT EXISTS (SELECT 1 FROM public.credit_notes WHERE client_id = clients.id);

-- 3. Pour les clients restants (avec factures) : les déverrouiller pour permettre
--    le ré-attribut external_id au prochain sync depuis IOCAR
UPDATE public.clients
SET external_managed = FALSE,
    external_source = NULL,
    external_id = NULL,
    external_synced_at = NULL;

-- Le prochain polling IOCAR fera correspondre par SIRET/email (fallback)
-- puis attribuera l'external_id correct.
