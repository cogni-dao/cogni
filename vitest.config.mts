// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `vitest.config`
 * Purpose: Vitest test runner configuration for cross-workspace tests (arch, lint, packages, services).
 * Scope: Tests that do NOT import @/ app code. App-specific tests run via apps/operator/vitest.config.mts.
 * Invariants: Coverage disabled by default; fast execution; v8 provider for Node.js compatibility; constrained envs use threads pool (MessagePort IPC, no signals) to avoid ulimit -i 0 hangs.
 * Side-effects: file system (coverage reports written to ./coverage/)
 * Notes: Uses vite-tsconfig-paths for module resolution; excludes tests/component/** from main test run.
 * Links: SonarCloud integration workflow
 * @public
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Detect constrained containers (e.g. Claude Code remote) where pending signals
// ulimit is 0, causing the multi-fork pool to hang. Fix: use threads pool with
// maxWorkers 2. Threads use MessagePort IPC (no signals), so ulimit -i 0 doesn't
// affect them. CI and local dev are unaffected (use default forks pool).
// Note: `ulimit -i` is Linux-only; on macOS the catch returns false (unconstrained).
function isConstrainedEnvironment(): boolean {
  try {
    const pending = execSync("bash -c 'ulimit -i'", {
      encoding: "utf8",
    }).trim();
    if (pending === "unlimited") return false;
    return Number(pending) < 128;
  } catch {
    return false;
  }
}

const constrained = isConstrainedEnvironment();

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    globals: true,
    environment: "node",
    pool: constrained ? "threads" : "forks",
    ...(constrained ? { maxWorkers: 2 } : {}),
    setupFiles: ["./tests/setup.ts"],
    include: [
      "tests/**/*.{test,spec}.{ts,tsx}",
      "packages/*/tests/**/*.{test,spec}.{ts,tsx}",
      "services/*/tests/**/*.{test,spec}.{ts,tsx}",
    ],
    exclude: ["node_modules", "dist", ".next", "e2e", "**/tests/external/**"],
    coverage: {
      enabled: false,
      provider: "v8",
      reporter: ["lcov", "json-summary", "text", "html"],
      reportsDirectory: "coverage",
      exclude: [
        "node_modules/",
        "tests/",
        "e2e/",
        ".next/",
        "dist/",
        "**/*.d.ts",
        "**/*.config.*",
        "**/index.ts",
      ],
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  plugins: [tsconfigPaths({ projects: ["./tsconfig.base.json"] })],
  resolve: {
    alias: [
      {
        find: /^@cogni\/repo-spec$/,
        replacement: path.resolve(
          __dirname,
          "./packages/repo-spec/src/index.ts"
        ),
      },
      {
        find: /^@cogni\/repo-spec\/testing$/,
        replacement: path.resolve(
          __dirname,
          "./packages/repo-spec/src/testing.ts"
        ),
      },
      { find: "@tests", replacement: path.resolve(__dirname, "./tests") },
    ],
  },
});
