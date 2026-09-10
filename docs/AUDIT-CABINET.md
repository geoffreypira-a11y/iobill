# Audit — module cabinet (`firm_*`)

Date : 2026-09-10 · Périmètre : IOBILL, accès d'un cabinet comptable à la
comptabilité d'un abonné.

## Ce qui a été vérifié

Le module repose sur un seul point d'entrée : `public.firm_can_read(company_id)`,
fonction `SECURITY DEFINER`, `STABLE`, `search_path` figé. Elle renvoie vrai si
l'utilisateur courant est membre d'un cabinet lié à cette société **avec
`firm_client_links.status = 'accepted'`**. Toutes les policies cabinet passent
par elle.

### 1. La révocation coupe-t-elle vraiment l'accès ? — **OUI**

`api/firm-invitation.js`, action `revoke` : `status` passe à `'revoked'` et
`revoked_at` est horodaté. `firm_can_read` exigeant `'accepted'`, l'accès tombe
immédiatement, pour toutes les tables d'un coup. Même chose pour `refuse`
(`status = 'refused'`).

Les deux parties peuvent révoquer : un `owner`/`partner` du cabinet, **ou** le
propriétaire de la société. C'est le bon comportement — l'abonné n'est pas
prisonnier de son cabinet.

La fiche client refuse en plus de s'afficher si `link.status !== 'accepted'`,
et le tableau de bord ne liste que les liens `accepted_at IS NOT NULL AND
revoked_at IS NULL`. Défense en profondeur cohérente.

### 2. L'accès cabinet est-il en lecture seule ? — **OUI sur la comptabilité**

Relevé en base des policies qui référencent `firm_can_read` : **11 en `SELECT`**
(`invoices`, `credit_notes`, `purchases`, `payments`, `clients`, `companies`,
`quotes`, `bank_statements`, `pa_events`, `pa_inbound_invoices`,
`document_lines` — cf. C2) et **2 en `INSERT`** :

- `firm_signals` / `fs_insert` — le cabinet crée un signalement chez son client ;
- `firm_threads` / `ft_insert` — il ouvre un fil de discussion.

C'est la fonction même du module. Aucune policy `FOR ALL`, aucune écriture sur
une donnée comptable : le cabinet ne peut ni créer, ni modifier, ni supprimer
une facture, un avoir, un achat ou un encaissement.

Réserve : `firm_signals` porte une **seconde** policy `INSERT`, `fs_insert_firm`,
qui ne passe pas par `firm_can_read` — voir C4.

`pa_credentials` (secrets PDP) : RLS activé, **aucune** policy → refus total
côté navigateur, seul le `service_role` y accède. Le cabinet ne voit jamais les
identifiants de transmission. Correct.

## Ce qui n'allait pas

### C1 — Les avoirs étaient invisibles pour le comptable *(corrigé)*

`credit_notes` n'avait aucune policy cabinet, et les pages `firm2/` ne lisaient
jamais cette table. Résultat : l'onglet **TVA** de la fiche client et les KPI de
l'onglet **Aperçu** calculaient « CA HT facturé », « TVA collectée » et surtout
**« TVA nette à reverser »** à partir des seules factures.

Un avoir émis ne venait donc jamais en déduction : le comptable déclarait une
TVA collectée et un chiffre d'affaires **surévalués** (art. 272-1 CGI — la TVA
d'un avoir régulier est récupérable).

C'est exactement le trou qui avait été bouché côté abonné (`VatPage`,
`vat-sync`, `DashboardCharts`) ; le module cabinet était resté en dehors. Or
c'est *lui* qui sert à établir la déclaration.

Correction :
- policy `credit_notes_firm_select` (lecture seule) ;
- `OverviewTab` : lecture des avoirs `status = 'issued'` de la période, déduits
  du CA HT et de la TVA collectée, plus un KPI « Avoirs émis » ;
- `VatTab` : déduction taux par taux dans la ventilation, comme pour les
  factures, avec repli sur les totaux quand `vat_breakdown` est vide ;
- `VatSummaryTable` : ligne « Avoirs émis (déduction) » dépliable, montants
  affichés en négatif, motif de l'avoir visible, PDF ouvrable — le comptable
  voit la déduction et peut la justifier au lieu de la subir.

Seuls les avoirs **émis** comptent : un brouillon n'annule rien.

### C2 — La migration `v8_27_sprint3` visait une table inexistante *(corrigé, et hypothèse initiale démentie)*

Elle crée `invoice_lines_firm_select` **`ON public.invoice_lines`**. Cette table
n'existe pas : `to_regclass('public.invoice_lines')` renvoie `NULL` en base. Les
lignes de document sont dans `public.document_lines`
(`document_type` / `document_id`).

