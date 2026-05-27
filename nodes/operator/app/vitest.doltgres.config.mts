// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `vitest.doltgres.config.mts`
 * Purpose: Dedicated Vitest config for Doltgres-migrator regression tests.
 *   Boots its own ephemeral Doltgres container per test file via
 *   testcontainers — does NOT share the Postgres globalSetup that the rest of
 *   `vitest.component.config.mts` uses (different DB engine, no schema overlap).
 * Scope: `tests/component/db/doltgres-*.int.test.ts` only.
 * Invariants:
 *   - No globalSetup — each test file is self-contained.
 *   - Sequential (single Docker daemon, no point parallelizing).
 *   - Long-ish hook timeout: cold-pulling `dolthub/doltgresql:latest` can take 30–60s on CI.
 * Side-effects: Docker containers, process.env (per test).
 * Notes: Splits out from the operator component config so the Postgres
 *   testcontainers setup doesn't run for Doltgres tests (wasted container +
 *   conflicting DATABASE_URL env).
 * Links: nodes/operator/app/tests/component/db/doltgres-migrate.int.test.ts
 * @internal
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  plugins: [tsconfigPaths({ projects: ["./tsconfig.test.json"] })],
  test: {
    include: ["tests/component/db/doltgres-*.int.test.ts"],
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
  resolve: {
    alias: {
      "@tests": path.resolve(__dirname, "./tests"),
    },
  },
});
