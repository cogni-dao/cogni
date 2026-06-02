// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/analytics.summary`
 * Purpose: Contract tests for /api/v1/analytics/summary endpoint.
 * Scope: Validates HTTP behavior, contract compliance, cache headers, PII denylist. Does NOT test Mimir integration or real metrics.
 * Invariants: Invalid windows return 400; output matches contract; cache headers present; no forbidden identifiers leaked.
 * Side-effects: none (fully mocked)
 * Notes: Uses mocked facade to avoid real metrics queries.
 * Links: /api/v1/analytics/summary route, analytics.summary.v1.contract
 * @public
 */

import { analyticsSummaryOperation } from "@cogni/node-contracts";
import { MOCK_SERVER_ENV } from "@tests/_fixtures/env/base-env";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the facade
vi.mock("@/app/_facades/analytics/summary.server", () => ({
  getAnalyticsSummaryFacade: vi.fn(),
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

import { getAnalyticsSummaryFacade } from "@/app/_facades/analytics/summary.server";
// Import after mock
import { GET } from "@/app/api/v1/public/analytics/summary/route";

describe("/api/v1/analytics/summary contract tests", () => {
  const mockSummaryData = {
    window: "7d" as const,
    generatedAt: "2025-01-01T12:00:00.000Z",
    cacheTtlSeconds: 60,
    summary: {
      totalRequests: 1000,
      totalTokens: 50000,
      errorRatePercent: 2.5,
      latencyP50Ms: null,
      latencyP95Ms: null,
    },
    timeseries: {
      requestRate: [
        { timestamp: "2025-01-01T00:00:00.000Z", value: 100 },
        { timestamp: "2025-01-01T01:00:00.000Z", value: 120 },
      ],
      tokenRate: [
        { timestamp: "2025-01-01T00:00:00.000Z", value: 5000 },
        { timestamp: "2025-01-01T01:00:00.000Z", value: 6000 },
      ],
      errorRate: [
        { timestamp: "2025-01-01T00:00:00.000Z", value: 2.0 },
        { timestamp: "2025-01-01T01:00:00.000Z", value: 3.0 },
      ],
    },
    distribution: {
      modelClass: {
        free: null,
        standard: null,
        premium: null,
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Invalid window parameter", () => {
    it("should return 400 for invalid window parameter", async () => {
      const req = new NextRequest(
        "http://localhost:3000/api/v1/analytics/summary?window=14d"
      );

      const response = await GET(req);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data).toHaveProperty("error");
    });

    it("should return 400 for non-enum window values", async () => {
      const invalidWindows = ["1d", "365d", "all", "custom"];

      for (const window of invalidWindows) {
        const req = new NextRequest(
          `http://localhost:3000/api/v1/analytics/summary?window=${window}`
        );

        const response = await GET(req);
        expect(response.status).toBe(400);
      }
    });

    it("should accept valid window values (7d, 30d, 90d)", async () => {
      vi.mocked(getAnalyticsSummaryFacade).mockResolvedValue(mockSummaryData);

      const validWindows = ["7d", "30d", "90d"];

      for (const window of validWindows) {
        const req = new NextRequest(
          `http://localhost:3000/api/v1/analytics/summary?window=${window}`
        );

        const response = await GET(req);
        expect(response.status).toBe(200);
      }
    });

    it("should default to 7d when window parameter is omitted", async () => {
      vi.mocked(getAnalyticsSummaryFacade).mockResolvedValue(mockSummaryData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/analytics/summary"
      );

      const response = await GET(req);
      expect(response.status).toBe(200);

      // Verify facade was called with default window
      expect(getAnalyticsSummaryFacade).toHaveBeenCalledWith({
        window: "7d",
      });
    });
  });

  describe("Contract compliance", () => {
    it("should return contract-valid output", async () => {
      vi.mocked(getAnalyticsSummaryFacade).mockResolvedValue(mockSummaryData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/analytics/summary?window=7d"
      );

      const response = await GET(req);
      const data = await response.json();

      expect(response.status).toBe(200);

      // Validate against contract schema
      const parsed = analyticsSummaryOperation.output.parse(data);

      expect(parsed.window).toBe("7d");
      expect(parsed.generatedAt).toBe("2025-01-01T12:00:00.000Z");
      expect(parsed.cacheTtlSeconds).toBe(60);
      expect(parsed.summary).toHaveProperty("totalRequests");
      expect(parsed.summary).toHaveProperty("totalTokens");
      expect(parsed.summary).toHaveProperty("errorRatePercent");
      expect(parsed.timeseries).toHaveProperty("requestRate");
      expect(parsed.timeseries).toHaveProperty("tokenRate");
      expect(parsed.timeseries).toHaveProperty("errorRate");
    });

    it("should validate nullable fields in contract", async () => {
      const dataWithNulls = {
        ...mockSummaryData,
        summary: {
          totalRequests: null,
          totalTokens: null,
          errorRatePercent: null,
          latencyP50Ms: null,
          latencyP95Ms: null,
        },
        timeseries: {
          requestRate: [{ timestamp: "2025-01-01T00:00:00.000Z", value: null }],
          tokenRate: [{ timestamp: "2025-01-01T00:00:00.000Z", value: null }],
          errorRate: [{ timestamp: "2025-01-01T00:00:00.000Z", value: null }],
        },
      };

      vi.mocked(getAnalyticsSummaryFacade).mockResolvedValue(dataWithNulls);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/analytics/summary?window=7d"
      );

      const response = await GET(req);
      const data = await response.json();

      expect(response.status).toBe(200);

      // Should accept null values (k-anonymity suppression)
      const parsed = analyticsSummaryOperation.output.parse(data);
      expect(parsed.summary.totalRequests).toBeNull();
      expect(parsed.summary.totalTokens).toBeNull();
      expect(parsed.timeseries.requestRate[0]?.value).toBeNull();
    });
  });

  describe("Cache headers", () => {
    it("should include cache-control header with correct directives", async () => {
      vi.mocked(getAnalyticsSummaryFacade).mockResolvedValue(mockSummaryData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/analytics/summary?window=7d"
      );

      const response = await GET(req);

      const cacheControl = response.headers.get("Cache-Control");
      expect(cacheControl).toBeDefined();
      expect(cacheControl).toContain("public");
      expect(cacheControl).toContain("max-age=60");
      expect(cacheControl).toContain("stale-while-revalidate=300");
    });

    it("should have content-type application/json", async () => {
      vi.mocked(getAnalyticsSummaryFacade).mockResolvedValue(mockSummaryData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/analytics/summary?window=7d"
      );

      const response = await GET(req);

      const contentType = response.headers.get("Content-Type");
      expect(contentType).toContain("application/json");
    });
  });

  describe("PII/identifier denylist scan", () => {
    it("should NOT leak user_id in response", async () => {
      vi.mocked(getAnalyticsSummaryFacade).mockResolvedValue(mockSummaryData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/analytics/summary?window=7d"
      );

      const response = await GET(req);
      const responseText = await response.text();

      // Forbidden identifiers
      expect(responseText.toLowerCase()).not.toContain("user_id");
      expect(responseText.toLowerCase()).not.toContain("userid");
    });

    it("should NOT leak wallet addresses in response", async () => {
      vi.mocked(getAnalyticsSummaryFacade).mockResolvedValue(mockSummaryData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/analytics/summary?window=7d"
      );

      const response = await GET(req);
      const responseText = await response.text();

      expect(responseText.toLowerCase()).not.toContain("wallet");
      expect(responseText.toLowerCase()).not.toContain("0x"); // Ethereum address prefix
    });

    it("should NOT leak api_key or virtual_key in response", async () => {
      vi.mocked(getAnalyticsSummaryFacade).mockResolvedValue(mockSummaryData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/analytics/summary?window=7d"
      );

      const response = await GET(req);
      const responseText = await response.text();

      expect(responseText.toLowerCase()).not.toContain("api_key");
      expect(responseText.toLowerCase()).not.toContain("apikey");
      expect(responseText.toLowerCase()).not.toContain("virtual_key");
      expect(responseText.toLowerCase()).not.toContain("virtualkey");
    });

    it("should NOT leak reqId (request IDs) in response", async () => {
      vi.mocked(getAnalyticsSummaryFacade).mockResolvedValue(mockSummaryData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/analytics/summary?window=7d"
      );

      const response = await GET(req);
      const responseText = await response.text();

      expect(responseText.toLowerCase()).not.toContain("reqid");
      expect(responseText.toLowerCase()).not.toContain("requestid");
      expect(responseText.toLowerCase()).not.toContain("request_id");
    });

    it("should NOT leak IP addresses in response", async () => {
      vi.mocked(getAnalyticsSummaryFacade).mockResolvedValue(mockSummaryData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/analytics/summary?window=7d"
      );

      const response = await GET(req);
      const responseText = await response.text();

      expect(responseText.toLowerCase()).not.toContain("ip_address");
      expect(responseText.toLowerCase()).not.toContain("ipaddress");
      // Don't check for raw IPs as they could be version numbers
    });

    it("should NOT leak user_agent in response", async () => {
      vi.mocked(getAnalyticsSummaryFacade).mockResolvedValue(mockSummaryData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/analytics/summary?window=7d"
      );

      const response = await GET(req);
      const responseText = await response.text();

      expect(responseText.toLowerCase()).not.toContain("user_agent");
      expect(responseText.toLowerCase()).not.toContain("useragent");
    });

    it("should NOT leak billing_account_id in response", async () => {
      vi.mocked(getAnalyticsSummaryFacade).mockResolvedValue(mockSummaryData);

      const req = new NextRequest(
        "http://localhost:3000/api/v1/analytics/summary?window=7d"
      );

      const response = await GET(req);
      const responseText = await response.text();

      expect(responseText.toLowerCase()).not.toContain("billing_account");
      expect(responseText.toLowerCase()).not.toContain("billingaccount");
      expect(responseText.toLowerCase()).not.toContain("account_id");
    });
  });
});
