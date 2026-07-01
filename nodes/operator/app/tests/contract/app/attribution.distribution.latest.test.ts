// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/attribution.distribution.latest`
 * Purpose: Contract tests for GET /api/v1/public/attribution/distribution/latest — the CUMULATIVE claim read route.
 * Scope: Exercises the real wrapPublicRoute() handler with a mocked attributionStore; verifies 400 on missing account, claim:null when no finalized-with-manifest epoch, and the cumulative claim DTO shape. Does NOT hit a real DB.
 * Invariants: CUMULATIVE_MODEL (amount = leaf cumulativeAmount, string), PUBLIC_READS_FINALIZED_ONLY, PROOF_HEX_ARRAY, DISTRIBUTOR_NULLABLE.
 * Side-effects: none (container + node-id + rate limiter mocked)
 * Links: src/app/api/v1/public/attribution/distribution/latest/route, contracts/attribution.latest-distribution.v1.contract
 * @public
 */

import { latestDistributionOperation } from "@cogni/node-contracts";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TEST_NODE_ID = "00000000-0000-4000-a000-000000000001";
const TEST_ACCOUNT = "0x1111111111111111111111111111111111111111";

// --- Mocks ---

const mockAttributionStore = {
  listEpochs: vi.fn(),
  getDistributionManifestForEpoch: vi.fn(),
  getDistributionClaimForAccount: vi.fn(),
};

// The bound wrapPublicRoute reads container.config.{rateLimitBypass,DEPLOY_ENVIRONMENT};
// the route reads container.attributionStore.
vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(() => ({
    config: {
      rateLimitBypass: {
        enabled: true,
        headerName: "x-stack-test",
        headerValue: "1",
      },
      DEPLOY_ENVIRONMENT: "test",
    },
    attributionStore: mockAttributionStore,
  })),
}));

vi.mock("@/shared/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/config")>();
  return { ...actual, getNodeId: vi.fn(() => TEST_NODE_ID) };
});

// Always allow in contract tests (no real IP rate limiting).
vi.mock("@/bootstrap/http/rateLimiter", () => ({
  publicApiLimiter: { consume: vi.fn(() => true) },
  extractClientIp: vi.fn(() => "test-ip"),
  TokenBucketRateLimiter: vi.fn(),
}));

// Import after mocks.
import { GET } from "@/app/api/v1/public/attribution/distribution/latest/route";

function makeEpoch(id: bigint, status: string) {
  return {
    id,
    nodeId: TEST_NODE_ID,
    scopeId: "default",
    status,
    periodStart: new Date("2025-01-01T00:00:00Z"),
    periodEnd: new Date("2025-01-08T00:00:00Z"),
    weightConfig: {},
    poolTotalCredits: null,
    approverSetHash: null,
    approvers: null,
    allocationAlgoRef: null,
    weightConfigHash: null,
    artifactsHash: null,
    openedAt: new Date("2025-01-01T00:00:00Z"),
    closedAt: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
  };
}

function makeManifest(epochId: bigint) {
  return {
    id: `manifest-${epochId}`,
    nodeId: TEST_NODE_ID,
    scopeId: "default",
    epochId,
    distributionId: `dist-${epochId}`,
    statementHash: "0xstatement",
    merkleRoot:
      "0x9f00000000000000000000000000000000000000000000000000000000000000",
    chainId: 8453,
    tokenAddress: "0x0166Db3d42603E790Fb685059DcAa37087B032c8",
    distributionAmount: 1000n,
    totalAllocated: 1000n,
    distributorAddress: "0x717a747df71111a678202BfCD2E3B0081A9aeB56",
    createdAt: new Date("2025-01-08T00:00:00Z"),
    updatedAt: new Date("2025-01-08T00:00:00Z"),
  };
}

