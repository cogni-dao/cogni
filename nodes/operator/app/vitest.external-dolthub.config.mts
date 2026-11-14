// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `vitest.external-dolthub.config`
 * Purpose: DoltHub-only external test runner for repo formation proof.
 * Scope: Tests in tests/external/dolthub/; no local DB or container runtime.
 * Invariants: Requires DOLTHUB_API_TOKEN + DOLTHUB_EXTERNAL_TEST_OWNER; skips without them.
 * Side-effects: process.env (.env.test injection), real HTTP to DoltHub.
 * Links: tests/external/AGENTS.md, https://cognidao.org/knowledge/dolthub-mirror-bootstrap
 * @public
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { expand } from "dotenv-expand";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const env = config({ path: path.resolve(__dirname, "../../../.env.test") });
expand(env);

export default defineConfig({
  root: __dirname,
  plugins: [tsconfigPaths({ projects: ["./tsconfig.test.json"] })],
  test: {
    include: ["tests/external/dolthub/**/*.external.test.ts"],
    // The container-backed round-trip proof owns its own lane
    // (test:external:dolthub:roundtrip): a 180s hookTimeout for the Docker
    // pull + Doltgres migrate, and tsconfig.e2e-roundtrip.json to resolve
    // @cogni/* from src. Exclude it here so this HTTP-only lane's 30s hook
    // budget never sweeps it in and times out.
    exclude: ["tests/external/dolthub/knowledge-roundtrip.external.test.ts"],
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
        execArgv: ["--dns-result-order=ipv4first"],
      },
    },
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@tests": path.resolve(__dirname, "./tests"),
    },
  },
});
