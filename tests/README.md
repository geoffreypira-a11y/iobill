# 🧪 Tests E2E — Playwright

## Installation

```bash
npm install --save-dev @playwright/test
npx playwright install chromium
```

## Lancement

```bash
# Tous les tests (avec serveur dev auto)
npm run test:e2e

# UI mode (interactif, recommandé pour debug)
npx playwright test --ui

# Un seul fichier
npx playwright test tests/04-public.spec.js

# Avec un baseURL custom
E2E_BASE_URL=https://staging.iobill.fr npx playwright test
```

## Structure

| Fichier | Couvre |
|---|---|
| `01-auth.spec.js` | Signup, validation mot de passe, onboarding |
| `02-client-quote.spec.js` | Création client + devis (nécessite session active) |
| `03-invoice.spec.js` | Émission facture + Factur-X + partage public |
| `04-public.spec.js` | Smoke tests routes publiques |

## Variables

- `E2E_BASE_URL` : URL cible (défaut `http://localhost:5173`)
- `E2E_AUTHENTICATED=1` : active les tests qui requièrent une session

## Préparation Supabase pour les tests

Pour que `01-auth.spec.js` passe sans intervention manuelle :

1. **Désactive la confirmation email** dans Supabase → Auth → Email → "Confirm email" OFF (uniquement pour tests)
2. **Ajoute un domaine de test autorisé** : `*.example.com`

Pour les tests authentifiés (`02`, `03`), le plus simple est de :

1. Créer manuellement un user de test
2. Lancer Playwright avec `--save-storage-state=tests/.auth/user.json`
3. Décommenter `test.use({ storageState: ... })` dans les specs

## CI

Sur GitHub Actions, les tests s'exécutent en mode `chromium` headless, avec retries=2 et reporter=github.
