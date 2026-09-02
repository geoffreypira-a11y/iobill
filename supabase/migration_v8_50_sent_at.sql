-- ═══════════════════════════════════════════════════════════
-- IO BILL — Migration v8.50 — Colonne sent_at sur quotes et invoices
-- ═══════════════════════════════════════════════════════════
-- BUG CORRIGÉ : un devis envoyé par email restait « Brouillon », et une
-- facture envoyée restait « Émise ».
--
-- Cause : `api/send-document.js` marque le document comme envoyé avec
--
--     UPDATE quotes SET status = 'sent', sent_at = now() WHERE id = ...
--
-- mais la colonne `sent_at` n'a jamais existé sur `quotes` ni sur `invoices`
-- (seul `credit_notes` l'a reçue en v8.14). PostgREST rejetait donc la
-- requête ENTIÈRE en 400 — `status` compris — et l'erreur était avalée
-- silencieusement côté serveur. Le document restait dans son statut initial,
-- et n'apparaissait jamais dans l'espace client.
--
-- Après cette migration, les trois chemins qui déclarent un document
-- transmis fonctionnent : envoi par email, copie du lien public, et
-- l'action « Marquer comme envoyé ».
-- ═══════════════════════════════════════════════════════════

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

-- Rattrapage : les documents déjà signés/refusés/convertis ont forcément été
-- transmis au client à un moment. On leur donne une date d'envoi plausible
-- (leur date d'émission) pour que l'historique reste cohérent, sans toucher
-- au statut, qui est déjà correct.
UPDATE public.quotes
   SET sent_at = issue_date::TIMESTAMPTZ
 WHERE sent_at IS NULL
   AND status IN ('sent', 'signed', 'refused', 'converted');

UPDATE public.invoices
   SET sent_at = COALESCE(issued_at, issue_date::TIMESTAMPTZ)
 WHERE sent_at IS NULL
   AND status IN ('sent', 'partial', 'paid', 'overdue');
