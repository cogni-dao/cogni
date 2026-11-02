// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { defineConfig } from "tsup";

/**
 * DEV ONLY (task.5400): bundles the local live harness (`scripts/node-deploy-local.ts`) the same way
 * the sequencer artifact is bundled, so `@/` aliases and ESM-only workspace packages resolve exactly
 * as they do in production. Output is gitignored and never copied into the image.
 */
// biome-ignore lint/style/noDefaultExport: required by tsup
export default defineConfig({
  entry: ["scripts/node-deploy-local.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  outDir: "dist-node-deploy-local",
  noExternal: [/.*/],
  esbuildOptions(options) {
    // The public server-adapter barrel carries Next's `server-only` marker.
    // This standalone server process must select the marker's empty server export.
    options.conditions = ["react-server", "node"];
  },
  banner: {
    // Bundled CommonJS dependencies still call require().
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});
