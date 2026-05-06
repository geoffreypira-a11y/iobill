# 📧 Cloudflare Email Worker — Inbox OCR

Permet à chaque utilisateur d'avoir une **adresse email dédiée** (`achats-XXX@inbox.iobill.fr`) sur laquelle forwarder les factures fournisseurs reçues par email. Cloudflare reçoit le mail, extrait les pièces jointes (PDF/images), et les envoie à `/api/inbox-purchase` qui déclenche l'OCR Mistral et crée des achats en brouillon.

## Architecture

```
fournisseur@xyz.com
    ↓ envoie facture par mail
achats-3f7a91@inbox.iobill.fr
    ↓ Cloudflare Email Routing
Cloudflare Email Worker (email-worker.js)
    ↓ HTTP POST + X-IO-INBOX-SECRET
https://iobill.fr/api/inbox-purchase
    ↓ OCR Mistral + insert
Supabase: purchases (status=draft, ocr_status=extracted)
```

## Déploiement

### 1. Créer le sous-domaine `inbox.iobill.fr`

Chez ton registrar DNS (Cloudflare DNS recommandé) :
```
inbox.iobill.fr  TYPE A  -> peu importe (Cloudflare s'en occupe)
```

Active **Cloudflare Email Routing** pour `inbox.iobill.fr` :
- Cloudflare Dashboard → Email → Email Routing
- "Get Started" → ajoute le domaine
- Cloudflare ajoute automatiquement les DNS MX records

### 2. Installer wrangler

```bash
npm i -g wrangler
cd cloudflare
wrangler login
```

### 3. Installer la dépendance MIME parser

```bash
cd cloudflare
npm init -y
npm i postal-mime
```

### 4. Configurer les secrets

```bash
wrangler secret put INBOX_SECRET
# entre une valeur aleatoire forte (32+ chars) — la MEME que dans Vercel

wrangler secret put IOBILL_ENDPOINT
# entre : https://iobill.fr/api/inbox-purchase
```

### 5. Déployer le Worker

```bash
wrangler deploy
```

### 6. Créer la "catch-all" rule

Dans Cloudflare Email Routing → "Routing rules" :
- "Add rule" → **Catch-all address**
- Action : **Send to a Worker**
- Worker : `iobill-inbox`
- Save

### 7. Tester

Envoie un email avec une PJ PDF à `achats-test@inbox.iobill.fr`. Tu devrais voir :
- Un nouveau message dans `inbox_messages` (Supabase)
- Si l'alias correspond à une company avec `inbox_enabled=true`, un nouveau `purchases` en draft avec OCR extrait

## Côté IO BILL : activer l'inbox pour une company

Dans Settings → Modules ou via SQL :

```sql
UPDATE companies SET inbox_enabled = TRUE WHERE id = '<company_id>';
```

L'alias est généré automatiquement à la création de la company (trigger `generate_inbox_alias`).

## Sécurité

- **Secret partagé** : le Worker n'envoie l'email à Vercel QUE s'il a `INBOX_SECRET`
- **Whitelist alias** : Vercel rejette tout email vers un alias inconnu (404)
- **Inbox toggle** : la company doit avoir `inbox_enabled = TRUE`
- **Rate-limit** : Cloudflare Workers est limité à 100k requêtes/jour gratuit. Si plus, abonnement Workers Paid ($5/mo)
- **Spam** : Cloudflare Email Routing applique déjà SPF/DKIM. Pour un anti-spam plus poussé, utiliser un MTA dédié (Mailgun route, SendGrid Inbound)

## Coûts

- Cloudflare Email Routing : **gratuit**
- Cloudflare Worker : **gratuit** jusqu'à 100k req/jour
- Mistral OCR : ~0,001 € par facture
- Storage Supabase : ~0,01 € par GB / mois (1 facture PDF = 200 KB → 5000 factures par GB)

## Limitations

- **Taille max email** : 10 MB (Cloudflare Email Workers). Pour les PJ plus lourdes, switcher vers Mailgun ou SendGrid Inbound (limite 25 MB).
- **Volume max attachements** : on traite tous les attachements PDF/JPEG/PNG/WEBP. Les autres sont ignorés.
- **Anti-loop** : si l'OCR échoue, le purchase est créé en `ocr_status=failed` et l'utilisateur peut le compléter manuellement.