describe("GET /api/v1/public/attribution/distribution/latest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when the account query param is missing", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/v1/public/attribution/distribution/latest"
    );

    const res = await GET(req);
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body).toHaveProperty("error");
    // Store is never touched when the account param is absent.
    expect(mockAttributionStore.listEpochs).not.toHaveBeenCalled();
  });

  it("returns { claim: null } when no finalized epoch carries a manifest", async () => {
    // One open epoch (skipped), and one finalized epoch with NO manifest.
    mockAttributionStore.listEpochs.mockResolvedValue([
      makeEpoch(1n, "open"),
      makeEpoch(2n, "finalized"),
    ]);
    mockAttributionStore.getDistributionManifestForEpoch.mockResolvedValue(
      null
    );

    const req = new NextRequest(
      `http://localhost:3000/api/v1/public/attribution/distribution/latest?account=${TEST_ACCOUNT}`
    );

    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    const parsed = latestDistributionOperation.output.parse(body);
    expect(parsed.claim).toBeNull();

    // Only the finalized epoch is probed for a manifest.
    expect(
      mockAttributionStore.getDistributionManifestForEpoch
    ).toHaveBeenCalledTimes(1);
    expect(
      mockAttributionStore.getDistributionManifestForEpoch
    ).toHaveBeenCalledWith(2n);
    // No manifest → the claim lookup is never reached.
    expect(
      mockAttributionStore.getDistributionClaimForAccount
    ).not.toHaveBeenCalled();
  });

  it("returns the cumulative claim DTO from the newest finalized manifest", async () => {
    // Two finalized epochs both carry manifests; the newest (3n) wins.
    mockAttributionStore.listEpochs.mockResolvedValue([
      makeEpoch(2n, "finalized"),
      makeEpoch(3n, "finalized"),
    ]);
    mockAttributionStore.getDistributionManifestForEpoch.mockResolvedValue(
      makeManifest(3n)
    );
    mockAttributionStore.getDistributionClaimForAccount.mockResolvedValue({
      epochId: 3n,
      merkleRoot:
        "0x9f00000000000000000000000000000000000000000000000000000000000000",
      distributorAddress: "0x717a747df71111a678202BfCD2E3B0081A9aeB56",
      chainId: 8453,
      tokenAddress: "0x0166Db3d42603E790Fb685059DcAa37087B032c8",
      leaf: {
        index: 0,
        claimantKey: "user-1",
        account: TEST_ACCOUNT,
        // CUMULATIVE_MODEL: bigint cumulativeAmount, serialized as a string.
        amount: 5000000000000000000n,
        leafHash: "0xleaf",
        proof: [
          "0xabc0000000000000000000000000000000000000000000000000000000000000",
          "0xdef0000000000000000000000000000000000000000000000000000000000000",
        ],
      },
    });

    const req = new NextRequest(
      `http://localhost:3000/api/v1/public/attribution/distribution/latest?account=${TEST_ACCOUNT}`
    );

    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    const parsed = latestDistributionOperation.output.parse(body);

    expect(parsed.claim).not.toBeNull();
    const claim = parsed.claim as NonNullable<typeof parsed.claim>;
    expect(claim.epochId).toBe("3");
    expect(claim.root).toBe(
      "0x9f00000000000000000000000000000000000000000000000000000000000000"
    );
    expect(claim.distributor).toBe(
      "0x717a747df71111a678202BfCD2E3B0081A9aeB56"
    );
    expect(claim.chainId).toBe(8453);
    expect(claim.tokenAddress).toBe(
      "0x0166Db3d42603E790Fb685059DcAa37087B032c8"
    );
    expect(claim.account).toBe(TEST_ACCOUNT);
    // ALL_MATH_BIGINT: cumulative amount serialized as a decimal string.
    expect(claim.amount).toBe("5000000000000000000");
    expect(typeof claim.amount).toBe("string");
    expect(claim.proof).toEqual([
      "0xabc0000000000000000000000000000000000000000000000000000000000000",
      "0xdef0000000000000000000000000000000000000000000000000000000000000",
    ]);

    // The newest finalized epoch is the one queried.
    expect(
      mockAttributionStore.getDistributionClaimForAccount
    ).toHaveBeenCalledWith(3n, TEST_ACCOUNT);
  });

  it("returns { claim: null } when the latest manifest exists but the account has no leaf", async () => {
    mockAttributionStore.listEpochs.mockResolvedValue([
      makeEpoch(3n, "finalized"),
    ]);
    mockAttributionStore.getDistributionManifestForEpoch.mockResolvedValue(
      makeManifest(3n)
    );
    // Account has no leaf in the latest manifest.
    mockAttributionStore.getDistributionClaimForAccount.mockResolvedValue(null);

    const req = new NextRequest(
      `http://localhost:3000/api/v1/public/attribution/distribution/latest?account=${TEST_ACCOUNT}`
    );

    const res = await GET(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    const parsed = latestDistributionOperation.output.parse(body);
    expect(parsed.claim).toBeNull();
  });
});
