// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/graph-execution-host/tsup.config`
 * Purpose: Build configuration for graph-execution-host package.
 * Scope: Build tooling only. Does not contain runtime code.
 * Invariants: Output must be ESM with sourcemaps.
 * Side-effects: IO
 * Links: https://node-template.cognidao.org/knowledge/package-isolation-rules
 * @internal
 */

import { defineConfig } from "tsup";

export const tsupConfig = defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: false,
  sourcemap: true,
  platform: "neutral",
});

export default tsupConfig;
