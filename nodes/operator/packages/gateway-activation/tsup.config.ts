// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@cogni/operator-gateway-activation/tsup.config`
 * Purpose: Build the pure gateway activation contract and state machine.
 * Scope: Build tooling only.
 * Invariants: ESM and runtime-neutral output; no application imports.
 * Side-effects: IO (build output).
 * Links: docs/spec/packages-architecture.md, bug.5570
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
