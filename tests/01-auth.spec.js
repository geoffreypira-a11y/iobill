// IO BILL - Test E2E : signup + onboarding
import { test, expect } from "@playwright/test";

const TEST_EMAIL_PREFIX = "iobill-e2e-";
const TEST_PASSWORD = "TestPassword!123";

test.describe("Auth + Onboarding", () => {
  test("signup → confirmation → onboarding → dashboard", async ({ page }) => {
    const email = `${TEST_EMAIL_PREFIX}${Date.now()}@example.com`;

    // 1) Page d'accueil → page d'auth
    await page.goto("/");
    await expect(page).toHaveTitle(/IO BILL/i);

    // 2) Sign up
    const signupTab = page.getByRole("tab", { name: /créer un compte|inscription|sign up/i }).first();
    if (await signupTab.isVisible().catch(() => false)) {
      await signupTab.click();
    }

    await page.getByLabel(/email/i).first().fill(email);
    const passwordField = page.getByLabel(/mot de passe|password/i).first();
    await passwordField.fill(TEST_PASSWORD);

    await page.getByRole("button", { name: /créer.*compte|s'inscrire|sign up/i }).first().click();

    // 3) Note : Supabase exige confirmation email par défaut.
    // En test, on suppose la confirmation auto désactivée OU on utilise un service mail catch-all.
    // Si le test bloque ici, désactiver "Email confirmation" dans Supabase Auth pour les tests.

    // 4) Verification arrivee sur onboarding
    await expect(page.getByText(/bienvenue|onboarding|raison sociale/i)).toBeVisible({ timeout: 15000 });

    // 5) Skip ou remplir l'onboarding minimal
    const legalNameInput = page.getByLabel(/raison sociale|nom de la société/i).first();
    if (await legalNameInput.isVisible().catch(() => false)) {
      await legalNameInput.fill("Test E2E Société");
      // Click Suivant ou Sauvegarder
      const nextBtn = page.getByRole("button", { name: /suivant|continuer|valider|enregistrer/i }).first();
      await nextBtn.click();
    }

    // 6) On devrait arriver sur le dashboard (KPI visibles)
    await expect(page.getByText(/CA|chiffre d'affaires|tableau de bord/i)).toBeVisible({ timeout: 15000 });
  });

  test("signup avec mot de passe trop court doit échouer", async ({ page }) => {
    await page.goto("/");
    const signupTab = page.getByRole("tab", { name: /créer un compte|inscription|sign up/i }).first();
    if (await signupTab.isVisible().catch(() => false)) await signupTab.click();

    await page.getByLabel(/email/i).first().fill(`weak-${Date.now()}@example.com`);
    await page.getByLabel(/mot de passe|password/i).first().fill("123");

    await page.getByRole("button", { name: /créer.*compte|s'inscrire/i }).first().click();
    await expect(page.getByText(/mot de passe|trop court|6 caractères/i)).toBeVisible({ timeout: 5000 });
  });
});
