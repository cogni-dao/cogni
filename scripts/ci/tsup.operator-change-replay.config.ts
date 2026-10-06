// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

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
