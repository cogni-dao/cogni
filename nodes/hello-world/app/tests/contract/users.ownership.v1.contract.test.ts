// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/users.ownership.v1.contract`
 * Purpose: Validates the authenticated ownership summary response schema.
 * Scope: Pure Zod schema validation. Does not test DB reads or HTTP transport.
 * Invariants: ownership totals are serialized as strings; recent claims preserve required attribution fields.
 * Side-effects: none
 * Links: src/contracts/users.ownership.v1.contract.ts
 * @internal
 */

import { ownershipSummaryOperation } from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

describe("users.ownership.read.v1 contract", () => {
  it("validates a well-formed ownership summary response", () => {
    const data = {
      totalUnits: "1500",
      finalizedUnits: "1000",
      pendingUnits: "500",
      finalizedSharePercent: 12.5,
      epochsMatched: 2,
      matchedAttributionCount: 3,
      linkedIdentityCount: 2,
      recentAttributions: [
        {
          epochId: "42",
          epochStatus: "finalized",
          subjectRef: "github:pr:test/repo:1",
          source: "github",
          eventType: "pr_merged",
          units: "1000",
          matchedBy: "github",
          eventTime: "2026-02-20T12:00:00.000Z",
          artifactUrl: "https://github.com/test/repo/pull/1",
        },
      ],
    };

    expect(() => ownershipSummaryOperation.output.parse(data)).not.toThrow();
  });
});
