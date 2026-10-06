// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/ci/tsup.operator-change-replay.config`
 * Purpose: Build the checked-in zero-install operator-change replay artifact.
 * Scope: Canonical replay CLI bundling only; does not define replay policy.
 * Invariants: Full CI must rebuild this artifact and prove byte equality with the committed bundle.
 * Side-effects: process.env (optional output directory override)
 * Links: docs/spec/merge-queue-config.md, task.5185
 * @internal
 */

import { defineConfig } from "tsup";

// biome-ignore lint/style/noDefaultExport: required by tsup
export default defineConfig({
  entry: {
    "operator-change-replay": "scripts/ci/operator-change-replay.ts",
  },
  outDir: process.env.OPERATOR_CHANGE_BUNDLE_OUT_DIR ?? "scripts/ci/dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  splitting: false,
  sourcemap: false,
  minify: false,
  clean: false,
  noExternal: [/.*/],
  banner: { js: "#!/usr/bin/env node" },
});
