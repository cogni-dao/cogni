// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/lease-reactivation` (test)
 * Purpose: Pin `requiredLeaseGeneration` — the fresh/settled/allocated/failed-no-handle matrix.
 *   Only handle-bound receipts (`allocated`/`released`) at or above the catalog's generation
 *   force a bump; everything else returns the catalog's own generation unchanged.
 * Side-effects: none
 * Links: src/features/compute/lease-reactivation.ts
 * @public
 */

import { describe, expect, it } from "vitest";

import type { AkashTxAllocationRecord } from "@/ports";

import { requiredLeaseGeneration } from "./lease-reactivation";

const NODE_ID = "2f8b7a10-4c6e-4a7b-9d31-1c2e3f4a5b60";

function receipt(
  over: Partial<AkashTxAllocationRecord> & {
    state: AkashTxAllocationRecord["state"];
    generation: number;
  }
): AkashTxAllocationRecord {
  const { generation, ...rest } = over;
  return {
    receiptId: "r-1",
    cogniKey: `xcw:cogni-candidate-a-blue:blue:${generation}`,
    identity: {
      nodeId: NODE_ID,
      compositeUid: "8e5d4c3b-2a19-4f08-b7c6-5d4e3f2a1b09",
      compositeGeneration: generation,
    },
    environment: "candidate-a",
    ...rest,
  };
}

describe("requiredLeaseGeneration", () => {
  it("fresh: no receipts → the catalog's own generation (0 stays a birth row)", () => {
    expect(
      requiredLeaseGeneration({ catalogGeneration: 0, receipts: [] })
    ).toBe(0);
    expect(
      requiredLeaseGeneration({ catalogGeneration: 3, receipts: [] })
    ).toBe(3);
  });

  it("settled (released) receipt at the current generation → bump past it", () => {
    expect(
      requiredLeaseGeneration({
        catalogGeneration: 0,
        receipts: [receipt({ state: "released", generation: 0 })],
      })
    ).toBe(1);
  });

  it("allocated (still live) receipt at the current generation → bump too (its key is spent)", () => {
    expect(
      requiredLeaseGeneration({
        catalogGeneration: 2,
        receipts: [receipt({ state: "allocated", generation: 2 })],
      })
    ).toBe(3);
  });

  it("takes max(such generations)+1 over several spent receipts", () => {
    expect(
      requiredLeaseGeneration({
        catalogGeneration: 0,
        receipts: [
          receipt({ state: "released", generation: 0 }),
          receipt({ state: "allocated", generation: 4 }),
          receipt({ state: "released", generation: 2 }),
        ],
      })
    ).toBe(5);
  });

  it("failed-no-handle receipts never force a bump — that key is re-claimable (bug.5192)", () => {
    expect(
      requiredLeaseGeneration({
        catalogGeneration: 0,
        receipts: [receipt({ state: "failed", generation: 0 })],
      })
    ).toBe(0);
  });

  it("preparing receipts never force a bump — mid-transaction is not settled evidence", () => {
    expect(
      requiredLeaseGeneration({
        catalogGeneration: 1,
        receipts: [receipt({ state: "preparing", generation: 1 })],
      })
    ).toBe(1);
  });

  it("receipts BELOW the catalog generation are already superseded — no bump", () => {
    expect(
      requiredLeaseGeneration({
        catalogGeneration: 5,
        receipts: [
          receipt({ state: "released", generation: 3 }),
          receipt({ state: "allocated", generation: 4 }),
        ],
      })
    ).toBe(5);
  });
});
