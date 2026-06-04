// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/attribution.epochs`
 * Purpose: Contract test for public ledger epochs list endpoint.
 * Scope: Validates Zod output schema against representative data shapes. Does not test runtime behavior.
 * Invariants: ALL_MATH_BIGINT, PUBLIC_READS_FINALIZED_ONLY.
 * Side-effects: none
 * Links: contracts/attribution.list-epochs.v1.contract, app/api/v1/public/attribution/epochs/route
 * @public
 */

import { listEpochsOperation } from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

describe("ledger.list-epochs.v1 contract", () => {
  it("should validate a well-formed epochs response", () => {
    const data = {
      epochs: [
        {
          id: "1",
          status: "finalized",
          periodStart: "2026-02-01T00:00:00.000Z",
          periodEnd: "2026-02-08T00:00:00.000Z",
          weightConfig: { pull_requests: 1, reviews: 2 },
          poolTotalCredits: "10000",
          openedAt: "2026-02-01T00:00:00.000Z",
          closedAt: "2026-02-08T00:00:00.000Z",
          createdAt: "2026-02-01T00:00:00.000Z",
        },
      ],
      total: 1,
    };

    expect(() => listEpochsOperation.output.parse(data)).not.toThrow();
  });

  it("should validate pagination input with coercion", () => {
    const result = listEpochsOperation.input.parse({
      limit: "50",
      offset: "10",
    });
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(10);
  });

  it("should apply defaults for missing pagination params", () => {
    const result = listEpochsOperation.input.parse({});
    expect(result.limit).toBe(100);
    expect(result.offset).toBe(0);
  });

  it("should apply defaults when params are undefined (searchParams.get null→undefined)", () => {
    // Routes convert null from searchParams.get() to undefined before parsing
    const result = listEpochsOperation.input.parse({
      limit: undefined,
      offset: undefined,
    });
    expect(result.limit).toBe(100);
    expect(result.offset).toBe(0);
  });

  it("should serialize bigint fields as strings (ALL_MATH_BIGINT)", () => {
    const data = {
      epochs: [
        {
          id: "999999999999",
          status: "finalized",
          periodStart: "2026-02-01T00:00:00.000Z",
          periodEnd: "2026-02-08T00:00:00.000Z",
          weightConfig: {},
          poolTotalCredits: "123456789012345",
          openedAt: "2026-02-01T00:00:00.000Z",
          closedAt: "2026-02-08T00:00:00.000Z",
          createdAt: "2026-02-01T00:00:00.000Z",
        },
      ],
      total: 1,
    };
    const parsed = listEpochsOperation.output.parse(data);
    expect(typeof parsed.epochs[0].id).toBe("string");
    expect(typeof parsed.epochs[0].poolTotalCredits).toBe("string");
  });
});
