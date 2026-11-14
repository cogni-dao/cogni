#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/dev/smoke-authed-state`
 * Purpose: Verify a captured Playwright storageState still authenticates against the target URL by launching a headless browser and printing signed-in markers.
 * Scope: Developer sanity-check after running `capture-authed-state.mjs`. Not a validation
 *   skill; does not post comments or touch the PR.
 * Invariants: Read-only relative to the repo — never writes files, never mutates the
 *   captured storageState.
 * Side-effects: IO (launches headless Chromium, makes one HTTPS request to the target).
 * Links: https://cognidao.org/knowledge/candidate-auth-bootstrap, scripts/dev/capture-authed-state.mjs
 * @internal
 */

import { join } from "node:path";
import { chromium } from "@playwright/test";

const [, , slug, targetUrl] = process.argv;
if (!slug || !targetUrl) {
  console.error(
    "Usage: node scripts/dev/smoke-authed-state.mjs <env-slug> <url>"
  );
  process.exit(1);
}

const storageState = join(
  process.cwd(),
  ".local-auth",
  `${slug}.storageState.json`
);
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ storageState });
const page = await ctx.newPage();

page.on("console", (m) =>
  console.log(`  [page.${m.type()}]`, m.text().slice(0, 200))
);

console.log(`→ goto ${targetUrl}`);
const resp = await page.goto(targetUrl, {
  waitUntil: "domcontentloaded",
  timeout: 30_000,
});
console.log(`  status: ${resp?.status()}  final url: ${page.url()}`);

await page.waitForTimeout(2000);

const title = await page.title();
const bodyText = (
  await page
    .locator("body")
    .innerText()
    .catch(() => "")
).slice(0, 400);
const signedInMarkers = await page.evaluate(() => {
  const txt = document.body.innerText;
  return {
    has_sign_in_button: /sign\s*in|connect\s*wallet/i.test(txt),
    has_logout: /log\s*out|sign\s*out|disconnect/i.test(txt),
    has_0x_address: /0x[a-fA-F0-9]{6,}/.test(txt),
  };
});

console.log(`\n  title: ${title}`);
console.log(`  signed-in markers:`, signedInMarkers);
console.log(`  body (first 400):\n${bodyText}`);

await browser.close();
