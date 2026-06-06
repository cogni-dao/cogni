// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `vitest.config.mts`
 * Purpose: Vitest configuration for app-specific unit, meta, contract, and ports tests.
 * Scope: Tests that import @/ (app code). Excludes component/stack/external tests which have their own configs.
 * Invariants: Uses tsconfigPaths for @/ resolution; setup file mocks server-only and RainbowKit.
 * Side-effects: process.env (test env vars set in setup)
 * Links: tsconfig.app.json, tests/setup.ts
 * @public
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  esbuild: {
    jsx: "automatic",
  },
  plugins: [tsconfigPaths({ projects: ["./tsconfig.test.json"] })],
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: [
      "tests/unit/**/*.{test,spec}.{ts,tsx}",
      "tests/meta/**/*.{test,spec}.{ts,tsx}",
      "tests/contract/**/*.{test,spec}.{ts,tsx}",
      "tests/ports/**/*.{test,spec}.{ts,tsx}",
      "tests/security/**/*.{test,spec}.{ts,tsx}",
    ],
    exclude: ["node_modules", "dist", ".next"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@tests": path.resolve(__dirname, "./tests"),
    },
  },
});
