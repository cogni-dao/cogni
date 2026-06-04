// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/attribution.epochs.[id].claimants`
 * Purpose: Contract test for claimant-aware finalized epoch attribution endpoint.
 * Scope: Validates Zod output schema against representative data shapes. Does not test runtime behavior.
 * Invariants: ALL_MATH_BIGINT, CLAIMANTS_ARE_PLURAL.
 * Side-effects: none
 * Links: src/contracts/attribution.epoch-claimants.v1.contract.ts
 * @public
 */

import { epochClaimantsOperation } from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

describe("ledger.epoch-claimants.v1 contract", () => {
  it("validates a finalized claimant attribution response", () => {
    const data = {
      epochId: "1",
      poolTotalCredits: "10000",
      items: [
        {
          claimantKey: "user:user-1",
          claimant: {
            kind: "user",
            userId: "user-1",
          },
          displayName: "alice",
          isLinked: true,
          totalUnits: "8000",
          share: "0.800000",
          amountCredits: "8000",
          receiptIds: ["r1", "r2"],
        },
        {
          claimantKey: "identity:github:42",
          claimant: {
            kind: "identity",
            provider: "github",
            externalId: "42",
            providerLogin: "alice",
          },
          displayName: "alice",
          isLinked: false,
          totalUnits: "2000",
          share: "0.200000",
          amountCredits: "2000",
          receiptIds: ["r3"],
        },
      ],
    };

    expect(() => epochClaimantsOperation.output.parse(data)).not.toThrow();
  });

  it("rejects missing claimant payload", () => {
    expect(() =>
      epochClaimantsOperation.output.parse({
        epochId: "1",
        poolTotalCredits: "10000",
        items: [
          {
            claimantKey: "user:user-1",
            totalUnits: "100",
            share: "1.000000",
            amountCredits: "10000",
            receiptIds: [],
          },
        ],
      })
    ).toThrow();
  });
});
