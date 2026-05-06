# 🦉 IO BILL — Guide de déploiement & tests end-to-end

> **OWL'S INDUSTRY** — SaaS facturation/comptabilité français
> Stack : React + Vite + PWA · Supabase EU · Vercel Functions · Stripe · Yousign · Bridge · Mistral OCR · Resend

---

## 📋 Sommaire

1. [Prérequis : créer les comptes](#1-prérequis--créer-les-comptes)
2. [Supabase — base de données + auth + storage](#2-supabase)
3. [Stripe — abonnements + paiements](#3-stripe)
4. [Resend — emails transactionnels](#4-resend)
5. [Yousign — signature électronique](#5-yousign)
6. [Bridge — agrégation bancaire PSD2](#6-bridge)
7. [Mistral — OCR factures fournisseurs](#7-mistral)
8. [Vercel — déploiement + crons](#8-vercel)
9. [Tests end-to-end manuels](#9-tests-end-to-end)
10. [Mise en production](#10-mise-en-production)

---

## 1. Prérequis : créer les comptes

Crée des comptes sur les services suivants (tu peux commencer en **mode test/sandbox** partout) :

| Service | Plan minimum | Coût | URL |
|---|---|---|---|
| Supabase | Free puis Pro (25 $/mo) | gratuit pour démarrer | supabase.com |
| Vercel | Hobby puis Pro (20 $/mo) | gratuit pour démarrer | vercel.com |
| Stripe | Standard | 1,4 % + 0,25 € par transaction | stripe.com |
| Resend | Free 3 000 mails/mois | gratuit pour démarrer | resend.com |
| Yousign | Pay-as-you-go | ~1,50 € par signature | yousign.com |
| Bridge | Pay-per-use | ~5 € / utilisateur / mois | bridgeapi.io |
| Mistral | Free + pay-as-you-go | quasi gratuit pour OCR | console.mistral.ai |
| Domaine | Cloudflare | ~10 €/an | cloudflare.com |

> 💡 **Étape par étape** : tu peux mettre en prod **uniquement avec Supabase + Vercel + Stripe + Resend** (90 % du produit). Yousign/Bridge/Mistral/OCR sont des **modules** activables plus tard.

---

## 2. Supabase

### 2.1 Créer le projet

1. Va sur **supabase.com** → "New project"
2. **Region : Frankfurt (EU central)** ← important pour le RGPD
3. Note quelque part : `Project URL`, `anon key`, `service_role key`
4. Mets **un mot de passe Postgres fort** (utile si besoin SQL direct)

### 2.2 Exécuter les SQL dans l'ordre

Dans l'onglet **SQL Editor** de Supabase, exécute ces 5 fichiers **dans cet ordre** :

```
supabase/01_schema.sql           → 15 tables + index (V1)
supabase/02_security.sql         → RLS + policies
supabase/03_functions.sql        → triggers + fonctions (hash chain, dashboard)
supabase/04_public_tokens.sql    → tokens partage public
supabase/05_v11_extensions.sql   → V1.1 : multi-users, cabinet, multi-devises, PDP, SMS, inbox, observabilité
```

Vérifie qu'il n'y a aucune erreur. Si un fichier échoue, **ne passe pas au suivant** : corrige d'abord.

> ⚠️ Le fichier `05_v11_extensions.sql` tente d'installer un trigger sur `auth.users`. Sur Supabase managed, ce trigger nécessite des privilèges super-user et peut échouer silencieusement (le SQL gère le `EXCEPTION WHEN insufficient_privilege`). Dans ce cas, les invitations `company_users` doivent être résolues manuellement via SQL ou un cron à coder en V1.2.

### 2.3 Créer les buckets Storage

Dans **Storage** → "New bucket" :

| Nom | Public ? | Description |
|---|---|---|
| `invoices-pdf` | ❌ Privé | PDFs Factur-X + XML CII des factures, devis, avoirs |
| `purchases-attach` | ❌ Privé | Justificatifs achats (reçus, factures fournisseurs) |
| `company-assets` | ✅ Public | Logos, signatures (utilisés sur PDFs publics) |
| `accounting-exports` | ❌ Privé | Fichiers FEC + CSV exports comptables |

Pour chaque bucket privé, va dans **Policies** → ajouter une policy :
```sql
-- Lecture/écriture par le propriétaire (via Storage RLS Supabase native)
-- Le service_role bypass de toute façon ces règles côté API
```

### 2.4 Récupérer les clés

Dans **Settings → API** :
- `URL` → variable `VITE_SUPABASE_URL`
- `anon public` → variable `VITE_SUPABASE_ANON_KEY`
- `service_role secret` → variable `SUPABASE_SERVICE_ROLE_KEY` ⚠️ **Ne jamais commiter ni exposer côté client**

---

## 3. Stripe

### 3.1 Créer les produits/prix

Dans **Stripe Dashboard → Products** :

#### Produit 1 : "IO BILL Pro"
- Prix mensuel : **9,90 € HT** (soit 11,88 € TTC) → récurrent mensuel
  - Note l'ID `price_xxxx` → variable `STRIPE_PRICE_ID_PRO`
- Prix annuel : **89 € HT** (soit 106,80 € TTC) → récurrent annuel
  - Note l'ID `price_xxxx` → variable `STRIPE_PRICE_ID_ANNUAL`

#### Produit 2 : "IO BILL Cabinet" (V1.1 — actif)
- Prix mensuel : **19,90 € HT** → plan multi-clients pour experts-comptables
  - Note l'ID `price_xxxx` → variable `STRIPE_PRICE_ID_FIRM_MONTHLY`
- Prix annuel : **199 € HT** → réduction de 2 mois
  - Note l'ID `price_xxxx` → variable `STRIPE_PRICE_ID_FIRM_YEARLY`

> Le plan Cabinet est un abonnement **distinct** du plan Pro (un cabinet peut avoir les deux : Pro pour sa propre comptabilité + Cabinet pour superviser ses clients). Le webhook `stripe-webhook` distingue les deux via `subscription_data.metadata.type = "firm" | "company"`.

### 3.2 Configurer le webhook

Dans **Stripe Dashboard → Developers → Webhooks** :

1. Clic "Add endpoint"
2. URL : `https://<ton-domaine>.vercel.app/api/stripe-webhook`
3. **Événements à écouter** :
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid`
   - `invoice.payment_failed`
4. Note le **Signing secret** `whsec_xxx` → variable `STRIPE_WEBHOOK_SECRET`

### 3.3 Récupérer les clés API

Dans **Stripe Dashboard → Developers → API keys** :
- `Publishable key` (pk_) → variable `STRIPE_PUBLISHABLE_KEY` (PAS prefixe `VITE_` car cote serveur uniquement, on génère le checkout côté serveur)
- `Secret key` (sk_) → variable `STRIPE_SECRET_KEY` ⚠️ confidentiel

### 3.4 Activer Customer Portal

Dans **Stripe Dashboard → Settings → Billing → Customer Portal** :
- Active le portail
- Permet : annulation, changement de moyen de paiement, voir factures, mise à jour info de facturation
- Sauvegarde

---

## 4. Resend

### 4.1 Vérifier ton domaine

Dans **Resend → Domains** → "Add domain" :
1. Ajoute ton domaine (ex: `iobill.fr`)
2. Configure les DNS (SPF, DKIM, DMARC) chez ton registrar (Cloudflare)
3. Attends la vérification (~5 min)

### 4.2 Créer une API key

Dans **Resend → API Keys** → "Create API Key" :
- Nom : `iobill-prod`
- Permission : `Sending access`
- Note la clé `re_xxx` → variable `RESEND_API_KEY`

### 4.3 Adresse d'envoi

Configure une boîte d'envoi dédiée :
- `facturation@iobill.fr` (ou ton domaine) → variable `RESEND_FROM`

> ⚠️ Le domaine de cette adresse **doit être** celui vérifié à l'étape 4.1.

---

## 5. Yousign (optionnel, module signature)

### 5.1 Créer un compte API

1. Va sur **yousign.com → Developers**
2. Crée un environnement **Sandbox** (gratuit pour tester)
3. Note l'API key → variable `YOUSIGN_API_KEY`

### 5.2 Configurer le webhook

Dans **Settings → Webhooks** :
- URL : `https://<ton-domaine>.vercel.app/api/yousign-webhook`
- Événements : `signer.done`, `signer.declined`, `signature_request.expired`, `signature_request.activated`
- Note le secret → variable `YOUSIGN_WEBHOOK_SECRET` (optionnel mais recommandé)

### 5.3 Mode production

Quand tu veux passer en prod, créer un **environnement production** Yousign et changer la clé. Les signatures réelles coûtent ~1,50 €.

---

## 6. Bridge (optionnel, module bancaire PSD2)

### 6.1 Créer un compte développeur

1. Va sur **bridgeapi.io → Sign up**
2. Demande un **client ID + secret** (mode sandbox d'abord)
3. Note → variables `BRIDGE_CLIENT_ID` et `BRIDGE_CLIENT_SECRET`

### 6.2 Configurer le webhook (V1.1)

À configurer plus tard quand on activera la sync auto en webhook.

---

## 7. Mistral (optionnel, module OCR achats)

1. Va sur **console.mistral.ai → API Keys**
2. Crée une clé API
3. Variable `MISTRAL_API_KEY`

> Coût : très faible pour l'OCR (~0,001 € par facture).

---

## 8. Vercel

### 8.1 Lier le repo

1. Va sur **vercel.com → Add New Project**
2. Importe le repo Git (ou drag & drop le dossier)
3. Framework : **Vite** (auto-détecté)
4. Build command : `npm run build`
5. Output directory : `dist`

### 8.2 Configurer les variables d'environnement

Dans **Project Settings → Environment Variables**, ajoute toutes les variables de `.env.example` :

```
# Supabase
VITE_SUPABASE_URL
VITE_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY

# Stripe
STRIPE_SECRET_KEY
STRIPE_PUBLISHABLE_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_ID_PRO
STRIPE_PRICE_ID_ANNUAL
STRIPE_PRICE_ID_FIRM_MONTHLY    # plan Cabinet 19,90 €/mois (V1.1)
STRIPE_PRICE_ID_FIRM_YEARLY     # plan Cabinet 199 €/an

# Resend
RESEND_API_KEY
RESEND_FROM

# (Optionnels — V1)
YOUSIGN_API_KEY
YOUSIGN_WEBHOOK_SECRET
BRIDGE_CLIENT_ID
BRIDGE_CLIENT_SECRET
MISTRAL_API_KEY

# (Optionnels — V1.1) — Inbox email OCR via Cloudflare
INBOX_SECRET   # même valeur que celle configurée dans le Worker Cloudflare (32 chars)

# (Optionnels — V1.1) — Relances SMS via OVH SMS
OVH_APP_KEY
OVH_APP_SECRET
OVH_CONSUMER_KEY
OVH_SMS_SERVICE_NAME   # ex: sms-ab12345-1
OVH_SMS_SENDER          # 11 chars max alphanumeriques, ex: IOBILL

# (Optionnels — V1.1) — Observabilité
VITE_SENTRY_DSN
VITE_POSTHOG_KEY
VITE_POSTHOG_HOST=https://eu.i.posthog.com

# Cron
CRON_SECRET   # génère une chaîne aléatoire 32 chars

# App
PUBLIC_BASE_URL=https://iobill.fr
```

### 8.3 Cron déjà configuré

Le `vercel.json` à la racine déclare déjà :
```json
"crons": [{
  "path": "/api/cron-reminders",
  "schedule": "0 9 * * *"
}]
```
→ Vercel exécutera **chaque jour à 9h UTC** la route de relances impayés.

### 8.4 Premier déploiement

```bash
# Si tu utilises Git :
git push origin main
# → Vercel build et déploie automatiquement
```

ou via CLI :
```bash
npm i -g vercel
vercel --prod
```

### 8.5 Domaine custom

Dans **Settings → Domains** → ajoute `iobill.fr`. Configure les DNS chez Cloudflare :
- `A` record → IP fournie par Vercel
- ou `CNAME` → `cname.vercel-dns.com`

---

## 8.5 Setup des modules V1.1 (extensions optionnelles)

Ces modules ne sont pas obligatoires pour un MVP minimal. Active-les progressivement.

### 📧 Inbox email OCR (Cloudflare Email Routing)

**Pré-requis** : un domaine routable chez Cloudflare (ex: `inbox.iobill.fr`).

```bash
# 1. Active Cloudflare Email Routing sur ton domaine inbox.iobill.fr
# 2. Génère INBOX_SECRET (chaîne aléatoire 32+ chars)
openssl rand -hex 32
# → ajoute cette valeur en variable Vercel (INBOX_SECRET)
# → idem côté Cloudflare Worker

# 3. Installe et déploie le Worker
cd cloudflare
npm init -y
npm i postal-mime
wrangler login
wrangler secret put INBOX_SECRET   # même valeur que Vercel
wrangler secret put IOBILL_ENDPOINT # https://iobill.fr/api/inbox-purchase
wrangler deploy

# 4. Crée la "catch-all rule" Cloudflare → Worker iobill-inbox
```

Voir `cloudflare/README.md` pour le détail.

**Activation côté utilisateur** : Settings → onglet "📧 Inbox OCR" → toggle "Activer l'inbox". L'adresse `achats-XXXXXXXX@inbox.iobill.fr` est générée automatiquement à la création de la company.

### 📱 Relances SMS (OVH)

```bash
# 1. Crée un compte OVH SMS (https://www.ovhtelecom.fr/sms/)
# 2. Souscris un service SMS — note le service_name (ex: sms-ab12345-1)
# 3. Sur api.ovh.com, génère un consumer_key avec scope GET/POST/PUT sur /sms/*
# 4. Configure les 5 variables Vercel :
OVH_APP_KEY=...
OVH_APP_SECRET=...
OVH_CONSUMER_KEY=...
OVH_SMS_SERVICE_NAME=sms-ab12345-1
OVH_SMS_SENDER=IOBILL    # 11 chars max
```

**Activation côté utilisateur** : Settings → onglet "📱 SMS" → toggle. Les SMS sont envoyés automatiquement aux relances tardives (J+30, J+60) si le client a un numéro.

### 🏛️ PDP e-invoicing (Iopole, mode sandbox)

```bash
# 1. Crée un compte sur https://www.iopole.fr/
# 2. Demande un access PDP test/sandbox (gratuit pour valider l'integration)
# 3. Note ton account_id et api_key
```

**Activation côté utilisateur** : Settings → onglet "🏛️ PDP" → choisir provider Iopole → renseigner account_id + api_key.

> ⚠️ Tant que l'obligation 2026 n'est pas active, on recommande de tester en mode `ppf_test` (mock interne, pas de vrai envoi). Le passage en prod Iopole nécessite un contrat partenaire avec eux.

### 🔍 Observabilité (Sentry + PostHog)

```bash
# Sentry (errors)
# 1. Compte sur https://sentry.io/ — crée un projet React
# 2. Note le DSN
VITE_SENTRY_DSN=https://...@sentry.io/...

# PostHog (events produit)
# 1. Compte sur https://eu.posthog.com/ (région EU pour RGPD)
# 2. Note la project key
VITE_POSTHOG_KEY=phc_...
VITE_POSTHOG_HOST=https://eu.i.posthog.com

# 3. Installer côté package.json
npm install @sentry/react posthog-js
# (déjà en optionalDependencies, mais à installer pour activer)
```

Sans ces variables, IO BILL fonctionne normalement (mode dégradé silencieux).

**Stats internes** : indépendamment de PostHog, IO BILL agrège l'usage par module via la table `module_usage_daily` (visible sur `/admin/stats` pour les comptes admin).

### 👥 Multi-utilisateurs / Cabinet

Aucun setup serveur supplémentaire — il suffit que la migration `05_v11_extensions.sql` soit passée. Les utilisateurs invitent leur équipe via Settings → Équipe.

Pour tester le mode Cabinet :
```sql
-- Créer manuellement un firm pour un compte test :
INSERT INTO firms (legal_name, email) VALUES ('Cabinet Test', 'test@cabinet.fr') RETURNING id;
INSERT INTO firm_users (firm_id, user_id, role) VALUES ('<firm_id>', '<user_id>', 'partner');
INSERT INTO firm_clients (firm_id, company_id, access_level, accepted_at)
  VALUES ('<firm_id>', '<company_id>', 'editor', NOW());
```
Puis se connecter avec le user_id du `firm_users` → menu sidebar "Cabinet" apparaît.

### 💱 Multi-devises + TVA export

Aucun setup. Le sélecteur de devise + régime TVA apparaît directement dans QuoteEditor et InvoiceEditor.

Pour les conversions de change, IO BILL utilise [Frankfurter](https://www.frankfurter.app) (taux BCE, gratuit, pas de clé). L'API `/api/exchange-rate` met en cache journalier.

---

## 9. Tests end-to-end

1. Va sur ton domaine → page d'auth
2. **Sign up** avec un email valide → vérifie réception du mail Supabase de confirmation
3. Confirme → tu es renvoyé sur l'onboarding
4. **Onboarding** :
   - Réponds aux 3 questions (statut, régime, modules)
   - Renseigne ton SIRET → vérifie l'auto-récupération via API SIRENE (si activé)
5. → Tu arrives sur le **Dashboard**

✅ **Attendu** : KPIs vides, aucun graphique (pas encore de data).

### 9.2 Marquer ton compte admin

Pour avoir accès aux fonctions admin (vue toutes companies, tools de support) :

```sql
-- Dans Supabase SQL Editor :
UPDATE companies SET is_admin = TRUE WHERE email = 'ton-email@domaine.com';
```

### 9.3 Créer un client

1. **Clients → + Nouveau**
2. Type : Entreprise
3. Renseigne legal_name, SIRET, email, adresse
4. Clic "VIES" → vérifie la TVA intracom
5. Sauvegarde
6. → Tu arrives sur la fiche client (DSO, encours, historique)

✅ **Attendu** : badge "Prospect" affiché, encours = 0.

### 9.4 Créer un devis

1. **Devis → + Nouveau**
2. Sélectionne le client (autocomplete)
3. Ajoute 2 lignes : ex. "Prestation conseil" 1 j × 800 € HT, TVA 20%
4. Sauvegarde brouillon
5. **Envoyer pour signature** :
   - Si Yousign actif : email envoyé au client → ouvre l'inbox du client → vérifie le mail Yousign → signe
   - Sinon : email simple Resend avec PDF
6. → Le statut passe à "Envoyé"

✅ **Attendu** :
- Devis numéroté `DV-2026-0001`
- Email reçu côté client
- Lien de signature Yousign actif

### 9.5 Signer le devis (côté client)

1. Ouvre l'email
2. Clique sur le lien Yousign
3. Signe avec ta souris/doigt
4. → Webhook Yousign appelle `/api/yousign-webhook`
5. → Statut du devis devient "Signé"

✅ **Attendu** : badge vert "Signé" + IP signataire stockée en base.

### 9.6 Convertir en facture

1. Ouvre le devis signé
2. Clic "Convertir en facture →"
3. Confirme
4. → Une facture brouillon est créée avec les mêmes lignes
5. Vérifie le client/lignes
6. **Émettre la facture** → confirmation modal → "Émettre définitivement"

✅ **Attendu** :
- Facture numérotée `FA-2026-0001`
- Hash SHA-256 calculé (visible en bas)
- PDF Factur-X généré (en arrière-plan, ~5 sec)
- Lien Stripe Payment Link généré (si Stripe configuré)

### 9.7 Saisir un paiement manuel

1. Sur la facture émise → "Saisir un paiement"
2. Montant : 50 % du total → moyen : virement
3. Sauvegarde

✅ **Attendu** : statut → "Partielle", indicateur reste à payer.

### 9.8 Partager publiquement

1. Sur la facture → clic "🔗 Partager"
2. Lien copié dans le presse-papiers
3. Ouvre le lien dans une **fenêtre privée** (sans auth)
4. → Tu vois la facture publique avec :
   - Header IO BILL noir/or
   - Bouton "💳 Régler en ligne" (Stripe)
   - Bouton "📄 Télécharger Factur-X"

✅ **Attendu** : page lit-only, branding cohérent.

### 9.9 Espace client

1. Sur la fiche client → clic "🔗 Espace client"
2. Lien copié, ouvre en navigation privée
3. → Tu vois toutes les factures + devis du client + KPI à régler

✅ **Attendu** : table des factures avec liens "Payer" et "📄".

### 9.10 Créer un avoir

1. Ouvre la facture émise → clic "Créer un avoir"
2. Choix : "Avoir partiel" ou "Avoir total"
3. Motif : "Geste commercial"
4. Précision : "Réduction de 20% sur la prestation"
5. Modifie les lignes si avoir partiel
6. Émettre l'avoir

✅ **Attendu** :
- Avoir numéroté `AV-2026-0001`
- Hash chain calculé (chaîne séparée des factures)
- PDF avec mention "AVOIR" + total en orange négatif

### 9.11 Cron de relances (test manuel)

```bash
# Test manuel du cron (en bypass Vercel) :
curl -X GET "https://<ton-domaine>.vercel.app/api/cron-reminders" \
  -H "Authorization: Bearer <CRON_SECRET>"
```

✅ **Attendu** : `{ scanned: N, reminders_sent: M, ... }`

Pour tester un vrai retard :
```sql
-- Forcer une facture en retard de 5 jours :
UPDATE invoices SET due_date = (NOW() - INTERVAL '5 days')::date
WHERE id = '<une-facture-issued>';
```

### 9.12 Achat fournisseur (OCR)

1. **Achats → + Nouveau**
2. Upload une photo de facture fournisseur
3. → Mistral OCR extrait : fournisseur, montant HT, TVA, total TTC, date
4. Vérifie/corrige les champs extraits
5. Valide

✅ **Attendu** : achat créé, TVA déductible visible dans le module TVA.

### 9.13 Export FEC

1. **Comptabilité → Export**
2. Format : FEC
3. Période : 1er janvier → aujourd'hui
4. Génère
5. Télécharge le fichier `.txt`

✅ **Attendu** : fichier respectant la norme **arrêté du 29/07/2013** :
- Encodage UTF-8
- Séparateur tabulation
- 18 colonnes obligatoires
- Nom du fichier : `<SIREN>FEC<YYYYMMDD>.txt`

Ouvre dans Excel ou un éditeur texte → vérifie les colonnes.

### 9.14 V1.1 — Inbox email OCR

Pré-requis : Cloudflare Worker déployé + INBOX_SECRET configuré.

1. **Settings → Inbox OCR** → toggle "Activer l'inbox" → copie ton alias `achats-XXXXXXXX@inbox.iobill.fr`
2. Depuis ta boite perso, envoie un email vers cet alias avec une PJ PDF de facture fournisseur
3. Attends ~10 secondes
4. Va dans **Achats** → tu vois un nouvel achat en draft avec `source = "inbox_email"` et les données OCR pré-remplies
5. Settings → Inbox OCR → tu vois le message dans la liste des 10 derniers

✅ **Attendu** : email reçu, OCR exécuté, achat draft créé.

### 9.15 V1.1 — Mode caméra (PWA mobile)

1. Ouvre IO BILL **sur ton smartphone** (URL HTTPS uniquement, sinon getUserMedia bloqué)
2. **Achats → + Nouveau** → bouton "📸 Scanner avec l'appareil photo"
3. Autorise l'accès caméra
4. Cadre une facture papier dans le viseur doré → bouton capture
5. Vérifie / reprends la photo si besoin → "Utiliser cette photo"
6. La photo apparaît dans la zone d'upload → clique "Extraire avec OCR Mistral"

✅ **Attendu** : caméra arrière s'ouvre, photo capturée, flow OCR identique au upload classique.

### 9.16 V1.1 — Multi-utilisateurs (équipe)

1. **Sidebar → Équipe** (visible si > 1 membre ou is_admin)
2. Saisis email d'un collègue + rôle "comptable"
3. Clique "Inviter"
4. Vérifie que l'email est envoyé (Resend logs)
5. Le collègue crée son compte avec cet email
6. Le trigger SQL `resolve_pending_invitations` lie automatiquement la company

✅ **Attendu** : ligne `company_users` insérée en `accepted_at NULL`, puis remplie après signup.

### 9.17 V1.1 — Cabinet (plan multi-clients)

1. **Settings → Modules** ou directement `/firm/onboarding` → "Activer plan Cabinet"
2. Remplir info cabinet (legal_name, SIRET, adresse) → "Créer le cabinet"
3. → Tu arrives sur `/firm` (Dashboard cabinet vide)
4. **+ Inviter un client** → email d'un compte IO BILL existant + niveau d'accès
5. Le client reçoit l'email, clique le lien `/firm-invite/<id>`
6. Voit la demande, clique "Accepter"
7. Le partner du cabinet voit maintenant le dossier client dans `/firm`
8. Clique "Ouvrir →" sur un client → vue `/firm/clients/:id` avec KPI synthèse

✅ **Attendu** : RLS Supabase filtre correctement (le partner ne voit QUE les clients qui ont accepté).

### 9.18 V1.1 — Multi-devises + TVA export

1. Crée un client avec country = "DE" (Allemagne) + numéro TVA intracom
2. Crée un nouveau devis pour ce client
3. → Le sélecteur "Régime TVA" doit auto-passer à **Autoliquidation intracom B2B**
4. La mention légale "Article 196 directive 2006/112/CE" apparaît
5. Génère le PDF → la mention apparaît en pied de doc

Test 2 : client US (hors UE) → doit auto-passer à **Export hors UE** + mention article 262 ter du CGI.

✅ **Attendu** : auto-suggestion correcte, mentions présentes dans le PDF.

### 9.19 V1.1 — Relances SMS

Pré-requis : `OVH_*` configurés + un compte OVH SMS actif.

1. **Settings → SMS** → activer
2. Crée un client avec phone "06 XX XX XX XX"
3. Crée une facture pour ce client, antidate `due_date` à J-30
4. Lance le cron : `curl -X GET "https://<domaine>/api/cron-reminders" -H "Authorization: Bearer <CRON_SECRET>"`
5. Le client reçoit un SMS sur son téléphone
6. Settings → SMS → compteur incrémenté

✅ **Attendu** : SMS reçu, log dans `sms_log`, compteur `sms_count_month` incrémenté.

### 9.20 V1.1 — PDP e-invoicing (mode test PPF)

1. **Settings → PDP** → choisir provider `PPF Test (sandbox DGFiP, gratuit)` → activer
2. Émets une facture (status = issued) → vérifie que `facturx_xml_url` est généré
3. Appel manuel : `POST /api/pdp-submit` avec `{ "invoice_id": "..." }`
4. Réponse OK avec `transmission_id` + `reference: PPF-TEST-...`
5. Vérifie la ligne dans la table `pdp_transmissions` (status `submitted`)

Test webhook : POST sur `/api/pdp-webhook` avec `{ "transmission_id": "...", "status": "received" }` → status passe à `accepted`.

✅ **Attendu** : transmission tracée, statuts mis à jour via webhook.

---

## 10. Mise en production

### 10.1 Checklist pré-prod

- [ ] Tous les SQL exécutés sans erreur
- [ ] 4 buckets Storage créés
- [ ] Stripe en mode **Live** (pas test) → bascule des clés
- [ ] Resend domaine **vérifié**
- [ ] Yousign en mode **Production**
- [ ] Vercel : variables `NODE_ENV=production`
- [ ] CRON_SECRET généré et stocké
- [ ] Sentry/monitoring (optionnel mais recommandé)
- [ ] Conditions générales d'utilisation rédigées
- [ ] Politique de confidentialité rédigée
- [ ] Page de tarifs publiée

### 10.2 Sauvegardes

- **Supabase Pro (25 $/mo)** : backups quotidiens automatiques + Point-in-time recovery
- Active la **réplication EU** pour la conformité RGPD

### 10.3 Mentions légales

Ajoute dans le footer du site :
```
IO BILL est édité par OWL'S INDUSTRY
SIRET : <ton SIRET>
Hébergement : Vercel Inc., 340 S Lemon Ave #4133, Walnut, CA 91789
Données : Supabase EU (Frankfurt, Allemagne)
DPO : <ton email DPO>
```

### 10.4 Conformité 2026/2027 (e-invoicing FR)

- À partir de **septembre 2026** : obligation de **réception** de factures électroniques pour toutes les entreprises FR
- À partir de **septembre 2027** : obligation **d'émission** + e-reporting (B2C, international)
- IO BILL devra **brancher un PDP** (Plateforme de Dématérialisation Partenaire) :
  - Candidats : **Iopole**, **Generix**, **Cegid**, **Sage**, **Pennylane**...
  - Coût estimé : 0,10 à 0,50 € par facture
  - Implémentation : 1 nouvelle route `/api/pdp-submit` qui envoie l'XML CII au PDP

> Cette intégration n'est pas encore faite — c'est le **prochain gros chantier** après le lancement.

---

## 🎯 Premiers utilisateurs (early adopters)

Une fois en prod, recommandations pour acquérir tes 10 premiers clients :

1. **Toi-même** comme premier utilisateur (mange ton dog food)
2. **Indie Hackers FR** + **Reddit r/auto-entrepreneur** + **Twitter freelance FR**
3. Lancement **Product Hunt** quand tu as 50 utilisateurs satisfaits
4. **Programme de parrainage** : 1 mois offert pour le parrain + le filleul
5. **Comparatif vs Tiime / Pennylane / Indy** sur ta landing : prix/fonctionnalités

---

## 🛟 Support

Sentry pour tracker les erreurs front + serverless :
```bash
npm i @sentry/react @sentry/tracing
```

PostHog pour les events produit :
```bash
npm i posthog-js
```

(Pas inclus dans v3 — à ajouter en v1.1)

---

## 🆕 V1.2 polish — fonctionnalités UX

Cette version ajoute :

- **Switch multi-company** : si un user appartient à plusieurs sociétés (ex. partner d'un cabinet + dirigeant de sa propre boîte), un dropdown apparaît dans la sidebar pour basculer.
- **Stripe Cabinet** : abonnement séparé pour les experts-comptables (19,90 €/mois). Variables `STRIPE_PRICE_ID_FIRM_MONTHLY` + `STRIPE_PRICE_ID_FIRM_YEARLY` à configurer.
- **Audit log UI** (`/audit`) : toutes les modifications de documents sont consultables avec filtres et expand JSON old/new.
- **Notifications in-app** : badge cloche dans la sidebar, polling toutes les 60s sur invitations cabinet, paiements 24h, factures overdue, SMS récents.
- **Onboarding tour** : visite guidée 6 étapes au premier login (skip stocké en localStorage).
- **Tests E2E Playwright** : 4 specs couvrant auth/onboarding, client+devis, facture+Factur-X, routes publiques. `npm run test:e2e`.
- **Mode dégradé offline** : queue IndexedDB qui rejoue les mutations quand la connexion revient. Bandeau visible en haut de page.
- **i18n EN** : interface bascule FR ↔ EN via Settings → Sécurité. Sans dépendance externe (~5 KB de dico).

### Tests E2E

```bash
npm install --save-dev @playwright/test
npx playwright install chromium
npm run test:e2e
```

Voir `tests/README.md` pour la marche à suivre, notamment la désactivation de la confirmation email Supabase pour les tests automatisés.

---

## 🆕 V1.3 — Webhooks, push, IA, API publique, exports compta

Cette version ajoute :

- **Webhook Bridge** (`/api/bridge-webhook`) : sync bancaire automatique. Configurer dans Bridge Dashboard → Webhooks. Variable : `BRIDGE_WEBHOOK_SECRET`.
- **Notifications Push PWA** : abonnement Web Push, notif sur paiement Stripe reçu. Variables : `VAPID_PUBLIC_KEY`, `VITE_VAPID_PUBLIC_KEY` (même valeur), `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT=mailto:contact@iobill.fr`. Générer avec `npx web-push generate-vapid-keys` ou OpenSSL.
- **Auto-lettrage IA** : moteur de scoring automatique (montant + date + libellé) qui propose des matches transactions ↔ factures, validés en un clic dans la page Banque.
- **Devis multi-versions** : bouton "Créer v2" sur un devis, historique de toutes les versions visible. La version source est marquée comme remplacée.
- **API publique IO BILL** (`/api/v1/clients`, `/api/v1/invoices`) : authentification par clé Bearer (`iobill_live_xxxx_yyyy`). OpenAPI spec sur `/api/v1/openapi.json`. Ratelimit 60 req/min par défaut.
- **Exports Sage / Cegid / Pennylane** : 3 nouveaux formats CSV dédiés en plus du FEC universel.

### Nouvelles tables (06_v13_extensions.sql)

```sql
push_subscriptions          -- abonnements Web Push par user
bank_match_suggestions      -- suggestions de lettrage IA
api_keys                    -- clés API par société (hash pbkdf2)
api_request_log             -- log des appels API pour audit
bridge_webhook_events       -- trace des webhooks Bridge reçus
```

Et colonnes ajoutées : `quotes.version`, `quotes.root_quote_id`, `quotes.superseded_by_id`, `bank_transactions.matched_invoice_id/matched_purchase_id`, `bank_connections.bridge_user_uuid`.

### Service Worker custom

À partir de V1.3, on utilise `vite-plugin-pwa` en mode `injectManifest` pour avoir un sw.js custom (push handlers). Penser à installer les workbox deps :

```bash
npm install workbox-precaching workbox-routing workbox-strategies workbox-expiration
```

### Variables Vercel V1.3

```
# Bridge webhook
BRIDGE_WEBHOOK_SECRET=...           # 32+ chars

# Push notifications
VAPID_PUBLIC_KEY=BG1XXX...          # public key (URL-safe base64, 87 chars)
VITE_VAPID_PUBLIC_KEY=BG1XXX...     # même valeur, prefix VITE_ pour client
VAPID_PRIVATE_KEY=AAA...            # private key (URL-safe base64, 43 chars)
VAPID_SUBJECT=mailto:contact@iobill.fr
```

---

**Bonne mise en prod 🦉**
*OWL'S INDUSTRY · IO BILL v1.3*
