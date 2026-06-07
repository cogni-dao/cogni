// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/vitest.config`
 * Purpose: Vitest configuration for langgraph-graphs package tests.
 * Scope: Package-local tests only; does not import from app src/.
 * Invariants:
 *   - Tests only import from this package or other @cogni/* packages
 *   - No network/LLM calls in unit tests (mock LangChain)
 * Side-effects: none
 * Links: vitest.workspace.ts, tests/
 * @internal
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineProject } from "vitest/config";
import { workspaceSourceAliases } from "../../scripts/vitest/workspace-source-aliases.mts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineProject({
  plugins: [
    tsconfigPaths({
      // Use repo root tsconfig for @cogni/* workspace resolution
      projects: [path.resolve(__dirname, "../../tsconfig.json")],
    }),
  ],
  resolve: {
    alias: workspaceSourceAliases(path.resolve(__dirname, "../..")),
  },
  test: {
    name: "langgraph-graphs",
    globals: true,
    environment: "node",
    include: ["tests/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", "dist", "tests/external/**"],
    testTimeout: 10_000,
  },
});
