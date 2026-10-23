// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `actor-allocation-route.test`
 * Purpose: Prove a late-resolved beneficiary can read a settled allocation lifecycle.
 * Scope: Route authorization with identity and store mocked; does not use a database or network.
 * Invariants: RESOLVED_BENEFICIARY_ONLY; FROZEN_ALLOCATION_UNCHANGED.
 * Side-effects: none
 * Links: story.5075, src/app/api/v1/attribution/actor-allocations/[allocationRef]/route.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  getActorContributionAllocationLifecycle: vi.fn(),
}));
const resolveAttributionActor = vi.hoisted(() => vi.fn());
const resolveRequestPrincipal = vi.hoisted(() => vi.fn());
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));

vi.mock("@/app/_lib/auth/request-identity", () => ({
  resolveRequestPrincipal,
}));
vi.mock("@/bootstrap/actor-attribution", () => ({
  resolveAttributionActor,
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ attributionStore: store }),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (
      _options: unknown,
      handler: (
        ctx: { log: typeof log; reqId: string; routeId: string },
        request: Request,
        user: undefined,
        context: { params: Promise<{ allocationRef: string }> }
      ) => Promise<Response>
    ) =>
    (
      request: Request,
      context: { params: Promise<{ allocationRef: string }> }
    ) =>
      handler(
        { log, reqId: "req-1", routeId: "attribution.actor-allocation.read" },
        request,
        undefined,
        context
      ),
}));

import { GET } from "@/app/api/v1/attribution/actor-allocations/[allocationRef]/route";

const beneficiaryActorId = "019a0000-0000-7000-8000-000000000002";

const settledLifecycle = {
  allocation: {
    allocationRef: "019a0000-0000-7000-8000-000000000003",
    contractVersion: "actor.contribution.allocation.v1" as const,
    nodeId: "node-1",
    scopeId: "scope-1",
    epochId: "1",
    receiptId: "receipt-1",
    earnedByActorId: "019a0000-0000-7000-8000-000000000001",
    beneficiaryActorId: null,
    beneficiaryPolicyId: null,
    beneficiaryPolicyVersion: null,
    contributionCutoff: "2026-10-02T12:00:00.000Z",
    sourceEvidence: { provider: "github" },
    sourceEvidenceHash: "source-hash",
    createdAt: new Date("2026-10-03T12:00:00.000Z"),
  },
  resolvedBeneficiaryActorId: beneficiaryActorId,
  status: "settled" as const,
  tokenAmount: 17n,
  claimantWallet: "0x1111111111111111111111111111111111111111",
  liabilityId: "019a0000-0000-7000-8000-000000000004",
  settlementId: "019a0000-0000-7000-8000-000000000005",
};

async function getAllocation(): Promise<Response> {
  return GET(
    new Request(
      `https://example.test/api/v1/attribution/actor-allocations/${settledLifecycle.allocation.allocationRef}`
    ),
    {
      params: Promise.resolve({
        allocationRef: settledLifecycle.allocation.allocationRef,
      }),
    }
  );
}

describe("GET actor allocation lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveRequestPrincipal.mockResolvedValue({
      kind: "human",
      principalId: "user:node-1/user-1",
      userId: "user-1",
    });
    store.getActorContributionAllocationLifecycle.mockResolvedValue(
      settledLifecycle
    );
  });

  it("allows the resolved beneficiary without rewriting frozen beneficiary facts", async () => {
    resolveAttributionActor.mockResolvedValue(beneficiaryActorId);

    const response = await getAllocation();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      allocation: { beneficiaryActorId: null },
      resolvedBeneficiaryActorId: beneficiaryActorId,
      status: "settled",
      tokenAmount: "17",
    });
  });

  it("denies an unrelated human", async () => {
    resolveAttributionActor.mockResolvedValue(
      "019a0000-0000-7000-8000-000000000099"
    );

    const response = await getAllocation();

    expect(response.status).toBe(403);
  });
});
