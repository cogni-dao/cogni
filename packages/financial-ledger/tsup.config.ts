// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/financial-ledger/tsup.config`
 * Purpose: Build configuration for financial-ledger package.
 * Scope: Build tooling only; does not contain runtime code.
 * Invariants: Output must be ESM. Two entry points: main barrel (port+domain) and adapters subpath (N-API isolated).
 * Side-effects: IO
 * Links: https://node-template.cognidao.org/knowledge/package-isolation-rules
 * @internal
 */

import { defineConfig } from "tsup";

export const tsupConfig = defineConfig({
  entry: ["src/index.ts", "src/adapters/index.ts"],
  format: ["esm"],
  dts: false, // tsc -b emits per-file declarations; tsup handles JS only
  clean: false, // preserve .d.ts files from tsc -b (incremental builds)
  sourcemap: true,
  platform: "node",
  external: ["tigerbeetle-node"],
});

export default tsupConfig;
