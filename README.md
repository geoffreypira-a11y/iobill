# IO BILL

> Le bijou de l'entrepreneur 2.0 — facturation, devis, TVA, URSSAF et compta.
> Par **OWL'S INDUSTRY**.

PWA installable. Conforme à la facturation électronique 2026/2027 :
**Factur-X (PDF/A-3 + XML CII embarqué)**, hash chain anti-fraude DGFiP, FEC export.

---

## Stack

- **Front** : React 18 + Vite 5 + react-router-dom 6 + PWA Workbox
- **Back** : Vercel Functions (`/api/*.js`)
- **DB** : Supabase Postgres EU (région Francfort recommandée, RGPD)
- **Paiements** : Stripe (abonnement Pro + Payment Links sur factures)
- **OCR** : Mistral OCR (souverain France)
- **Bancaire** : Bridge by BPCE — DSP2/PSD2 (agrément ACPR n°16648)
- **Signature** : Yousign (eIDAS qualifiée)
- **Email** : Resend
- **PDF** : pdf-lib (Factur-X PDF/A-3 + XML CII)

---

## Démarrage rapide

### 1. Supabase

1. Créer un projet sur [app.supabase.com](https://app.supabase.com), région **Francfort**.
2. **SQL Editor** → exécuter dans cet ordre :
   - `supabase/01_schema.sql` (tables, indexes)
   - `supabase/02_security.sql` (RLS)
   - `supabase/03_functions.sql` (numérotation, hash chain, audit)
3. **Storage** → créer 4 buckets privés :
   - `invoices-pdf`
   - `purchases-attach`
   - `company-assets`
   - `accounting-exports`
4. **Settings → API** → noter l'URL, la clé `anon`, et la clé `service_role`.

### 2. Local

```bash
git clone <repo>
cd iobill
npm install
cp .env.example .env.local
# Remplir au minimum VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY
npm run dev
```

→ [http://localhost:5173](http://localhost:5173)

### 3. Premier compte

1. Inscription email + password
2. Confirmer via email Supabase
3. Onboarding 3 questions → modules activés automatiquement
4. (Optionnel) Te marquer admin :

```sql
UPDATE public.companies SET is_admin = TRUE WHERE email = 'ton-email@example.com';
```

### 4. Déploiement Vercel

```bash
vercel --prod
```

Configurer les variables d'env dans le dashboard Vercel (cf `.env.example`).

---

## Modules livrés (V1 MVP)

✅ **Auth + onboarding intelligent** (3 questions → modules activés)
✅ **Cockpit** (CA, encours, DSO, échéances fiscales, seuils micro)
✅ **CRM Clients** (liste capsules/liste, fiche 360, encours, score, VIES)
✅ **Devis** (création, lignes dynamiques, signature interne ou Yousign, conversion en facture)
✅ **Factures Factur-X** (PDF/A-3 + XML CII, hash chain DGFiP, immuables après émission)
✅ **Avoirs** (DB prête, UI à venir V1.1)
✅ **Achats fournisseurs** (upload PDF/photo, OCR Mistral)
✅ **TVA** (déclarations CA3 mensuel/trimestriel, CA12 simplifiée)
✅ **URSSAF** (cotisations AE basées CA encaissé, mensuel/trimestriel)
✅ **Lettrage bancaire PSD2** (Bridge, matching automatique)
✅ **Export comptable** (FEC standard 18 colonnes, CSV)
✅ **Paramètres** (profil, modules à la carte, branding, abonnement Stripe, sécurité, RGPD)
✅ **PWA installable** (offline-ready, icônes maskable)

---

## API Routes (`/api/*.js`)

| Route | Rôle |
|-------|------|
| `vies-check` | Vérification TVA intracom UE (Commission européenne) |
| `ocr-purchase` | Mistral OCR + structuration JSON pour factures fournisseurs |
| `generate-facturx` | PDF/A-3 + XML CII embarqué (Factur-X profil BASIC) |
| `send-document` | Envoi email via Resend (devis/facture/relance) |
| `stripe-checkout` | Abonnement Pro (9,90€/mois ou 89€/an) |
| `stripe-portal` | Customer Portal (gérer abonnement, factures, CB) |
| `stripe-payment-link` | Lien de paiement client sur facture |
| `stripe-webhook` | Sync subscription + paiements clients reçus |
| `bridge-connect` | Initie connexion bancaire PSD2 |
| `bridge-sync` | Rapatrie transactions + auto-matching factures |
| `accounting-export` | FEC, CSV, Pennylane/Tiime API |
| `yousign-create` | Procédure signature eIDAS qualifiée |
| `delete-account` | Purge RGPD totale (Stripe, DB, auth) |

---

## Conformité réglementaire

### Facturation électronique 2026/2027
- Factures **Factur-X** (PDF/A-3 + XML CII embarqué profil BASIC)
- Compatible avec les PDP partenaires pour transmission en réseau

### Anti-fraude DGFiP (art. 286-I-3 CGI)
- **Hash chain SHA-256** chaîné automatiquement à chaque émission
- Trigger Postgres : impossible de modifier une facture émise
- Avoir obligatoire pour rectification

### Audit
- Append-only `audit_log` sur toutes opérations sensibles
- Triggers `SECURITY DEFINER` bypass RLS

### RGPD
- DB en région UE (Francfort)
- Suppression compte avec purge totale (CASCADE)

---

## Variables d'environnement

Voir `.env.example`. Les essentielles pour démarrer :

```
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO_MONTHLY=price_...
MISTRAL_API_KEY=...
BRIDGE_CLIENT_ID=...
BRIDGE_CLIENT_SECRET=...
YOUSIGN_API_KEY=...
RESEND_API_KEY=re_...
RESEND_FROM=facturation@iobill.fr
```

---

## Roadmap V1.1+

- 📥 OCR avancé inbox dédiée Cloudflare Email Routing
- 📷 Mode terrain photo (PWA caméra)
- 👥 Multi-utilisateurs + rôles
- 💼 Portail comptable multi-clients (plan Cabinet 19,90€)
- 💱 Multi-devises + auto-liquidation TVA export
- 🆓 Plan Découverte gratuit
- 📑 Avoirs UI complète

---

## Marque

**OWL'S INDUSTRY** · le bijou de l'entrepreneur 2.0
