// IO BILL - Test E2E : créer client puis devis
// Pre-requis : un user déjà connecté avec onboarding fait
// Astuce : utilise storageState Playwright pour réutiliser une session

import { test, expect } from "@playwright/test";

test.describe("Client + Devis", () => {
  // Si la session est sauvée :
  // test.use({ storageState: "tests/.auth/user.json" });

  test.skip(({ }) => !process.env.E2E_AUTHENTICATED, "Nécessite une session active (E2E_AUTHENTICATED=1)");

  test("création client puis devis", async ({ page }) => {
    await page.goto("/clients");

    // 1) Nouveau client
    await page.getByRole("button", { name: /\+ nouveau|nouveau client|créer/i }).first().click();

    await page.getByLabel(/raison sociale|nom/i).first().fill("Acme Corp Test");
    const emailField = page.getByLabel(/email/i).first();
    if (await emailField.isVisible().catch(() => false)) {
      await emailField.fill("contact@acme-test.example");
    }

    await page.getByRole("button", { name: /enregistrer|créer|sauver/i }).first().click();
    await expect(page.getByText(/Acme Corp Test/i)).toBeVisible({ timeout: 8000 });

    // 2) Nouveau devis
    await page.goto("/quotes/new");
    await expect(page.getByText(/nouveau devis|client/i).first()).toBeVisible();

    // Sélection client (peut être un autocomplete ou select)
    const clientPicker = page.getByPlaceholder(/rechercher.*client|choisir/i).first();
    if (await clientPicker.isVisible().catch(() => false)) {
      await clientPicker.fill("Acme");
      await page.getByText(/Acme Corp Test/i).first().click();
    }

    // Ajouter une ligne
    const descField = page.getByPlaceholder(/désignation|description/i).first();
    if (await descField.isVisible().catch(() => false)) {
      await descField.fill("Prestation conseil");
      await page.getByPlaceholder(/quantité|qté/i).first().fill("1");
      await page.getByPlaceholder(/prix unitaire|p\.u\./i).first().fill("800");
    }

    // Enregistrer brouillon
    await page.getByRole("button", { name: /enregistrer|brouillon/i }).first().click();
    // Attendre l'attribution d'un numéro
    await expect(page.locator("text=/DV-\\d+/i").first()).toBeVisible({ timeout: 8000 });
  });
});
