// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-template-doltgres-schema/tsup.config`
 * Purpose: Build configuration for @cogni/node-template-doltgres-schema — node-template's node-local Drizzle schema for the Doltgres knowledge plane.
 * Scope: Build tooling only; does not contain runtime code.
 * Invariants: Output is ESM. Mirrors @cogni/operator-doltgres-schema shape — per-slice entry points so downstream importers can tree-shake via subpath imports.
 * Side-effects: IO
 * Links: docs/spec/packages-architecture.md, work/items/task.5077.node-template-doltgres-substrate.md
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
