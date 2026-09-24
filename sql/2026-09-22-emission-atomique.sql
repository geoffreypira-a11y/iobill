-- ═══════════════════════════════════════════════════════════════════
--  IO BILL — Émission atomique d'une facture
--  22 septembre 2026
--
--  LE DÉFAUT CORRIGÉ
--
--  À l'émission, le serveur faisait deux appels séparés :
--
--    1. allocate_document_number()  → le compteur avance ET EST VALIDÉ
--    2. UPDATE invoices …           → on écrit le numéro sur la facture
--
--  Deux requêtes HTTP distinctes, donc deux transactions distinctes. Si la
--  seconde échouait — déclencheur de hachage en défaut, réseau, contrainte —
--  le compteur avait déjà bougé et personne ne le rendait. Chaque tentative
--  ratée brûlait un numéro.
--
--  C'est ce qui a creusé les trous FAC-2026-0028 à 0034 et 0039 entre le 2 et
--  le 15 septembre 2026, pendant que la chaîne de hachage était en panne :
--  chaque clic sur « Émettre » consommait un numéro sans produire de facture.
--
--  LA CORRECTION
--
--  Une seule fonction fait les deux dans LA MÊME TRANSACTION. Si l'écriture
--  échoue, tout est annulé — compteur compris — et le numéro reste disponible
--  pour la tentative suivante.
--
--  AJOUT PUR : cette fonction n'existe pas encore, et rien d'existant n'est
--  modifié. Tant que le code déployé ne l'appelle pas, elle dort sans effet.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.issue_invoice(p_invoice_id UUID)
RETURNS public.invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions   -- `extensions` : digest() y vit, et le
                                       -- déclencheur de hachage s'en sert.
                                       -- L'oublier casse toute émission — on
                                       -- l'a appris le 12 septembre.
AS $$
DECLARE
  v_inv    public.invoices;
  v_number TEXT;
BEGIN
  -- Verrou sur la facture : deux émissions simultanées ne peuvent pas se
  -- croiser et réclamer le même numéro.
  SELECT * INTO v_inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Facture introuvable';
  END IF;

  -- La fonction est SECURITY DEFINER, donc elle contourne la RLS : on vérifie
  -- nous-mêmes que l'appelant a le droit d'émettre cette facture-là.
  IF current_user <> 'service_role'
     AND v_inv.company_id IS DISTINCT FROM public.current_company_id() THEN
    RAISE EXCEPTION 'Accès refusé';
  END IF;

  -- Idempotent : réémettre une facture déjà émise ne consomme pas un second
  -- numéro, elle est simplement renvoyée telle quelle. C'est ce qui rend un
  -- nouvel essai inoffensif après une erreur réseau.
  IF v_inv.status <> 'draft' THEN
    RETURN v_inv;
  END IF;

  -- Un numéro saisi à la main est conservé. Lui en réattribuer un créerait
  -- précisément le trou qu'on cherche à supprimer.
  IF v_inv.number LIKE 'BROUILLON-%' OR v_inv.number IS NULL THEN
    v_number := public.allocate_document_number(v_inv.company_id, 'invoice');
    IF v_number IS NULL THEN
      RAISE EXCEPTION 'Attribution du numéro impossible';
    END IF;
  ELSE
    v_number := v_inv.number;
  END IF;

  -- Le déclencheur BEFORE UPDATE calcule ici la chaîne de hachage et pose
  -- `issued_at`. S'il lève, la transaction entière est annulée — y compris
  -- l'incrément du compteur fait juste au-dessus. C'est tout l'objet de
  -- cette fonction.
  UPDATE public.invoices
     SET status = 'issued',
         number = v_number
   WHERE id = p_invoice_id
  RETURNING * INTO v_inv;

  RETURN v_inv;
END $$;

REVOKE ALL ON FUNCTION public.issue_invoice(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.issue_invoice(UUID) TO authenticated, service_role;

-- Vérification : doit renvoyer une ligne.
-- SELECT proname FROM pg_proc WHERE proname = 'issue_invoice';
