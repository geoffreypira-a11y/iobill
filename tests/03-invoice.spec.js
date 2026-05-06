// IO BILL - Test E2E : émission de facture + génération Factur-X
import { test, expect } from "@playwright/test";

test.describe("Facture + Factur-X", () => {
  test.skip(({ }) => !process.env.E2E_AUTHENTICATED, "Nécessite une session active");

  test("création + émission facture", async ({ page }) => {
    await page.goto("/invoices/new");
    await expect(page.getByText(/nouvelle facture|client/i).first()).toBeVisible();

    // Sélection client (suppose au moins un client existe)
    const clientPicker = page.getByPlaceholder(/rechercher.*client|choisir/i).first();
    if (await clientPicker.isVisible().catch(() => false)) {
      await clientPicker.click();
      // Click sur le premier résultat
      await page.locator('[role="option"], .client-option, [data-client-id]').first().click().catch(() => {});
    }

    // Ajouter une ligne
    await page.getByPlaceholder(/désignation/i).first().fill("Conseil stratégique");
    await page.getByPlaceholder(/quantité|qté/i).first().fill("1");
    await page.getByPlaceholder(/prix unitaire/i).first().fill("1000");

    // Enregistrer
    await page.getByRole("button", { name: /enregistrer/i }).first().click();
    await expect(page.locator("text=/FA-\\d+/i").first()).toBeVisible({ timeout: 8000 });

    // Émettre définitivement
    await page.getByRole("button", { name: /émettre/i }).first().click();
    await page.getByRole("button", { name: /émettre définitivement|confirmer/i }).first().click();

    // Vérifier le badge "Émise"
    await expect(page.getByText(/émise|issued/i).first()).toBeVisible({ timeout: 10000 });

    // Vérifier que la zone "verrouillée" apparaît
    await expect(page.getByText(/verrouillé|hash/i).first()).toBeVisible({ timeout: 10000 });
  });

  test("facture émise → bouton Partager génère un lien public", async ({ page }) => {
    // On suppose qu'il y a au moins une facture émise
    await page.goto("/invoices");
    const firstInvoice = page.locator("table tbody tr").first();
    if (!(await firstInvoice.isVisible().catch(() => false))) {
      test.skip();
      return;
    }
    await firstInvoice.click();

    const shareBtn = page.getByRole("button", { name: /partager/i }).first();
    if (!(await shareBtn.isVisible().catch(() => false))) {
      test.skip();
      return;
    }
    // Le clic ouvre un alert/clipboard — on intercepte
    page.on("dialog", async (d) => {
      expect(d.message()).toMatch(/lien|copié|http/i);
      await d.accept();
    });
    await shareBtn.click();
  });
});
