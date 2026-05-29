// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tsup.config`
 * Purpose: Build configuration for knowledge-store package.
 * Scope: Build tooling only; does not contain runtime code.
 * Invariants: Output must be ESM with type declarations. Separate entrypoints per subpath.
 * Side-effects: IO
 * Links: docs/spec/packages-architecture.md
 * @internal
 */

import { defineConfig } from "tsup";

export const tsupConfig = defineConfig({
  entry: [
    "src/index.ts",
    "src/domain/contribution-schemas.ts",
    "src/adapters/doltgres/index.ts",
    "src/adapters/fake/index.ts",
  ],
  format: ["esm"],
  dts: false,
  clean: false,
  sourcemap: true,
  platform: "node",
  external: ["@cogni/ai-tools", "drizzle-orm", "postgres", "zod"],
});

// biome-ignore lint/style/noDefaultExport: required by tsup
export default tsupConfig;
