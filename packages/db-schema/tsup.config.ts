// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-schema/tsup.config`
 * Purpose: Build configuration for db-schema package with multiple entry points.
 * Scope: Build tooling only; does not contain runtime code.
 * Invariants: Output must be ESM with type declarations. Separate entrypoints per slice.
 * Side-effects: IO
 * Links: https://node-template.cognidao.org/knowledge/package-isolation-rules
 * @internal
 */

import { defineConfig } from "tsup";

export const tsupConfig = defineConfig({
  entry: [
    "src/index.ts",
    "src/refs.ts",
    "src/scheduling.ts",
    "src/auth.ts",
    "src/billing.ts",
    "src/compute.ts",
    "src/ai.ts",
    "src/ai-threads.ts",
    "src/identity.ts",
    "src/attribution.ts",
    "src/profile.ts",
  ],
  format: ["esm"],
  dts: false, // tsc -b emits per-file declarations; tsup handles JS only
  clean: false, // preserve .d.ts files from tsc -b (incremental builds)
  sourcemap: true,
  platform: "node",
  external: ["drizzle-orm", "@cogni/scheduler-core"],
});

export default tsupConfig;
