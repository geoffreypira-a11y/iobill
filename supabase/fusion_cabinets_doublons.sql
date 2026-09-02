-- ═══════════════════════════════════════════════════════════
-- IO BILL — Fusion de cabinets en double (script ponctuel)
-- ═══════════════════════════════════════════════════════════
-- À utiliser quand plusieurs `accounting_firms` partagent un SIREN et que
-- PLUSIEURS d'entre eux portent des clients : la migration v8.56 refuse alors
-- de supprimer quoi que ce soit, et c'est volontaire.
--
-- Ce script ne supprime AUCUNE donnée métier : tout est déplacé vers le
-- cabinet conservé, les cabinets vidés sont ensuite supprimés.
--
-- Les 9 tables portant un firm_id sont traitées :
--   firm_client_links, firm_client_reminders, firm_invitation_requests,
--   firm_members, firm_messages, firm_signals, firm_threads,
--   notifications_firm, support_tickets
--
-- NOTE — pas de table temporaire : l'éditeur SQL de Supabase valide chaque
-- instruction séparément, une TEMP TABLE ... ON COMMIT DROP disparaîtrait
-- aussitôt créée. Le SIREN et l'identifiant conservé sont donc écrits en dur.
--
-- ⚠️ L'ordre compte : la suppression des cabinets vidés vient EN DERNIER,
-- sinon les instructions suivantes ne trouveraient plus rien à déplacer.
--
-- ─── À ADAPTER ────────────────────────────────────────────
--   :keeper → identifiant du cabinet À CONSERVER (celui où vous êtes connecté)
--   :siren  → les 9 premiers chiffres du SIRET concerné
-- ═══════════════════════════════════════════════════════════

BEGIN;

-- 1) Adhésions : un même utilisateur ne doit pas devenir deux fois membre du
--    cabinet conservé. On retire les adhésions redondantes AVANT de déplacer.
DELETE FROM public.firm_members fm
 WHERE fm.firm_id IN (
         SELECT f.id FROM public.accounting_firms f
          WHERE f.id <> '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
            AND LEFT(REGEXP_REPLACE(f.siret, '\D', '', 'g'), 9) = '123456789'
       )
   AND EXISTS (
         SELECT 1 FROM public.firm_members k
          WHERE k.firm_id = '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
            AND k.user_id = fm.user_id
       );

UPDATE public.firm_members SET firm_id = '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
 WHERE firm_id IN (SELECT f.id FROM public.accounting_firms f
                    WHERE f.id <> '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
                      AND LEFT(REGEXP_REPLACE(f.siret, '\D', '', 'g'), 9) = '123456789');

-- 2) Tout le reste : simple déplacement.
UPDATE public.firm_client_links SET firm_id = '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
 WHERE firm_id IN (SELECT f.id FROM public.accounting_firms f
                    WHERE f.id <> '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
                      AND LEFT(REGEXP_REPLACE(f.siret, '\D', '', 'g'), 9) = '123456789');

UPDATE public.firm_client_reminders SET firm_id = '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
 WHERE firm_id IN (SELECT f.id FROM public.accounting_firms f
                    WHERE f.id <> '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
                      AND LEFT(REGEXP_REPLACE(f.siret, '\D', '', 'g'), 9) = '123456789');

UPDATE public.firm_invitation_requests SET firm_id = '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
 WHERE firm_id IN (SELECT f.id FROM public.accounting_firms f
                    WHERE f.id <> '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
                      AND LEFT(REGEXP_REPLACE(f.siret, '\D', '', 'g'), 9) = '123456789');

UPDATE public.firm_messages SET firm_id = '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
 WHERE firm_id IN (SELECT f.id FROM public.accounting_firms f
                    WHERE f.id <> '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
                      AND LEFT(REGEXP_REPLACE(f.siret, '\D', '', 'g'), 9) = '123456789');

UPDATE public.firm_signals SET firm_id = '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
 WHERE firm_id IN (SELECT f.id FROM public.accounting_firms f
                    WHERE f.id <> '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
                      AND LEFT(REGEXP_REPLACE(f.siret, '\D', '', 'g'), 9) = '123456789');

UPDATE public.firm_threads SET firm_id = '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
 WHERE firm_id IN (SELECT f.id FROM public.accounting_firms f
                    WHERE f.id <> '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
                      AND LEFT(REGEXP_REPLACE(f.siret, '\D', '', 'g'), 9) = '123456789');

UPDATE public.notifications_firm SET firm_id = '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
 WHERE firm_id IN (SELECT f.id FROM public.accounting_firms f
                    WHERE f.id <> '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
                      AND LEFT(REGEXP_REPLACE(f.siret, '\D', '', 'g'), 9) = '123456789');

UPDATE public.support_tickets SET firm_id = '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
 WHERE firm_id IN (SELECT f.id FROM public.accounting_firms f
                    WHERE f.id <> '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
                      AND LEFT(REGEXP_REPLACE(f.siret, '\D', '', 'g'), 9) = '123456789');

-- 3) Les cabinets vidés peuvent partir — EN DERNIER.
DELETE FROM public.accounting_firms
 WHERE id <> '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID
   AND LEFT(REGEXP_REPLACE(siret, '\D', '', 'g'), 9) = '123456789';

-- 4) Empêcher que ça recommence : un seul cabinet par SIREN.
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounting_firms_siren
  ON public.accounting_firms (LEFT(REGEXP_REPLACE(siret, '\D', '', 'g'), 9))
  WHERE siret IS NOT NULL
    AND LENGTH(REGEXP_REPLACE(siret, '\D', '', 'g')) >= 9;

COMMIT;

-- ───────────────────────────────────────────────────────────
-- Vérification — doit renvoyer 0 ligne
-- ───────────────────────────────────────────────────────────
--   SELECT LEFT(REGEXP_REPLACE(siret,'\D','','g'),9) AS siren, COUNT(*)
--     FROM public.accounting_firms WHERE siret IS NOT NULL
--    GROUP BY 1 HAVING COUNT(*) > 1;
