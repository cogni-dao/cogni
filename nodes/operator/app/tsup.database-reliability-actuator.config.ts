// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { defineConfig } from "tsup";

/**
 * Self-contained private control-plane process. Next's standalone tracer never imports
 * this entry, so it ships as a separate bundle in the shared operator image (task.5247).
 */
// biome-ignore lint/style/noDefaultExport: required by tsup
export default defineConfig({
  entry: ["src/bootstrap/database-reliability-actuator.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: "dist-database-reliability-actuator",
  noExternal: [/.*/],
  esbuildOptions(options) {
    options.conditions = ["react-server", "node"];
  },
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
