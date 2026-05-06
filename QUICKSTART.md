# 🦉 IO BILL — Démarrage rapide vers `app.iobill.online`

Guide pratique pour passer du ZIP à une URL accessible publiquement, en mode bêta privée.
Pour la doc exhaustive (PDP, SMS OVH, observabilité, push VAPID, etc.) → voir `DEPLOYMENT.md`.

---

## ⚡ Vue d'ensemble (durée totale : 2-3h)

1. GitHub : créer un repo et pousser le code (10 min)
2. Supabase : créer le projet et exécuter les SQL (30 min)
3. Vercel : importer le repo, configurer les env vars, déployer (30 min)
4. Domaine : pointer `app.iobill.online` vers Vercel (15 min + propagation)
5. Resend : configurer l'envoi d'emails (15 min)
6. Stripe (mode Test pour la bêta) : créer les produits (20 min)
7. Test fonctionnel : créer un compte, émettre une facture (15 min)

---

## 1. GitHub

```bash
# Décompresse le ZIP, place-toi dans le dossier
cd iobill

# Initialise git
git init
git add .
git commit -m "Initial commit IO BILL v8.1"

# Crée un repo PRIVÉ sur github.com (idéalement dans une org "owls-industry")
# puis :
git remote add origin git@github.com:TON_PSEUDO/iobill.git
git branch -M main
git push -u origin main
```

✅ **Vérification** : ton code est visible sur GitHub, repo privé.

---

## 2. Supabase

### 2.1 Créer le projet

- Va sur supabase.com → connecte-toi
- (Recommandé) Crée une nouvelle organisation **OWL'S INDUSTRY**
- **New Project** :
  - Name : `iobill-beta`
  - Database password : génère un mot de passe fort, **sauvegarde-le dans 1Password**
  - Region : **West EU (Ireland)** ou **Central EU (Frankfurt)**
  - Plan : Free

### 2.2 Récupérer les credentials

Dans **Settings → API**, note précieusement :
- `Project URL` → ce sera `VITE_SUPABASE_URL`
- `anon public` → ce sera `VITE_SUPABASE_ANON_KEY`
- `service_role` → ce sera `SUPABASE_SERVICE_ROLE_KEY` ⚠️ **JAMAIS dans le frontend**

### 2.3 Exécuter les fichiers SQL DANS L'ORDRE

Dans **SQL Editor** de Supabase, copie-colle et exécute **un par un, dans cet ordre exact** :

1. `supabase/01_schema.sql`
2. `supabase/02_security.sql`
3. `supabase/03_functions.sql`
4. `supabase/04_public_tokens.sql`
5. `supabase/05_v11_extensions.sql`
6. `supabase/06_v13_extensions.sql`

⚠️ Si **un fichier échoue** (erreur en rouge), STOP. Lis l'erreur, ne passe pas au suivant.
La cause est presque toujours : extension manquante (active `pgcrypto` et `uuid-ossp` dans Database → Extensions), ou problème de droits (rare sur Supabase managed).

### 2.4 Créer les buckets Storage

Dans **Storage**, crée ces buckets, tous **PRIVÉS** :

- `invoices-pdf`
- `quotes-pdf`
- `credit-notes-pdf`
- `purchase-attachments`
- `accounting-exports`
- `company-logos`
- `signatures`

### 2.5 Configurer Auth

**Authentication → URL Configuration** :
- Site URL : `https://app.iobill.online`
- Redirect URLs : ajoute `https://app.iobill.online/**` et `http://localhost:5173/**`

**Authentication → Providers → Email** : activer "Confirm email" (sauf si tu veux tester sans confirmation, à toi de voir)

✅ **Vérification** : tu vois 50+ tables dans **Table Editor** (clients, invoices, quotes, purchases, etc.)

---

## 3. Vercel

### 3.1 Importer le projet

- Va sur vercel.com → New Project → Import Git Repository
- Sélectionne ton repo `iobill`
- Framework Preset : **Vite** (auto-détecté)
- Build Command : `npm run build` (auto)
- Output Directory : `dist` (auto)

### 3.2 Variables d'environnement minimales

