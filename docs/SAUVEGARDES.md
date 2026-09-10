# Sauvegardes — IO BILL

## Pourquoi ça compte ici plus qu'ailleurs

Le projet Supabase est sur le **plan gratuit**, qui n'offre aucune sauvegarde
automatique restaurable. Il n'y a donc pas de filet en dessous : les fichiers
décrits ici sont la **seule** protection des données de tes abonnés.

## Comment ça marche

Deux déclencheurs, un seul et même code (`api/_lib/backup.js`) :

| Déclencheur | Chemin | Authentification |
|---|---|---|
| Cron quotidien, 3h | `api/backup-cron.js` | header `x-vercel-cron`, ou `Bearer CRON_SECRET` |
| Bouton admin | `api/admin.js` → `backup_save` | jeton d'un admin connecté |

Le cron est déclaré dans `vercel.json`. Il ne pouvait pas passer par l'action
admin : celle-ci exige `authenticate()`, donc une session — qu'un cron n'a pas.

Chaque passage écrit **deux** objets dans le bucket privé `backups` :

- `backup_AAAA-MM-JJ.json` — l'historique, **conservé 30 jours** ;
- `backup_latest.json` — écrasé à chaque fois, pour l'affichage et le bouton
  « Télécharger ».

## Rotation, pas écrasement

Les fichiers datés de plus de 30 jours sont purgés à chaque passage. On ne se
contente **pas** d'écraser, et c'est délibéré : une sauvegarde qui écrase ne
protège que des pannes remarquées sous 24 h. Une perte silencieuse — une ligne
effacée, un champ vidé par un bug — se découvre des jours plus tard, quand la
bonne copie a déjà été remplacée par l'état abîmé. Trente jours d'historique
coûtent quelques mégaoctets sur un quota d'un gigaoctet.

## Ce qui est sauvegardé

La ligne `companies` **en entier** (elle ne l'était qu'en 8 champs : adresse,
n° de TVA, IBAN, mentions et compteurs de numérotation étaient perdus), puis
par société : `invoices`, `credit_notes`, `quotes`, **`document_lines`**,
`clients`, `purchases`, **`payments`**, `vat_returns`, `urssaf_returns`,
`bank_statements`, `pa_events`, `pa_inbound_invoices`, `support_tickets`.

Et en global : `accounting_firms`, `firm_members`, `firm_client_links`.

`document_lines` est vitale : les lignes des factures, devis et avoirs
n'existent **que** là — `invoices` ne porte aucun instantané. Sans elle, une
facture restaurée a un numéro, une date et un total, mais pas une seule
désignation : ce n'est plus une facture au sens de l'art. 242 nonies A CGI.

Chaque sauvegarde embarque un **manifeste** (nombre de lignes par table), affiché
après un enregistrement manuel. Une table qui repart à zéro se voit, au lieu de
passer inaperçue.

### Pas encore couvert

Le Storage (PDF de factures, pièces jointes d'achats) n'est pas inclus — seules
les lignes de base le sont.

## Vérifier une sauvegarde

```bash
node scripts/audit/verifier-sauvegarde.mjs ~/Téléchargements/iobill_backup_AAAA-MM-JJ.json
```

Il ne restaure rien : il lit et il juge. Il refuse un fichier dont les documents
n'ont pas de lignes, dont la société n'est copiée qu'en extrait, ou qui a plus
de 7 jours (signe que le cron ne tourne plus), et signale les incohérences —
factures payées sans encaissement, documents émis sans `content_hash`,
manifeste qui ne correspond pas au contenu.

Code retour 0 = exploitable, 1 = non exploitable.

## Le point qui reste ouvert

Les sauvegardes sont dans le bucket `backups` **du même projet Supabase que les
données qu'elles protègent**. Si le projet est perdu, les copies partent avec.
Une sauvegarde rangée à l'intérieur de ce qu'elle protège n'en est pas tout à
fait une : il faut une copie hors site — téléchargement mensuel avec le bouton
existant, ou envoi automatique par e-mail (Resend est déjà configuré).

Décision non prise à ce jour.

## Historique

Avant septembre 2026 : sauvegarde **manuelle uniquement**, 5 tables sur une
quarantaine, `document_lines` et `payments` absentes, `companies` en extrait.
La dernière sauvegarde réelle datait du 21/07/2026 — 51 jours.
