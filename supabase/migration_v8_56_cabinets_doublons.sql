-- ═══════════════════════════════════════════════════════════
-- IO BILL — Migration v8.56 — Cabinets en double
-- ═══════════════════════════════════════════════════════════
-- PROBLÈME OBSERVÉ : 8 lignes « Cabinet Essais » portant le même SIRET,
-- créées en 1,2 seconde — un double-envoi du formulaire d'onboarding, qui
-- fait un INSERT direct sur accounting_firms sans garde-fou.
--
-- CONSÉQUENCE : la recherche d'un cabinet par SIRET renvoyait une ligne
-- arbitraire. Une demande client → cabinet partait donc vers un homonyme sans
-- utilisateur, invisible pour le cabinet réellement utilisé. C'est ce qui
-- donnait l'impression que le sens client → cabinet « ne marche pas ».
--
-- ⚠️ ORDRE D'EXÉCUTION : l'étape 1 (nettoyage) DOIT précéder l'étape 2
-- (index unique), sinon la création de l'index échoue sur les doublons.
-- ═══════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────
-- 1) Nettoyage des doublons
-- ───────────────────────────────────────────────────────────
-- Pour chaque SIREN, on garde UN cabinet : celui qui a le plus de clients
-- (c'est lui qui porte l'historique), puis le plus ancien en cas d'égalité.
--
-- On ne supprime que des cabinets SANS AUCUN client. Un cabinet qui a des
-- liens clients n'est jamais touché : la fusion de deux cabinets réellement
-- utilisés ne s'improvise pas, elle doit être décidée au cas par cas.
--
-- ⚠️ AVANT DE SUPPRIMER, lancez d'abord ce SELECT pour voir ce qui partira :
--
--   WITH ranked AS (
--     SELECT f.id, f.name, f.siret, f.created_at,
--            (SELECT COUNT(*) FROM public.firm_client_links l WHERE l.firm_id = f.id) AS clients,
--            (SELECT COUNT(*) FROM public.firm_members m WHERE m.firm_id = f.id) AS membres,
--            ROW_NUMBER() OVER (
--              PARTITION BY LEFT(REGEXP_REPLACE(f.siret, '\D', '', 'g'), 9)
--              ORDER BY (SELECT COUNT(*) FROM public.firm_client_links l WHERE l.firm_id = f.id) DESC,
--                       f.created_at ASC
--            ) AS rang
--       FROM public.accounting_firms f
--      WHERE f.siret IS NOT NULL
--   )
--   SELECT * FROM ranked ORDER BY siret, rang;
--
-- Les lignes de rang 1 sont conservées, les autres supprimées si clients = 0.

CREATE TEMP TABLE _firms_a_supprimer AS
WITH ranked AS (
  SELECT f.id,
         (SELECT COUNT(*) FROM public.firm_client_links l WHERE l.firm_id = f.id) AS clients,
         ROW_NUMBER() OVER (
           PARTITION BY LEFT(REGEXP_REPLACE(f.siret, '\D', '', 'g'), 9)
           ORDER BY (SELECT COUNT(*) FROM public.firm_client_links l WHERE l.firm_id = f.id) DESC,
                    f.created_at ASC
         ) AS rang
    FROM public.accounting_firms f
   WHERE f.siret IS NOT NULL
     AND LENGTH(REGEXP_REPLACE(f.siret, '\D', '', 'g')) >= 9
)
SELECT id FROM ranked WHERE rang > 1 AND clients = 0;

-- Les adhésions des cabinets supprimés partent avec eux : sans ça, l'utilisateur
-- garderait des adhésions pointant dans le vide, et useMyFirm pourrait encore
-- le faire atterrir sur un cabinet fantôme.
DELETE FROM public.firm_members
 WHERE firm_id IN (SELECT id FROM _firms_a_supprimer);

DELETE FROM public.accounting_firms
 WHERE id IN (SELECT id FROM _firms_a_supprimer);

DROP TABLE _firms_a_supprimer;

-- ───────────────────────────────────────────────────────────
-- 1bis) Garde-fou : doublons NON automatiquement résolubles
-- ───────────────────────────────────────────────────────────
-- Si deux cabinets d'un même SIREN portent TOUS LES DEUX des clients, le
-- nettoyage ci-dessus n'en supprime aucun — et l'index unique de l'étape 2
-- échouerait, laissant la migration à mi-chemin. On s'arrête ici avec un
-- message explicite : ces cas demandent une FUSION, décrite dans le README de
-- la migration, et non une suppression.
DO $$
DECLARE
  v_sirens TEXT;
BEGIN
  SELECT string_agg(siren, ', ') INTO v_sirens
    FROM (
      SELECT LEFT(REGEXP_REPLACE(siret, '\D', '', 'g'), 9) AS siren
        FROM public.accounting_firms
       WHERE siret IS NOT NULL
         AND LENGTH(REGEXP_REPLACE(siret, '\D', '', 'g')) >= 9
       GROUP BY 1
      HAVING COUNT(*) > 1
    ) d;

  IF v_sirens IS NOT NULL THEN
    RAISE EXCEPTION
      'Doublons de cabinet restants sur le(s) SIREN suivant(s) : %. '
      'Plusieurs de ces cabinets portent des clients : il faut les FUSIONNER '
      '(déplacer firm_client_links, firm_members, firm_signals, firm_messages, '
      'firm_threads, firm_client_reminders, firm_invitation_requests, '
      'notifications_firm et support_tickets vers le cabinet conservé) avant de '
      'relancer cette migration.', v_sirens;
  END IF;
END $$;

-- ───────────────────────────────────────────────────────────
-- 2) Prévention — un seul cabinet par SIREN
-- ───────────────────────────────────────────────────────────
-- L'unicité porte sur le SIREN (9 chiffres) et non sur le SIRET : un cabinet
-- inscrit au SIREN et un autre au SIRET du même établissement sont la même
-- entité, et c'est exactement l'ambiguïté qu'on veut interdire.
CREATE UNIQUE INDEX IF NOT EXISTS uq_accounting_firms_siren
  ON public.accounting_firms (LEFT(REGEXP_REPLACE(siret, '\D', '', 'g'), 9))
  WHERE siret IS NOT NULL
    AND LENGTH(REGEXP_REPLACE(siret, '\D', '', 'g')) >= 9;

-- ───────────────────────────────────────────────────────────
-- 3) Vérification — à lire après exécution
-- ───────────────────────────────────────────────────────────
-- Doit renvoyer 0 ligne :
--   SELECT LEFT(REGEXP_REPLACE(siret,'\D','','g'),9) AS siren, COUNT(*)
--     FROM public.accounting_firms
--    WHERE siret IS NOT NULL
--    GROUP BY 1 HAVING COUNT(*) > 1;
