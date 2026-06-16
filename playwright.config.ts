import { defineConfig, devices } from "@playwright/test";

const isCI = !!process.env.CI;
const BASE = process.env.TEST_BASE_URL;
const AUTH_STATE = process.env.PLAYWRIGHT_AUTH_STATE;
if (isCI && !BASE) throw new Error("TEST_BASE_URL is required on CI.");

export default defineConfig({
  testDir: "e2e/tests",
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 1 : 2,
  reporter: [
    ["html", { outputFolder: "e2e/artifacts/report", open: "never" }],
    ["list"],
  ],
  outputDir: "e2e/artifacts/test-results",
  globalSetup: "./e2e/helpers/global-setup.cjs",
  use: {
    baseURL: BASE,
    storageState: AUTH_STATE,
    headless: true,
    trace: "on-first-retry",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "staging-full",
      testIgnore: ["**/smoke/**"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "smoke",
      testMatch: ["**/smoke/**/*.spec.ts"],
      workers: 1,
      retries: 0,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
