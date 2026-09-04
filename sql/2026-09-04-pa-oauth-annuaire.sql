-- ═══════════════════════════════════════════════════════════════════════════
-- IO BILL — Raccordement OAuth2 des clients à la Plateforme Agréée + annuaire
-- ═══════════════════════════════════════════════════════════════════════════
-- À exécuter AVANT le déploiement.
--
-- Aucune ligne existante n'est modifiée : `auth_mode` vaut 'client_credentials'
-- par défaut, ce qui est exactement le comportement actuel. Les sociétés déjà
-- raccordées continuent de fonctionner à l'identique.
--
-- Tout tient dans pa_credentials : pas de nouvelle table, pas de RLS à écrire.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE pa_credentials
  -- Mode d'authentification
  ADD COLUMN IF NOT EXISTS auth_mode        text NOT NULL DEFAULT 'client_credentials',
  -- Jetons OAuth2 (grant type authorization_code uniquement)
  ADD COLUMN IF NOT EXISTS access_token     text,
  ADD COLUMN IF NOT EXISTS refresh_token    text,
  ADD COLUMN IF NOT EXISTS token_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS oauth_linked_at  timestamptz,
  -- État du tunnel en cours (anti-CSRF). Un seul tunnel ouvert par société.
  ADD COLUMN IF NOT EXISTS oauth_state      text,
  ADD COLUMN IF NOT EXISTS oauth_state_at   timestamptz,
  -- Statuts de vérification remontés par GET /v1.beta/oauth2_sessions/me
  ADD COLUMN IF NOT EXISTS company_verification_status       text,
  ADD COLUMN IF NOT EXISTS user_identity_verification_status text,
  -- Identité SUPER PDP et annuaire
  ADD COLUMN IF NOT EXISTS pa_company_id        text,
  ADD COLUMN IF NOT EXISTS directory_identifier text,
  ADD COLUMN IF NOT EXISTS directory_status     text;

ALTER TABLE pa_credentials
  DROP CONSTRAINT IF EXISTS pa_credentials_auth_mode_chk;
ALTER TABLE pa_credentials
  ADD CONSTRAINT pa_credentials_auth_mode_chk
  CHECK (auth_mode IN ('client_credentials', 'authorization_code'));

-- Le callback OAuth retrouve la société par son `state` : il doit être unique
-- et l'index rend la recherche immédiate.
CREATE UNIQUE INDEX IF NOT EXISTS pa_credentials_oauth_state_uidx
  ON pa_credentials (oauth_state)
  WHERE oauth_state IS NOT NULL;

-- Vérification (doit renvoyer 13 lignes)
SELECT column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'pa_credentials'
   AND column_name IN ('auth_mode','access_token','refresh_token','token_expires_at',
                       'oauth_linked_at','oauth_state','oauth_state_at',
                       'company_verification_status','user_identity_verification_status',
                       'pa_company_id','directory_identifier','directory_status')
 ORDER BY column_name;
