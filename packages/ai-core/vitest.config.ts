// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-core/vitest.config`
 * Purpose: Vitest configuration for ai-core package tests.
 * Scope: Package-local tests only; does not import node app source.
 * Invariants: Tests cover shared runtime behavior without network services.
 * Side-effects: none
 * Links: vitest.workspace.ts, packages/ai-core/tests
 * @internal
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineProject } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineProject({
  plugins: [
    tsconfigPaths({
      projects: [path.resolve(__dirname, "../../tsconfig.json")],
    }),
  ],
  test: {
    name: "ai-core",
    globals: true,
    environment: "node",
    include: ["tests/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", "dist"],
  },
});
