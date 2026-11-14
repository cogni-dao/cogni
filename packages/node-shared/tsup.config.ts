// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-shared/tsup.config`
 * Purpose: Build configuration for node-shared package.
 * Scope: Build tooling only. Does NOT contain runtime code.
 * Invariants: Output must be ESM with source maps.
 * Side-effects: IO
 * Links: https://node-template.cognidao.org/knowledge/package-isolation-rules
 * @internal
 */

import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: false,
  sourcemap: true,
  platform: "neutral",
});
