// IO BILL - Configuration Playwright pour tests E2E
// Lance: npx playwright install puis npm run test:e2e

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,    // les tests utilisent la meme session - on les sequence
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60000,
  expect: { timeout: 10000 },
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    locale: "fr-FR",
    timezoneId: "Europe/Paris"
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } }
    // Activez ces lignes si vous voulez tester sur d'autres navigateurs :
    // { name: "firefox",  use: { ...devices["Desktop Firefox"] } },
    // { name: "mobile",   use: { ...devices["iPhone 14"] } }
  ],
  webServer: process.env.CI ? undefined : {
    command: "npm run dev",
    port: 5173,
    reuseExistingServer: true,
    timeout: 30000
  }
});
