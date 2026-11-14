// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-core/tsup.config`
 * Purpose: Build configuration for ai-core package.
 * Scope: Build tooling only; does not contain runtime code.
 * Invariants: Output must be ESM with type declarations.
 * Side-effects: IO
 * Links: https://node-template.cognidao.org/knowledge/langgraph-server-adapter
 * @internal
 */

import { defineConfig } from "tsup";

export const tsupConfig = defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false, // tsc -b emits per-file declarations; tsup handles JS only
  clean: false, // preserve .d.ts files from tsc -b (incremental builds)
  sourcemap: true,
  platform: "neutral",
});

export default tsupConfig;
