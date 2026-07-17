// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-collect/tsup.config`
 * Purpose: Build configuration for attribution-collect package.
 * Scope: Build tooling only. Does not contain runtime code.
 * Invariants: none
 * Side-effects: IO
 * Links: docs/design/attribution-operator-gateway.md
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
