-- ═══════════════════════════════════════════════════════════════════
-- Inbox : rendre le traitement idempotent (audit du 10/09/2026)
--
-- Resend/Svix REJOUE un webhook tant qu'il n'a pas reçu de 2xx. Un
-- timeout après l'enregistrement des achats suffisait donc à les créer
-- une seconde fois : `handleInboxWebhook` insérait dans `purchases` puis
-- dans `inbox_messages`, sans aucune clé de déduplication.
--
-- Des achats en double gonflent la TVA DÉDUCTIBLE du bloc 3 de la
-- déclaration — une erreur en faveur de l'exploitant, donc la mauvaise
-- direction en cas de contrôle.
--
-- On mémorise l'identifiant du message (`svix-id`) et on l'unicise.
-- L'index est PARTIEL : les lignes antérieures, sans identifiant,
-- restent valides et ne se gênent pas entre elles.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.inbox_messages
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

COMMENT ON COLUMN public.inbox_messages.provider_message_id IS
  'Identifiant du webhook fournisseur (svix-id). Unique : garantit qu''un rejeu ne recrée pas les achats.';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_inbox_provider_message
  ON public.inbox_messages(provider_message_id)
  WHERE provider_message_id IS NOT NULL;
