// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/lease-reactivation` (test)
 * Purpose: Pin `requiredLeaseGeneration` — the fresh/terminal/live/preparing matrix (task.5132).
 *   TERMINAL receipts (`released`/`failed`) force the next generation past themselves; a LIVE
 *   `allocated` receipt pins the derived generation AT its own (never past it); `preparing`
 *   proves nothing.
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
    workload: "blue",
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

  it("terminally FAILED gen-0 receipt → ADD derives generation 1 (task.5132)", () => {
    // The live incident: a failed gen-0 receipt existed, this derivation answered 0, and the
    // recreated XR presented `xcw:cogni-candidate-a:4b06359a-…:0` — refused by the actuator
    // with `akash_tx_identity_conflict` (ledgerState=failed, identity-bound to the dead
    // composite 02727e4b, observed 2026-09-18T03:01:34Z). `failed` is terminal from the ADD
    // path: bug.5192's failed-no-handle re-claim needs the SAME compositeUid, and a re-added
    // env recreates the composite with a new one.
    expect(
      requiredLeaseGeneration({
        catalogGeneration: 0,
        receipts: [receipt({ state: "failed", generation: 0 })],
      })
    ).toBe(1);
  });

  it("failed gen-0 AND failed gen-1 → 2 (max over terminal generations, plus one)", () => {
    expect(
      requiredLeaseGeneration({
        catalogGeneration: 0,
        receipts: [
          receipt({ state: "failed", generation: 0 }),
          receipt({ state: "failed", generation: 1 }),
        ],
      })
    ).toBe(2);
  });

  it("LIVE allocated gen-1 receipt → stays 1: pins its own generation, no spurious bump", () => {
    // A live paid lease must be re-stated, not leapfrogged — bumping past it would abandon a
    // billing lease and double-pay (LIVE_KEEPS_ITS_GENERATION).
    expect(
      requiredLeaseGeneration({
        catalogGeneration: 0,
        receipts: [receipt({ state: "allocated", generation: 1 })],
      })
    ).toBe(1);
  });

  it("terminal receipts bump past themselves; a higher live lease still pins the max", () => {
    expect(
      requiredLeaseGeneration({
        catalogGeneration: 0,
        receipts: [
          receipt({ state: "released", generation: 0 }),
          receipt({ state: "allocated", generation: 4 }),
          receipt({ state: "released", generation: 2 }),
        ],
      })
    ).toBe(4);
  });

  it("preparing receipts never move the answer — mid-transaction is not evidence", () => {
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
          receipt({ state: "failed", generation: 2 }),
          receipt({ state: "allocated", generation: 4 }),
        ],
      })
    ).toBe(5);
  });
});
