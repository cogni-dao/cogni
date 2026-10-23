// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/vitest/vitest.native.config`
 * Purpose: Run declared infrastructure fault acceptance independently from app setup.
 * Scope: All native CI specs, including future additions; no app instrumentation or setup imports.
 * Invariants: Declared faults/timeouts unchanged; at most three concurrent files on one runner.
 * Side-effects: Native tests own and clean disposable Docker resources in CI.
 * Links: tests/ci-invariants/native/AGENTS.md, scripts/ci/ci-proof-plan.mjs
 * @internal
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// biome-ignore lint/style/noDefaultExport: Vitest loads its config through the default export.
export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  test: {
    globals: true,
    environment: "node",
    include: ["tests/ci-invariants/native/**/*.spec.ts"],
    pool: "forks",
    maxWorkers: 3,
    minWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
