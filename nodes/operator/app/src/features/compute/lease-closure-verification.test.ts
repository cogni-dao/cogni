// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/lease-closure-verification` (test)
 * Purpose: Pin the closure classification (READBACK_OR_UNKNOWN, RELEASED_IS_A_CLAIM_NOT_A_PROOF)
 *   and the orphan set-difference — including the flagship mismatch: a `released` receipt whose
 *   Console status still bills classifies `open`, and a lease whose (node, env) the catalog no
 *   longer declares surfaces as an orphan.
 * Side-effects: none
 * Links: src/features/compute/lease-closure-verification.ts, bug.5189
 * @public
 */

import { describe, expect, it } from "vitest";

import type { AkashTxAllocationRecord } from "@/ports";

import {
  classifyReceiptClosure,
  orphanDiff,
  verifyLeaseClosures,
} from "./lease-closure-verification";

const NODE_ID = "2f8b7a10-4c6e-4a7b-9d31-1c2e3f4a5b60";
const OTHER_NODE_ID = "9a1b2c3d-4e5f-4061-8273-8495a6b7c8d9";

function receipt(
  over: Partial<AkashTxAllocationRecord> & {
    state: AkashTxAllocationRecord["state"];
  }
): AkashTxAllocationRecord {
  return {
    receiptId: "r-1",
    cogniKey: "k-1",
    identity: {
      nodeId: NODE_ID,
      compositeUid: "8e5d4c3b-2a19-4f08-b7c6-5d4e3f2a1b09",
      compositeGeneration: 1,
    },
    environment: "candidate-a",
    ...over,
  };
}

describe("classifyReceiptClosure (pure matrix)", () => {
  it("failed with NO handle → closed (fail() is only written with proof nothing bills)", () => {
    expect(
      classifyReceiptClosure(receipt({ state: "failed" }), undefined)
    ).toBe("closed");
  });

  it("preparing with NO handle → unknown (a paid lease may hide behind a lost response)", () => {
    expect(
      classifyReceiptClosure(receipt({ state: "preparing" }), undefined)
    ).toBe("unknown");
  });

  it("handle-bound + Console closed → closed", () => {
    expect(
      classifyReceiptClosure(
        receipt({ state: "released", externalName: "7001" }),
        "closed"
      )
    ).toBe("closed");
  });

  it("allocated + Console active → open (still billing, as expected pre-close)", () => {
    expect(
      classifyReceiptClosure(
        receipt({ state: "allocated", externalName: "7001" }),
        "active"
      )
    ).toBe("open");
  });

  it("RELEASED receipt whose Console status still bills → open (the flagged mismatch)", () => {
    // The ledger claims closed custody; the provider says paying. The provider is spend truth
    // (bug.5189) — this row is exactly what the verification surface exists to flag.
    expect(
      classifyReceiptClosure(
        receipt({ state: "released", externalName: "7001" }),
        "active"
      )
    ).toBe("open");
    expect(
      classifyReceiptClosure(
        receipt({ state: "released", externalName: "7001" }),
        "pending"
      )
    ).toBe("open");
  });

  it("handle-bound + no/unreadable/unknown Console state → unknown, NEVER closed", () => {
    expect(
      classifyReceiptClosure(
        receipt({ state: "allocated", externalName: "7001" }),
        undefined
      )
    ).toBe("unknown");
    expect(
      classifyReceiptClosure(
        receipt({ state: "allocated", externalName: "7001" }),
        "unknown"
      )
    ).toBe("unknown");
  });
});

describe("orphanDiff", () => {
  const declared = [
    { nodeId: NODE_ID, environment: "candidate-a" },
    { nodeId: NODE_ID, environment: "production" },
  ];

  it("flags an allocated lease whose (node, env) the catalog no longer declares", () => {
    const orphan = receipt({
      state: "allocated",
      externalName: "7001",
      environment: "preview",
    });
    expect(orphanDiff([orphan], declared)).toEqual([orphan]);
  });

  it("flags an allocated lease of a node the catalog does not declare at all", () => {
    const orphan = receipt({
      state: "allocated",
      externalName: "7001",
      identity: {
        nodeId: OTHER_NODE_ID,
        compositeUid: "u",
        compositeGeneration: 1,
      },
    });
    expect(orphanDiff([orphan], declared)).toEqual([orphan]);
  });

  it("does NOT flag declared pairs or settled receipts", () => {
    expect(
      orphanDiff(
        [
          receipt({ state: "allocated", externalName: "7001" }), // declared candidate-a
          receipt({
            state: "released",
            externalName: "7002",
            environment: "preview", // undeclared but settled custody, not a live spend
          }),
        ],
        declared
      )
    ).toEqual([]);
  });
});

describe("verifyLeaseClosures (thin service)", () => {
  it("reads Console per handle-bound receipt and classifies each", async () => {
    const calls: string[] = [];
    const verified = await verifyLeaseClosures({
      receipts: [
        receipt({ state: "allocated", externalName: "7001", cogniKey: "a" }),
        receipt({ state: "released", externalName: "7002", cogniKey: "b" }),
        receipt({ state: "failed", cogniKey: "c" }),
      ],
      readStatus: async ({ leaseId }) => {
        calls.push(leaseId);
        return { state: leaseId === "7001" ? "active" : "closed" };
      },
    });
    expect(calls.sort()).toEqual(["7001", "7002"]);
    expect(verified.map((v) => [v.receipt.cogniKey, v.closure])).toEqual([
      ["a", "open"],
      ["b", "closed"],
      ["c", "closed"],
    ]);
  });

  it("degrades ONE receipt to unknown on a failed read; the rest still classify", async () => {
    const verified = await verifyLeaseClosures({
      receipts: [
        receipt({ state: "allocated", externalName: "dead", cogniKey: "a" }),
        receipt({ state: "released", externalName: "7002", cogniKey: "b" }),
      ],
      readStatus: async ({ leaseId }) => {
        if (leaseId === "dead") throw new Error("console unreachable");
        return { state: "closed" };
      },
    });
    expect(verified.map((v) => v.closure)).toEqual(["unknown", "closed"]);
  });

  it("with NO reader, handle-bound receipts are unknown — never fabricated closed", async () => {
    const verified = await verifyLeaseClosures({
      receipts: [
        receipt({ state: "released", externalName: "7001", cogniKey: "a" }),
        receipt({ state: "failed", cogniKey: "b" }),
      ],
    });
    expect(verified.map((v) => v.closure)).toEqual(["unknown", "closed"]);
  });
});
