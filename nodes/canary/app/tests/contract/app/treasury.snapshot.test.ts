// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/treasury.snapshot`
 * Purpose: Contract tests for /api/v1/public/treasury/snapshot endpoint.
 * Scope: Validates HTTP behavior, contract compliance, cache headers, public access. Does NOT test real RPC integration.
 * Invariants: Public access (no auth); returns 200 with staleWarning on RPC failure; output matches contract; cache headers present.
 * Side-effects: none (fully mocked)
 * Notes: Uses mocked facade to avoid real RPC calls.
 * Links: /api/v1/public/treasury/snapshot route, treasury.snapshot.v1.contract
 * @public
 */

import { TreasurySnapshotResponseV1 } from "@cogni/node-contracts";
import { CHAIN_ID, USDC_TOKEN_ADDRESS } from "@cogni/node-shared";
import { MOCK_SERVER_ENV } from "@tests/_fixtures/env/base-env";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the facade
vi.mock("@/app/_facades/treasury/snapshot.server", () => ({
  getTreasurySnapshotFacade: vi.fn(),
}));

// Mock serverEnv to avoid env validation errors in tests
// Uses shared fixture to ensure all required fields are present
vi.mock("@/shared/env", () => ({
  serverEnv: () => MOCK_SERVER_ENV,
}));
vi.mock("@/shared/env/server-env", () => ({
  serverEnv: () => MOCK_SERVER_ENV,
}));

// Mock rate limiter to always allow requests in contract tests
vi.mock("@/bootstrap/http/rateLimiter", () => ({
  publicApiLimiter: {
    consume: vi.fn(() => true), // Always allow
  },
  extractClientIp: vi.fn(() => "test-ip"),
  TokenBucketRateLimiter: vi.fn(),
}));

import { getTreasurySnapshotFacade } from "@/app/_facades/treasury/snapshot.server";
// Import after mock
import { GET } from "@/app/api/v1/public/treasury/snapshot/route";

describe("/api/v1/public/treasury/snapshot contract tests", () => {
  const mockTreasuryData = {
    treasuryAddress: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
    chainId: CHAIN_ID,
    blockNumber: "1000000",
    balances: [
      {
        token: "USDC",
        tokenAddress: USDC_TOKEN_ADDRESS,
        balanceWei: "3726420000",
        balanceFormatted: "3726.42",
        decimals: 6,
      },
    ],
    timestamp: Date.now(),
    staleWarning: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Public access", () => {
    it("should return 200 with treasury data without authentication", async () => {
      vi.mocked(getTreasurySnapshotFacade).mockResolvedValue(mockTreasuryData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/public/treasury/snapshot"
      );

      const response = await GET(req);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data).toHaveProperty("treasuryAddress");
      expect(data).toHaveProperty("balances");
    });

    it("should return 200 with staleWarning on RPC failure", async () => {
      const staleData = {
        ...mockTreasuryData,
        staleWarning: true,
      };
      vi.mocked(getTreasurySnapshotFacade).mockResolvedValue(staleData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/public/treasury/snapshot"
      );

      const response = await GET(req);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.staleWarning).toBe(true);
    });
  });

  describe("Contract compliance", () => {
    it("should return contract-valid output", async () => {
      vi.mocked(getTreasurySnapshotFacade).mockResolvedValue(mockTreasuryData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/public/treasury/snapshot"
      );

      const response = await GET(req);
      const data = await response.json();

      expect(response.status).toBe(200);

      // Validate against contract schema
      const parsed = TreasurySnapshotResponseV1.parse(data);

      expect(parsed.treasuryAddress).toBe(
        "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb"
      );
      expect(parsed.chainId).toBe(CHAIN_ID);
      expect(parsed.blockNumber).toBe("1000000");
      expect(parsed.balances).toHaveLength(1);
      expect(parsed.balances[0]?.token).toBe("USDC");
      expect(parsed.balances[0]?.tokenAddress).toBe(USDC_TOKEN_ADDRESS);
      expect(parsed.balances[0]?.balanceWei).toBe("3726420000");
      expect(parsed.balances[0]?.balanceFormatted).toBe("3726.42");
      expect(parsed.balances[0]?.decimals).toBe(6);
      expect(parsed.timestamp).toBeGreaterThan(0);
      expect(parsed.staleWarning).toBe(false);
    });

    it("should validate balance array structure", async () => {
      vi.mocked(getTreasurySnapshotFacade).mockResolvedValue(mockTreasuryData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/public/treasury/snapshot"
      );

      const response = await GET(req);
      const data = await response.json();

      expect(response.status).toBe(200);

      const parsed = TreasurySnapshotResponseV1.parse(data);
      expect(Array.isArray(parsed.balances)).toBe(true);
      expect(parsed.balances.length).toBeGreaterThan(0);
    });
  });

  describe("Cache headers", () => {
    it("should include cache-control header with correct directives", async () => {
      vi.mocked(getTreasurySnapshotFacade).mockResolvedValue(mockTreasuryData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/public/treasury/snapshot"
      );

      const response = await GET(req);

      const cacheControl = response.headers.get("Cache-Control");
      expect(cacheControl).toBeDefined();
      expect(cacheControl).toContain("public");
      expect(cacheControl).toContain("max-age=120"); // 2 minutes
      expect(cacheControl).toContain("stale-while-revalidate=300"); // 5 minutes
    });

    it("should have content-type application/json", async () => {
      vi.mocked(getTreasurySnapshotFacade).mockResolvedValue(mockTreasuryData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/public/treasury/snapshot"
      );

      const response = await GET(req);

      const contentType = response.headers.get("Content-Type");
      expect(contentType).toContain("application/json");
    });
  });

  describe("Privacy guarantees", () => {
    it("should NOT leak user_id or session data", async () => {
      vi.mocked(getTreasurySnapshotFacade).mockResolvedValue(mockTreasuryData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/public/treasury/snapshot"
      );

      const response = await GET(req);
      const responseText = await response.text();

      // Treasury is public data - but should not leak user sessions
      expect(responseText.toLowerCase()).not.toContain("user_id");
      expect(responseText.toLowerCase()).not.toContain("userid");
      expect(responseText.toLowerCase()).not.toContain("session");
    });

    it("should NOT leak api_key or virtual_key in response", async () => {
      vi.mocked(getTreasurySnapshotFacade).mockResolvedValue(mockTreasuryData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/public/treasury/snapshot"
      );

      const response = await GET(req);
      const responseText = await response.text();

      expect(responseText.toLowerCase()).not.toContain("api_key");
      expect(responseText.toLowerCase()).not.toContain("apikey");
      expect(responseText.toLowerCase()).not.toContain("virtual_key");
      expect(responseText.toLowerCase()).not.toContain("virtualkey");
    });

    it("should NOT leak reqId (request IDs) in response", async () => {
      vi.mocked(getTreasurySnapshotFacade).mockResolvedValue(mockTreasuryData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/public/treasury/snapshot"
      );

      const response = await GET(req);
      const responseText = await response.text();

      expect(responseText.toLowerCase()).not.toContain("reqid");
      expect(responseText.toLowerCase()).not.toContain("requestid");
      expect(responseText.toLowerCase()).not.toContain("request_id");
    });

    it("should contain treasury address (public DAO wallet)", async () => {
      vi.mocked(getTreasurySnapshotFacade).mockResolvedValue(mockTreasuryData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/public/treasury/snapshot"
      );

      const response = await GET(req);
      const responseText = await response.text();

      // Treasury address IS public data and SHOULD be present
      expect(responseText).toContain("treasuryAddress");
      expect(responseText).toContain(
        "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb"
      );
    });
  });
});
