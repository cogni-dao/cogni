// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/deploy-policy/vitest.config`
 * Purpose: Vitest configuration for package-local deploy-policy tests.
 * Scope: Package-local tests only; does not configure root or cross-package test discovery.
 * Invariants: Only package-local deploy-policy tests are included.
 * Side-effects: none
 * Links: docs/design/operator-fleet-safety.md
 * @internal
 */

import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "deploy-policy",
    globals: true,
    environment: "node",
    include: ["tests/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules", "dist"],
    testTimeout: 10_000,
  },
});
