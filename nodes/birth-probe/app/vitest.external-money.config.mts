// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `vitest.external-money.config.mts`
 * Purpose: Vitest configuration for external money tests that spend real USDC on Base mainnet.
 * Scope: Tests in tests/external/money/ — require funded test wallet, OpenRouter API key,
 *   and a running dev:stack (Postgres + TigerBeetle). NOT part of CI.
 * Invariants: No testcontainers (expects dev:stack running). Separate config prevents accidental inclusion in other test suites.
 * Side-effects: process.env injection, real on-chain txs, real OpenRouter charges.
 * Links: tests/external/AGENTS.md, vitest.external.config.mts (similar pattern)
 * @public
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { expand } from "dotenv-expand";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.test first (defaults), then .env.local (overrides with real dev values).
// dotenv won't overwrite existing vars, so load .env.local first for priority.
const local = config({ path: path.resolve(__dirname, "../../../.env.local") });
expand(local);
const test = config({ path: path.resolve(__dirname, "../../../.env.test") });
expand(test);

// Fail fast if required env vars are missing
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[external:money] ${name} is required. Add it to .env.test.`
    );
  }
  return value;
}

requireEnv("DATABASE_SERVICE_URL");
requireEnv("TIGERBEETLE_ADDRESS");
requireEnv("OPENROUTER_API_KEY");
requireEnv("TEST_WALLET_PRIVATE_KEY");

export default defineConfig({
  root: __dirname,
  plugins: [tsconfigPaths({ projects: ["./tsconfig.test.json"] })],
  test: {
    include: ["tests/external/money/*.external.money.test.ts"],
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    // No globalSetup — expects dev:stack already running (Postgres + TigerBeetle)
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
        execArgv: ["--dns-result-order=ipv4first"],
      },
    },
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@tests": path.resolve(__dirname, "./tests"),
    },
  },
});
