// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/operator-doltgres-schema/tsup.config`
 * Purpose: Build configuration for @cogni/operator-doltgres-schema — operator's node-local Drizzle schema for the Doltgres knowledge plane (work items live here).
 * Scope: Build tooling only; does not contain runtime code.
 * Invariants: Output is ESM. Mirrors @cogni/poly-doltgres-schema shape — per-slice entry points so downstream importers can tree-shake via subpath imports.
 * Side-effects: IO
 * Links: https://node-template.cognidao.org/knowledge/package-isolation-rules
 * @internal
 */

import { defineConfig } from "tsup";

export const tsupConfig = defineConfig({
  entry: ["src/index.ts", "src/work-items.ts", "src/knowledge.ts"],
  format: ["esm"],
  dts: false,
  clean: false,
  sourcemap: true,
  platform: "node",
  external: ["drizzle-orm", "@cogni/knowledge-base"],
});

// biome-ignore lint/style/noDefaultExport: required by tsup
export default tsupConfig;
