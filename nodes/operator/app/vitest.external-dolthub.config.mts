// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `vitest.external-dolthub.config`
 * Purpose: DoltHub-only external test runner for repo formation proof.
 * Scope: Tests in tests/external/dolthub/; no local DB or container runtime.
 * Invariants: Requires DOLTHUB_API_TOKEN + DOLTHUB_EXTERNAL_TEST_OWNER; skips without them.
 * Side-effects: process.env (.env.test injection), real HTTP to DoltHub.
 * Links: tests/external/AGENTS.md, docs/runbooks/dolthub-remote-bootstrap.md
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
