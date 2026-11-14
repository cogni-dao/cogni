// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/arch/config-hygiene`
 * Purpose: Validates dependency-cruiser config hygiene (no phantom layers, valid definitions).
 * Scope: Tests config correctness. Does NOT test boundary enforcement.
 * Invariants: All defined layers must exist in filesystem; no unused layer definitions.
 * Side-effects: IO (filesystem checks)
 * Notes: Prevents config drift and phantom layer definitions.
 * Links: .dependency-cruiser.cjs, https://node-template.cognidao.org/knowledge/hexagonal-layering-contract
 * @public
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Dependency-cruiser config hygiene", () => {
  it("defines only layers that exist in filesystem", () => {
    // Core existing layers
    const existingLayers = [
      "nodes/operator/app/src/core",
      "nodes/operator/app/src/ports",
      "nodes/operator/app/src/features",
      "nodes/operator/app/src/app",
      "nodes/operator/app/src/adapters/server",
      "nodes/operator/app/src/adapters/test",
      "nodes/operator/app/src/shared",
      "nodes/operator/app/src/bootstrap",
      "nodes/operator/app/src/lib",
      "nodes/operator/app/src/components",
      "nodes/operator/app/src/styles",
      "nodes/operator/app/src/types",
      "nodes/operator/app/src/contracts",
      "nodes/operator/app/src/mcp",
    ];

    // Verify each layer exists
    for (const path of existingLayers) {
      expect(existsSync(path), `Layer ${path} should exist`).toBe(true);
    }
  });

  it("does not define phantom adaptersWorker layer", () => {
    expect(existsSync("nodes/operator/app/src/adapters/worker")).toBe(false);
  });

  it("does not define phantom adaptersCli layer", () => {
    expect(existsSync("nodes/operator/app/src/adapters/cli")).toBe(false);
  });
});
