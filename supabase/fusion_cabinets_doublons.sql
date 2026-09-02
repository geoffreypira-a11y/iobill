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
-- ⚠️ Tout est dans UNE transaction : en cas d'erreur (contrainte d'unicité
-- inattendue par exemple), rien n'est appliqué. Relisez le message d'erreur
-- avant de retenter.
--
-- ─── À ADAPTER ────────────────────────────────────────────
-- v_keeper : l'identifiant du cabinet À CONSERVER.
--            Choisissez celui dans lequel vous êtes connecté.
-- ═══════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE _fusion ON COMMIT DROP AS
SELECT '2d5f0727-bdc4-4240-b3b1-d9e4bbc338cc'::UUID AS keeper;

-- Les cabinets à fusionner : même SIREN que celui conservé, mais id différent.
CREATE TEMP TABLE _losers ON COMMIT DROP AS
SELECT f.id
  FROM public.accounting_firms f
 WHERE f.id <> (SELECT keeper FROM _fusion)
   AND f.siret IS NOT NULL
   AND LEFT(REGEXP_REPLACE(f.siret, '\D', '', 'g'), 9) = (
     SELECT LEFT(REGEXP_REPLACE(siret, '\D', '', 'g'), 9)
       FROM public.accounting_firms WHERE id = (SELECT keeper FROM _fusion)
   );

-- 1) Adhésions : un même utilisateur ne doit pas devenir deux fois membre du
--    cabinet conservé. On retire les adhésions redondantes avant de déplacer.
DELETE FROM public.firm_members fm
 WHERE fm.firm_id IN (SELECT id FROM _losers)
   AND EXISTS (
     SELECT 1 FROM public.firm_members k
      WHERE k.firm_id = (SELECT keeper FROM _fusion)
        AND k.user_id = fm.user_id
   );

UPDATE public.firm_members
   SET firm_id = (SELECT keeper FROM _fusion)
 WHERE firm_id IN (SELECT id FROM _losers);

-- 2) Tout le reste : simple déplacement.
UPDATE public.firm_client_links        SET firm_id = (SELECT keeper FROM _fusion) WHERE firm_id IN (SELECT id FROM _losers);
UPDATE public.firm_client_reminders    SET firm_id = (SELECT keeper FROM _fusion) WHERE firm_id IN (SELECT id FROM _losers);
UPDATE public.firm_invitation_requests SET firm_id = (SELECT keeper FROM _fusion) WHERE firm_id IN (SELECT id FROM _losers);
UPDATE public.firm_messages            SET firm_id = (SELECT keeper FROM _fusion) WHERE firm_id IN (SELECT id FROM _losers);
UPDATE public.firm_signals             SET firm_id = (SELECT keeper FROM _fusion) WHERE firm_id IN (SELECT id FROM _losers);
UPDATE public.firm_threads             SET firm_id = (SELECT keeper FROM _fusion) WHERE firm_id IN (SELECT id FROM _losers);
UPDATE public.notifications_firm       SET firm_id = (SELECT keeper FROM _fusion) WHERE firm_id IN (SELECT id FROM _losers);
UPDATE public.support_tickets          SET firm_id = (SELECT keeper FROM _fusion) WHERE firm_id IN (SELECT id FROM _losers);

-- 3) Les cabinets vidés peuvent partir.
DELETE FROM public.accounting_firms WHERE id IN (SELECT id FROM _losers);

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
