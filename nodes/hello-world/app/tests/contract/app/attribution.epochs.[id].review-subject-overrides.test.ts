// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/attribution.epochs.[id].review-subject-overrides`
 * Purpose: Contract tests for review-subject-overrides endpoint schemas.
 * Scope: Validates Zod input/output schemas against representative data shapes. Does not test runtime behavior.
 * Invariants: WRITE_ROUTES_APPROVER_GATED, shares sum to 1_000_000 PPM.
 * Side-effects: none
 * Links: contracts/attribution.review-subject-overrides.v1.contract, app/api/v1/attribution/epochs/[id]/review-subject-overrides/route
 * @public
 */

import {
  DeleteSubjectOverrideInputSchema,
  GetSubjectOverridesOutputSchema,
  PatchSubjectOverridesInputSchema,
} from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

describe("ledger.get-review-subject-overrides.v1 contract", () => {
  it("validates a well-formed GET response with overrides", () => {
    const data = {
      overrides: [
        {
          id: "550e8400-e29b-41d4-a716-446655440000",
          subjectRef: "receipt-abc",
          overrideUnits: "5000",
          overrideShares: null,
          overrideReason: "Adjusted for scope",
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
    };
    expect(() => GetSubjectOverridesOutputSchema.parse(data)).not.toThrow();
  });

  it("validates GET response with empty overrides array", () => {
    const data = { overrides: [] };
    expect(() => GetSubjectOverridesOutputSchema.parse(data)).not.toThrow();
  });

  it("validates override with claimant shares", () => {
    const data = {
      overrides: [
        {
          id: "550e8400-e29b-41d4-a716-446655440000",
          subjectRef: "receipt-abc",
          overrideUnits: null,
          overrideShares: [
            {
              claimant: { kind: "user", userId: "user-1" },
              sharePpm: 600000,
            },
            {
              claimant: {
                kind: "identity",
                provider: "github",
                externalId: "123",
                providerLogin: "dev1",
              },
              sharePpm: 400000,
            },
          ],
          overrideReason: null,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
    };
    expect(() => GetSubjectOverridesOutputSchema.parse(data)).not.toThrow();
  });
});

describe("ledger.patch-review-subject-overrides.v1 contract", () => {
  it("validates a well-formed PATCH input with unit override", () => {
    const data = {
      overrides: [
        {
          subjectRef: "receipt-abc",
          overrideUnits: "2000",
          overrideReason: "Weight adjustment",
        },
      ],
    };
    expect(() => PatchSubjectOverridesInputSchema.parse(data)).not.toThrow();
  });

  it("rejects empty overrides array", () => {
    const result = PatchSubjectOverridesInputSchema.safeParse({
      overrides: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects override with empty subjectRef", () => {
    const result = PatchSubjectOverridesInputSchema.safeParse({
      overrides: [{ subjectRef: "", overrideUnits: "1000" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-numeric overrideUnits", () => {
    const result = PatchSubjectOverridesInputSchema.safeParse({
      overrides: [{ subjectRef: "r1", overrideUnits: "abc" }],
    });
    expect(result.success).toBe(false);
  });

  it("transforms overrideUnits string to BigInt", () => {
    const parsed = PatchSubjectOverridesInputSchema.parse({
      overrides: [{ subjectRef: "r1", overrideUnits: "5000" }],
    });
    expect(parsed.overrides[0].overrideUnits).toBe(5000n);
  });
});

describe("ledger.delete-review-subject-override.v1 contract", () => {
  it("validates a well-formed DELETE input", () => {
    const data = { subjectRef: "receipt-abc" };
    expect(() => DeleteSubjectOverrideInputSchema.parse(data)).not.toThrow();
  });

  it("rejects empty subjectRef", () => {
    const result = DeleteSubjectOverrideInputSchema.safeParse({
      subjectRef: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing subjectRef", () => {
    const result = DeleteSubjectOverrideInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});