Dans **Environment Variables**, ajoute pour les 3 environnements (Production, Preview, Development) :

```
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGc...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
PUBLIC_BASE_URL=https://app.iobill.online
CRON_SECRET=<générer avec : openssl rand -hex 32>
```

Tu rajouteras les autres (Stripe, Resend, etc.) au fur et à mesure.

### 3.3 Premier déploiement

Clique **Deploy**. Le build prend 2-3 min. Si erreur, regarde les logs Vercel — c'est presque toujours une variable d'env manquante ou mal copiée (espace en trop).

✅ **Vérification** : Vercel te donne une URL `iobill-xxx.vercel.app`. Tu cliques, tu vois la page de connexion IO BILL.

---

## 4. Domaine `app.iobill.online`

### 4.1 Côté Vercel

Dans le projet Vercel → **Settings → Domains → Add** → tape `app.iobill.online`.
Vercel te donne un enregistrement à ajouter chez OVH.

### 4.2 Côté OVH

Dans **Espace client OVH → Domaines → iobill.online → Zone DNS** :

Ajoute un enregistrement :
- Type : **CNAME**
- Sous-domaine : **app**
- Cible : `cname.vercel-dns.com.` (le point final est important)

Sauvegarde. Propagation : 5-30 min.

### 4.3 Vérifier

Vercel détecte automatiquement quand le DNS est OK et émet un certificat SSL Let's Encrypt.
✅ **Vérification** : `https://app.iobill.online` charge ton app en HTTPS.

---

## 5. Resend (emails)

### 5.1 Ajouter le domaine

- resend.com → **Domains → Add Domain** → `iobill.online`
- Resend te donne 3 enregistrements DNS (SPF, DKIM, DMARC) à ajouter chez OVH

### 5.2 Côté OVH

Ajoute les 3 enregistrements TXT/MX/CNAME dans la **Zone DNS**. Sauvegarde.
Resend valide automatiquement (5-30 min).

### 5.3 Créer une API key

**API Keys → Create API Key** :
- Name : "IO BILL Production"
- Permissions : Sending access seulement
- Copie la clé (elle ne sera plus affichée)

### 5.4 Variables Vercel

Ajoute dans Vercel :
```
RESEND_API_KEY=re_xxx
RESEND_FROM=facturation@iobill.online
```

Redéploie (Vercel le fait auto à chaque push, ou clique "Redeploy" pour forcer).

✅ **Vérification** : depuis ton app, envoie un devis test. Vérifie qu'il arrive bien dans ta boîte mail.

---

## 6. Stripe (mode Test pour la bêta)

### 6.1 Compte Stripe

Sur dashboard.stripe.com → bascule en **mode Test** (toggle en haut).

### 6.2 Créer les produits

**Products → Add Product** (3 produits à créer) :

**IO BILL Solo**
- Prix : 9,90 € HT / mois récurrent
- Note l'ID `price_xxx` → variable `STRIPE_PRICE_ID_PRO`

**IO BILL Pro**
- Prix : 19,90 € HT / mois récurrent
- Note l'ID `price_xxx` → variable `STRIPE_PRICE_ID_ANNUAL` (ou crée la version annuelle aussi)

**IO BILL Cabinet**
- Prix : 49 € HT / mois récurrent
- Note l'ID `price_xxx` → variable `STRIPE_PRICE_ID_FIRM_MONTHLY`

### 6.3 Webhook

