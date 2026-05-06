// IO BILL - Tests E2E smoke : pages publiques accessibles sans auth
import { test, expect } from "@playwright/test";

test.describe("Routes publiques (sans auth)", () => {
  test("page d'auth s'affiche au /", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/IO BILL|connexion|sign in|email/i).first()).toBeVisible();
  });

  test("token public invalide → page d'erreur claire", async ({ page }) => {
    await page.goto("/p/invoice/INVALID_TOKEN_HERE");
    await expect(page.getByText(/lien.*inaccessible|invalid|expired|invalide/i).first()).toBeVisible({ timeout: 10000 });
  });

  test("token public quote invalide → erreur", async ({ page }) => {
    await page.goto("/p/quote/NONEXISTENT");
    await expect(page.getByText(/lien.*inaccessible|invalid|expired|invalide/i).first()).toBeVisible({ timeout: 10000 });
  });

  test("token portal invalide → erreur", async ({ page }) => {
    await page.goto("/p/portal/INVALIDPORTALTOKEN");
    await expect(page.getByText(/lien.*inaccessible|invalid|expired|invalide/i).first()).toBeVisible({ timeout: 10000 });
  });

  test("manifest PWA est servi", async ({ page }) => {
    const response = await page.request.get("/manifest.webmanifest");
    expect([200, 304]).toContain(response.status());
  });
});
