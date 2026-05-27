-- ═══════════════════════════════════════════════════════════════════
-- IO BILL — Migration v8.43 — Clients externalisés (mono-source IOCAR)
--
-- Permet aux apps source (IOCAR, IOBTP, IOINSTITUTE) de gérer leur CRM
-- en source de vérité. IOBILL synchronise et verrouille ces clients
-- en lecture seule côté UI.
-- ═══════════════════════════════════════════════════════════════════

-- ─── 1) Colonnes external sur clients ─────────────────────────
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS external_source TEXT,
  ADD COLUMN IF NOT EXISTS external_id TEXT,
  ADD COLUMN IF NOT EXISTS external_synced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS external_managed BOOLEAN DEFAULT FALSE;

-- Index UNIQUE par couple (company_id, external_source, external_id)
-- pour garantir qu'un même client IOCAR n'est jamais dupliqué côté IOBILL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_clients_external
  ON public.clients(company_id, external_source, external_id)
  WHERE external_source IS NOT NULL AND external_id IS NOT NULL;

-- Index pour lookup rapide
CREATE INDEX IF NOT EXISTS idx_clients_external
  ON public.clients(external_source, external_id)
  WHERE external_source IS NOT NULL;

COMMENT ON COLUMN public.clients.external_source IS
  'App source qui gère ce client (iocar, iobtp, ioinstitute). NULL = créé manuellement dans IOBILL.';
COMMENT ON COLUMN public.clients.external_id IS
  'Identifiant du client dans l''app source (clients.id côté IOCAR).';
COMMENT ON COLUMN public.clients.external_managed IS
  'Si TRUE, le client est en lecture seule côté UI IOBILL (verrouillé).';

-- ─── 2) Helper SQL : suppression "soft" (les clients ne peuvent pas
-- être supprimés s'ils ont des factures liées, par RLS). On marque juste
-- archived_at au lieu de DELETE.
-- (Optionnel : à activer plus tard si besoin)
