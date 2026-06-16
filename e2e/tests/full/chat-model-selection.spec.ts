// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@e2e/full/chat-model-selection`
 * Purpose: Validates authenticated chat page visits and model selection persistence.
 * Scope: Covers saved-session navigation to protected pages and local model picker persistence. Does not test real model inference or billing.
 * Invariants: Saved auth state reaches protected pages without redirect; selected model persists across reloads.
 * Side-effects: IO, time, global
 * Notes: Requires PLAYWRIGHT_AUTH_STATE to point at a saved Playwright storage state file.
 * Links: src/app/(app)/chat/page.tsx, src/app/(app)/dashboard/page.tsx
 * @internal
 */

import { expect, test } from "@playwright/test";

test.skip(
  !process.env.PLAYWRIGHT_AUTH_STATE,
  "Set PLAYWRIGHT_AUTH_STATE to a saved Playwright storage state file."
);

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/ai/models", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        models: [
          { id: "qwen3-4b", name: "Qwen 3 4B (Free)", isFree: true },
          { id: "gpt-4o-mini", name: "GPT-4O Mini", isFree: false },
          { id: "claude-3-haiku", name: "Claude 3 Haiku", isFree: false },
        ],
        defaultModelId: "gpt-4o-mini",
      }),
    });
  });
});

test("saved auth state reaches protected pages", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard(?:\/)?$/);

  await page.goto("/chat");
  await expect(page).toHaveURL(/\/chat(?:\/)?$/);
  await expect(page.getByRole("button", { name: /select model/i })).toBeVisible();
});

test("user can select model and selection persists on reload", async ({ page }) => {
  await page.goto("/chat");

  const modelTrigger = page.getByRole("button", { name: /select model/i });
  await expect(modelTrigger).toBeVisible();
  await expect(modelTrigger).toContainText("GPT-4O Mini");

  await modelTrigger.click();

  const qwenOption = page.getByRole("button", { name: /Qwen 3 4B/i });
  await expect(qwenOption).toBeVisible();
  await qwenOption.click();

  await expect(modelTrigger).toContainText("Qwen 3 4B");

  await page.reload();

  await expect(async () => {
    const triggerText = await modelTrigger.textContent();
    expect(triggerText).toContain("Qwen 3 4B");
  }).toPass();
});