**Developers → Webhooks → Add endpoint** :
- URL : `https://app.iobill.online/api/stripe-webhook`
- Events : `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `payment_intent.succeeded`
- Note le **Signing secret** `whsec_xxx`

### 6.4 Variables Vercel

```
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_PUBLISHABLE_KEY=pk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_PRICE_ID_PRO=price_xxx
STRIPE_PRICE_ID_ANNUAL=price_xxx
STRIPE_PRICE_ID_FIRM_MONTHLY=price_xxx
```

Redéploie.

✅ **Vérification** : abonnement test avec carte `4242 4242 4242 4242`, vérifier que le statut passe à `active`.

---

## 7. Tests fonctionnels critiques (15 min)

Avant d'inviter les bêta-testeurs, valide toi-même ces 6 flux :

1. **Signup** → confirmation email → onboarding → dashboard
2. **Création client** : clic + ajouter, taper un SIRET réel (ex: 552032534 = Carrefour) → l'adresse doit s'auto-remplir
3. **Création devis** : choisir client, ajouter une ligne, enregistrer → un n° devis est attribué
4. **Génération PDF** : clic "Aperçu" → le PDF Factur-X s'ouvre avec le branding
5. **Création facture** + émission → le statut passe à "issued", le PDF est figé
6. **Suppression compte RGPD** : Settings → Sécurité → Supprimer → vérifie que tout est purgé

Si un fail, debug avant d'inviter les testeurs.

---

## 8. Mode bêta : préparer pour les testeurs

### 8.1 Ajouter une bannière "Bêta"

Crée un fichier `src/components/BetaBanner.jsx` :

```jsx
export function BetaBanner() {
  return (
    <div style={{
      background: "rgba(212, 168, 67, 0.15)",
      borderBottom: "1px solid var(--gold)",
      padding: "8px 16px",
      textAlign: "center",
      fontSize: 12,
      color: "var(--gold)",
      fontWeight: 600,
      letterSpacing: 0.5
    }}>
      🦉 IO BILL est en bêta privée — vos retours nous aident à construire le meilleur outil de facturation française.
      Bug ou suggestion ? <a href="mailto:beta@iobill.online" style={{ color: "var(--gold)", textDecoration: "underline" }}>beta@iobill.online</a>
    </div>
  );
}
```

Importe-le dans `App.jsx`, juste avant `<Sidebar>` dans `AuthedLayout`.

### 8.2 Email beta@iobill.online

Sur OVH → MX Plan gratuit (inclus avec ton domaine) ou redirection email :
- Crée un alias `beta@iobill.online` qui redirige vers ton email perso

### 8.3 Inviter les testeurs

Email type à envoyer à chaque testeur :

> Hello [Prénom],
>
> Tu as accès à la bêta privée d'IO BILL : https://app.iobill.online
>
> Tu peux créer un compte directement, c'est ouvert. Pour la phase de test, tu n'auras rien à payer (3 mois gratuits, puis tarif réduit pour les bêta-testeurs).
>
> Le but : tester tous les flows (devis, facture, PDF, etc.) et me signaler les bugs / frictions à beta@iobill.online.
>
> Merci pour ton aide !
> [Toi]

---

## ✅ C'est fait

Tu as :
- Une app accessible sur `https://app.iobill.online`
- Le moteur backend opérationnel sur Supabase EU
- Les emails qui partent depuis Resend
- Stripe configuré en Test pour ne rien encaisser pendant la bêta
- Une bannière qui indique aux testeurs qu'on est en bêta

Tu peux maintenant inviter tes 10-20 bêta-testeurs.

---

## 🚨 Avant le lancement public (dans 2-3 mois)

Liste à cocher avant d'ouvrir au grand public :
- [ ] Stripe en mode **Live** (avec validation d'identité Stripe)
- [ ] Cloudflare devant Vercel (gratuit, protection DDoS)
- [ ] Pages légales rédigées : `/legal/cgu`, `/legal/cgv`, `/legal/confidentialite`, `/legal/mentions-legales`
- [ ] Politique cookies (même si Plausible ne pose pas de cookies, le mentionner)
- [ ] DPA téléchargeable (template gratuit suffit pour démarrer)
- [ ] Email professionnel `contact@iobill.online`
- [ ] Site vitrine iobill.online finalisé avec liens vers app.iobill.online
- [ ] Plausible Analytics installé (RGPD-friendly, sans cookies)
- [ ] Sentry installé (erreur tracking en prod) — `VITE_SENTRY_DSN`
- [ ] Tests Playwright qui passent sur le flow signup → facture
- [ ] Sauvegardes Supabase activées (Daily backups inclus dans plan Free)

---

**Questions ? Bug pendant le setup ? Reviens vers moi avec l'erreur exacte et on debug ensemble. Bonne mise en prod 🦉**

*OWL'S INDUSTRY · IO BILL*
