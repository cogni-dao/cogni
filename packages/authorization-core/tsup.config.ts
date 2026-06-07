// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/authorization-core/tsup.config`
 * Purpose: Build configuration for the shared authorization package.
 * Scope: Build tooling only; does not contain runtime authorization logic.
 * Invariants: Output must be ESM with type declarations emitted by tsc -b.
 * Side-effects: IO
 * Links: docs/spec/packages-architecture.md
 * @internal
 */

import { defineConfig } from "tsup";

export const tsupConfig = defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  clean: false,
  sourcemap: true,
  platform: "node",
});

export default tsupConfig;
