#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/dev/capture-authed-state`
 * Purpose: Capture authed Playwright storageState from a running CDP-debuggable Chrome.
 * Scope: One-off developer helper — connects over CDP, exports storageState to `.local-auth/<slug>.storageState.json`. Does not drive signin, does not launch Chrome, does not run in CI.
 * Invariants: Reads only; never mutates the source Chrome profile. Write target is
 *   always under `.local-auth/` which is gitignored.
 * Side-effects: IO (connects to Chrome over CDP, writes one JSON file under .local-auth/).
 * Links: https://cognidao.org/knowledge/candidate-auth-bootstrap
 * @internal
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const [, , slug, targetUrl] = process.argv;
if (!slug || !targetUrl) {
  console.error(
    "Usage: node scripts/dev/capture-authed-state.mjs <env-slug> <url>"
  );
  process.exit(1);
}

const CDP_URL = process.env.CDP_URL ?? "http://localhost:9222";
const outDir = join(process.cwd(), ".local-auth");
const outFile = join(outDir, `${slug}.storageState.json`);

const browser = await chromium.connectOverCDP(CDP_URL);
const contexts = browser.contexts();
if (contexts.length === 0) {
  console.error(
    `No browser contexts found at ${CDP_URL}. Is Chrome running with --remote-debugging-port=9222?`
  );
  process.exit(2);
}

const targetHost = new URL(targetUrl).host;
let matchedContext = null;
let matchedPage = null;
for (const ctx of contexts) {
  for (const page of ctx.pages()) {
    try {
      if (new URL(page.url()).host === targetHost) {
        matchedContext = ctx;
        matchedPage = page;
        break;
      }
    } catch {
      // ignore about:blank / chrome:// pages
    }
  }
  if (matchedContext) break;
}

if (!matchedContext) {
  console.error(
    `No open tab found for host ${targetHost}. Open ${targetUrl} in the debuggable Chrome, sign in, then retry.`
  );
  process.exit(3);
}

const state = await matchedContext.storageState();
await mkdir(outDir, { recursive: true });
await writeFile(outFile, JSON.stringify(state, null, 2));

const cookieDomains = [...new Set(state.cookies.map((c) => c.domain))].sort();
console.log(`✅ Saved storageState → ${outFile}`);
console.log(`   tab url:      ${matchedPage.url()}`);
console.log(
  `   cookies:      ${state.cookies.length} across ${cookieDomains.length} domains`
);
console.log(`   domains:      ${cookieDomains.join(", ")}`);
console.log(`   origins:      ${state.origins.length} with localStorage`);

await browser.close();
