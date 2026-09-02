-- ═══════════════════════════════════════════════════════════
-- IO BILL — Migration v8.48
--   1) Journal d'envoi des emails (email_log) + accusés Resend
--   2) Relances : horodatage du dernier passage (anti-spam / instantané)
-- ═══════════════════════════════════════════════════════════
-- Objectif : savoir, pour CHAQUE email envoyé (facture, devis, avoir,
-- relance, notification), s'il est bien parti, s'il a été *délivré*,
-- ouvert, mis en spam (plainte) ou rejeté (bounce), et pourquoi.
--
-- Les statuts "delivered / opened / bounced / complained" sont alimentés
-- par le webhook Resend (voir api/_lib/email-log.js, op=email_events).
-- ═══════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────
-- 1) TABLE email_log
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_log (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,

  -- Nature de l'envoi : invoice | quote | credit_note | reminder | notification
  kind                TEXT NOT NULL,
  document_type       TEXT,
  document_id         UUID,
  document_number     TEXT,

  recipient           TEXT,
  subject             TEXT,

  provider            TEXT NOT NULL DEFAULT 'resend',
  provider_message_id TEXT,

  -- queued | sent | delivered | opened | clicked | delayed | bounced
  -- | complained | failed | skipped
  status              TEXT NOT NULL DEFAULT 'queued',
  -- Raison lisible en cas de failed/skipped (ex: "missing_recipient_email")
  error               TEXT,

  -- Pour les relances : courteous | first | second | final
  reminder_template   TEXT,
  -- email | sms
  channel             TEXT NOT NULL DEFAULT 'email',
  -- manual | auto | cron  → d'où vient l'envoi
  trigger_source      TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at             TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  opened_at           TIMESTAMPTZ,
  bounced_at          TIMESTAMPTZ,
  last_event_at       TIMESTAMPTZ,
  meta                JSONB
);

CREATE INDEX IF NOT EXISTS idx_email_log_company
  ON public.email_log (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_log_document
  ON public.email_log (document_type, document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_log_provider_msg
  ON public.email_log (provider_message_id);

ALTER TABLE public.email_log ENABLE ROW LEVEL SECURITY;

-- Lecture : la société propriétaire (et les admins). L'écriture est réservée
-- au service_role (API serveur + webhook Resend) : aucune policy INSERT/UPDATE.
DROP POLICY IF EXISTS "email_log_select" ON public.email_log;
CREATE POLICY "email_log_select" ON public.email_log
  FOR SELECT USING (company_id = public.current_company_id() OR public.is_admin());

GRANT SELECT ON public.email_log TO authenticated;

-- ───────────────────────────────────────────────────────────
-- 2) companies : dernier passage du moteur de relances
-- ───────────────────────────────────────────────────────────
-- Sert à deux choses :
--   - afficher "dernière vérification" dans les réglages ;
--   - limiter le déclenchement instantané (1 passage / 10 min / société).
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS reminders_last_run_at TIMESTAMPTZ;

-- ───────────────────────────────────────────────────────────
-- 3) OPTIONNEL — relances vraiment continues sans dépendre du plan Vercel
-- ───────────────────────────────────────────────────────────
-- Le cron Vercel ne passe qu'une fois par jour sur le plan Hobby. Si tu veux
-- que les relances partent dans l'heure où elles deviennent dues, active
-- pg_cron + pg_net dans Supabase (Database → Extensions) puis décommente :
--
--   SELECT cron.schedule(
--     'iobill-relances',
--     '*/15 * * * *',
--     $$
--       SELECT net.http_post(
--         url     := 'https://app.iobill.online/api/cron-reminders',
--         headers := jsonb_build_object(
--           'Content-Type', 'application/json',
--           'Authorization', 'Bearer <CRON_SECRET>'
--         ),
--         body    := '{}'::jsonb
--       );
--     $$
--   );
--
-- Le moteur est idempotent (reminder_count + last_reminder_sent_at) : le
-- repasser toutes les 15 min n'envoie jamais deux fois la même relance.
