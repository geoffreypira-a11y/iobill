-- ═══════════════════════════════════════════════════════════════════
-- IO BILL — v8.44 — Nettoyage des doublons clients (FACULTATIF)
--
-- Supprime les clients sans external_id ET sans factures liées,
-- pour permettre au sync IOCAR de tout reconstruire proprement.
--
-- ⚠ À LANCER UNE SEULE FOIS, après déploiement v8.44, AVANT de cliquer
-- sur "sync_all_clients" depuis IOCAR.
--
-- Avant de lancer : compte les clients qui seraient supprimés :
--
--   SELECT COUNT(*) FROM public.clients c
--   WHERE c.external_id IS NULL
--     AND NOT EXISTS (SELECT 1 FROM public.invoices i WHERE i.client_id = c.id)
--     AND NOT EXISTS (SELECT 1 FROM public.credit_notes cn WHERE cn.client_id = c.id);
-- ═══════════════════════════════════════════════════════════════════

-- Suppression effective (DÉCOMMENTE pour lancer) :
/*
DELETE FROM public.clients
WHERE external_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.invoices  WHERE client_id = clients.id)
  AND NOT EXISTS (SELECT 1 FROM public.credit_notes WHERE client_id = clients.id);
*/

-- Alternative : marquer external_managed=FALSE pour les clients à factures
-- liées sans external_id, pour qu'ils soient déverrouillés côté UI IOBILL
-- (laisse l'utilisateur décider quoi en faire).
/*
UPDATE public.clients
SET external_managed = FALSE
WHERE external_id IS NULL
  AND EXISTS (SELECT 1 FROM public.invoices WHERE client_id = clients.id);
*/