**J'en avais tiré une conclusion fausse.** J'avais écrit que l'éditeur SQL
Supabase exécutant un script en une seule transaction, tout le fichier avait dû
être annulé — helper `firm_can_read` compris — et donc que le cabinet ne voyait
rien chez ses clients. La vérification en base dit l'inverse :

- `firm_can_read` **existe** ;
- 10 tables portent leur policy cabinet (`invoices`, `purchases`, `payments`,
  `clients`, `companies`, `quotes`, `bank_statements`, `pa_events`,
  `pa_inbound_invoices`, `credit_notes`).

Le fichier est donc bien passé ; seule la policy `invoice_lines` est tombée. **Le
module cabinet n'a jamais été cassé.** Le correctif restait sans risque parce
qu'il était écrit idempotent, mais l'alerte était injustifiée.

Ce qui reste vrai et corrigé : la policy visait une table fantôme, elle est
remplacée par `document_lines_firm_select` sur la vraie table.

⚠️ **Non confirmé en base** : `document_lines_firm_select` n'apparaît pas dans
le relevé des policies après passage du SQL, alors que `credit_notes_firm_select`
y est. Sans conséquence fonctionnelle aujourd'hui — la page cabinet ouvre les
PDF, elle n'affiche pas le détail des lignes — mais à élucider.

### C3 — `bank_statements` existe mais n'est dans aucune migration *(constat révisé)*

L'onglet « Relevés » du cabinet lit `bank_statements`, et l'abonné y dépose ses
relevés depuis `MyFirmSettingsPage` (`insert` / `delete`). J'avais supposé que la
table pouvait ne pas exister et l'onglet être vide en silence. **Faux** : la
table existe, RLS activé, avec deux policies — `bank_stmt_owner` (`ALL`, le
propriétaire) et `bank_stmt_firm_read` (`SELECT`, le cabinet). L'utilisateur
confirme que la fonctionnalité marche en production.

Le vrai reproche est ailleurs : **cette table n'est décrite dans aucune migration
du dépôt.** Elle a été créée à la main dans la console Supabase. Le jour où la
base est remontée à neuf depuis les fichiers versionnés, elle manque — et avec
elle une fonctionnalité qui tourne. À rapatrier dans `supabase/`.

### C4 — `firm_signals` a deux policies INSERT *(en cours d'analyse)*

Le relevé en base montre `fs_insert` **et** `fs_insert_firm`. Les policies
permissives se cumulent en **OU** : il suffit qu'une seule accepte.

- `fs_insert` (versionnée, v8.27) est stricte : rôle `owner|partner|staff` du
  cabinet **et** `firm_can_read(company_id)`, donc un lien accepté avec ce client.
- `fs_insert_firm` **ne mentionne pas** `firm_can_read` — elle n'apparaît pas
  dans le relevé des policies qui le référencent. Elle ne vérifie donc pas le
  lien cabinet↔client, et elle n'existe dans aucun fichier SQL du dépôt.

Si son `WITH CHECK` se contente de « je suis membre d'un cabinet », n'importe
quel cabinet inscrit peut créer un signalement chez n'importe quelle société.
Pas de fuite de données comptables — c'est une écriture, pas une lecture — mais
de l'écriture non sollicitée chez un abonné qui n'a rien signé, et le
contournement complet de `fs_insert`.

Définition à récupérer avant de conclure. Même question pour `fs_delete` : qui
peut supprimer un signalement ?

## Reste ouvert

- **`fs_insert_firm`** — récupérer son `WITH CHECK` et décider : la supprimer si
  elle fait doublon avec `fs_insert`, ou la resserrer sur `firm_can_read`.
- **`document_lines_firm_select`** — comprendre pourquoi elle n'apparaît pas en
  base après passage du SQL.
- **Schéma hors versionnement** — `bank_statements` et `fs_insert_firm` existent
  en base sans être dans le dépôt. Il en existe peut-être d'autres : un
  inventaire `pg_policies` / `pg_tables` comparé aux fichiers `supabase/` dirait
  l'ampleur de la dérive.
- **Test bout en bout** — inviter un cabinet, accepter, vérifier ce qu'il voit,
  révoquer, vérifier que tout tombe.
- `document_lines` : la page cabinet n'affiche pas le détail des lignes
  aujourd'hui (elle ouvre les PDF). La policy est posée pour quand elle le fera.

## Méthode — ce que cet audit rappelle

Deux de mes constats de départ (C2, C3) partaient d'une lecture des fichiers
versionnés et concluaient sur l'état de la base. Les deux se sont révélés faux
une fois la base interrogée. La leçon vaut pour la suite : **sur ce projet, le
dépôt n'est pas la source de vérité du schéma** — une partie a été créée à la
main. Tout constat portant sur la base doit être vérifié par requête avant
d'être annoncé.
