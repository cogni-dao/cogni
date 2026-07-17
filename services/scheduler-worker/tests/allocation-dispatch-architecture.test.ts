// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker/tests/allocation-dispatch-architecture`
 * Purpose: Prevent regression to direct ledger allocation helpers in the worker path.
 * Scope: Checks worker source files and does NOT cover plugin internals or app-layer finalized reads.
 * Invariants:
 * - PROFILE_SELECTS_ALLOCATOR: worker resolves allocators via registries, not deriveAllocationAlgoRef().
 * - EXECUTOR_IS_GENERIC: worker does not call computeReceiptWeights() directly.
 * Side-effects: filesystem reads
 * Links: [packages/attribution-collect/src/activities/ledger.ts, packages/temporal-workflows/src/workflows/collect-epoch.workflow.ts, docs/spec/plugin-attribution-pipeline.md]
 * @internal
 */

import fs from "node:fs";

import { describe, expect, it } from "vitest";

const ledgerActivityPath = new URL(
  "../../../packages/attribution-collect/src/activities/ledger.ts",
  import.meta.url
);
const collectWorkflowPath = new URL(
  "../../../packages/temporal-workflows/src/workflows/collect-epoch.workflow.ts",
  import.meta.url
);

describe("worker allocation dispatch architecture", () => {
  it("does not use direct ledger allocation helpers in ledger activities", () => {
    const source = fs.readFileSync(ledgerActivityPath, "utf8");

    expect(source).toContain("dispatchAllocator(");
    expect(source).not.toContain("computeReceiptWeights(");
    expect(source).not.toContain("deriveAllocationAlgoRef(");
  });

  it("does not derive allocator refs inside the collect workflow", () => {
    const source = fs.readFileSync(collectWorkflowPath, "utf8");

    expect(source).not.toContain("deriveAllocationAlgoRef(");
    expect(source).toContain("attributionPipeline");
  });
});
