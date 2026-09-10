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

### 2. L'accès cabinet est-il en lecture seule ? — **OUI**

`firm_can_read` n'apparaît en écriture que dans deux policies, toutes deux sur
`firm_signals` : `fs_insert` (le cabinet crée un signalement chez son client —
c'est la fonction même du module, et elle exige en plus un rôle
`owner|partner|staff`) et `fs_update` (changer le statut du signalement).
Aucune policy `FOR ALL`, aucune écriture sur `invoices`, `credit_notes`,
`purchases`, `payments`, `clients`.

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

### C2 — La migration `v8_27_sprint3` visait une table inexistante *(corrigé)*

Elle crée `invoice_lines_firm_select` **`ON public.invoice_lines`**. Cette table
n'existe nulle part : ni dans `01_schema.sql`, ni dans `src/`, ni dans `api/`.
Les lignes de document sont dans `public.document_lines`
(`document_type` / `document_id`).

L'éditeur SQL Supabase exécutant un script dans une seule transaction, si la
table est bien absente en base, **tout le fichier a été annulé** — `firm_can_read`
compris. Le cabinet ne verrait alors strictement rien chez ses clients. Le bug
est resté invisible parce que le module n'a pas encore de client réel.

`sql/2026-09-10-cabinet-avoirs.sql` est écrit comme un réparateur idempotent :
il rétablit le helper et les policies `invoices` / `purchases` / `payments` /
`clients` à l'identique, remplace la policy fantôme par la bonne sur
`document_lines`, et supprime l'ancienne si elle existait malgré tout.

**À confirmer en base** — les trois requêtes de vérification sont en pied du
fichier SQL. La requête B tranche la question : si `invoice_lines` renvoie
`NULL`, la migration avait bien échoué.

### C3 — `bank_statements` n'existe dans aucun fichier SQL *(à confirmer)*

L'onglet « Relevés » du cabinet lit `bank_statements`, avec un commentaire qui
affirme « via RLS `firm_can_read` ». Cette table n'est définie dans **aucune**
migration du dépôt, et aucune policy ne la mentionne. Soit elle a été créée à la
main dans la console Supabase (schéma hors versionnement), soit elle n'existe
pas et l'onglet est vide en silence.

La requête B du fichier SQL le dit. Si la table existe, il faudra la verser dans
les migrations ; si elle n'existe pas, l'onglet est à retirer ou à écrire.

## Reste ouvert

- Faire un vrai test bout en bout du module : inviter un cabinet, accepter,
  vérifier ce qu'il voit, révoquer, vérifier que tout tombe.
- `document_lines` : la page cabinet n'affiche pas le détail des lignes
  aujourd'hui (elle ouvre les PDF). La policy est posée pour quand elle le fera.
