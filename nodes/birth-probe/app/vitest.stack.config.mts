// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `vitest.stack.config.mts`
 * Purpose: Vitest configuration for stack tests (HTTP API) requiring running Docker Compose infrastructure.
 * Scope: Configures stack test environment for tests that need full app+postgres+litellm stack. Does not handle unit or pure adapter tests.
 * Invariants: Uses tsconfigPaths plugin for clean `@/core` resolution; expects env vars loaded externally; expects running HTTP server.
 * Side-effects: HTTP requests to running server, database connections
 * Notes: Environment variables loaded by package.json dotenv commands or CI; runs reset-db.ts globalSetup; sequential test execution.
 * Links: tsconfig.base.json paths, stack test files, tests/setup.ts
 * @public
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Stack tests require ${name} to be set`);
  }
  return value;
}

// Fail fast if CI / local scripts didn't wire env correctly
requireEnv("DATABASE_URL");
requireEnv("DATABASE_SERVICE_URL");
requireEnv("TEST_BASE_URL");

export default defineConfig({
  root: __dirname,
  plugins: [tsconfigPaths({ projects: ["./tsconfig.test.json"] })],
  test: {
    include: ["tests/stack/**/*.stack.test.ts"],
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    // Global setup: preflight binaries → wait for probes → openclaw gateway → litellm config → mock-llm → preflight DB roles → reset DB (order matters)
    globalSetup: [
      "./tests/stack/setup/preflight-binaries.ts",
      "./tests/stack/setup/wait-for-probes.ts",
      "./tests/stack/setup/preflight-openclaw-gateway.ts",
      "./tests/stack/setup/preflight-litellm-config.ts",
      "./tests/stack/setup/preflight-mock-llm.ts",
      "./tests/stack/setup/preflight-db-roles.ts",
      "./tests/stack/setup/reset-db.ts",
    ],
    sequence: { concurrent: false },
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
  resolve: {
    alias: {
      "@tests": path.resolve(__dirname, "./tests"),
    },
  },
});
