-- ═══════════════════════════════════════════════════════════
-- IO BILL — Migration v8.52 — Domaine de l'inbox achats
-- ═══════════════════════════════════════════════════════════
-- PROBLÈME : l'application affiche une adresse d'inbox achats en
-- @inbox.iobill.fr (`generate_inbox_alias`, v11), alors que le domaine
-- réellement configuré en réception chez Resend est **inbox.iobill.online**
-- (MX vérifié vers inbound-smtp.…amazonaws.com). Le domaine iobill.fr n'est
-- pas déclaré dans le compte Resend : un email envoyé à l'adresse affichée
-- n'atteint jamais le webhook, sans le moindre message d'erreur côté IO BILL.
--
-- Le webhook (api/_lib/inbox-handler.js) matche déjà sur la PARTIE LOCALE
-- seule (avant le @), donc changer le domaine des alias existants ne casse
-- aucun rattachement : une facture envoyée à l'ancienne adresse serait de
-- toute façon perdue avant d'arriver.
--
-- ⚠️ Si vous changez un jour de domaine de réception dans Resend, il faut
-- refaire passer cette migration avec le nouveau domaine — les deux doivent
-- rester identiques.
-- ═══════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────
-- 1) Génération des nouveaux alias sur le bon domaine
-- ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generate_inbox_alias()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.inbox_alias IS NULL THEN
    -- Le domaine DOIT être celui activé en « Receiving » dans Resend.
    NEW.inbox_alias := 'achats-' || substr(NEW.id::text, 1, 8) || '@inbox.iobill.online';
  END IF;
  RETURN NEW;
END $$;

-- ───────────────────────────────────────────────────────────
-- 2) Correction des alias existants
-- ───────────────────────────────────────────────────────────
-- La partie locale est conservée à l'identique : c'est elle qui identifie la
-- société côté webhook. Seul le domaine change.
UPDATE public.companies
   SET inbox_alias = split_part(inbox_alias, '@', 1) || '@inbox.iobill.online'
 WHERE inbox_alias IS NOT NULL
   AND inbox_alias NOT LIKE '%@inbox.iobill.online';

-- Companies sans alias (créées avant le trigger) : on en génère un.
UPDATE public.companies
   SET inbox_alias = 'achats-' || substr(id::text, 1, 8) || '@inbox.iobill.online'
 WHERE inbox_alias IS NULL;

-- ───────────────────────────────────────────────────────────
-- 3) Vérification — à lire après exécution
-- ───────────────────────────────────────────────────────────
-- Doit renvoyer 0 ligne :
--   SELECT id, inbox_alias FROM public.companies
--    WHERE inbox_alias NOT LIKE '%@inbox.iobill.online';
