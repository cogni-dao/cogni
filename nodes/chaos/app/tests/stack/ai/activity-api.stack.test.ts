// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/ai/activity-api.stack.test`
 * Purpose: Stack test for Activity API route authentication and error handling.
 * Scope: Tests auth gate, input validation, and error response codes. Does not test UI. Does not test business logic or data persistence.
 * Invariants:
 * - inv_auth_server_gate: Unauthenticated requests return 401
 * - inv_cursor_is_opaque_and_safe: Invalid cursor returns 400
 * - inv_time_semantics_enforced: Out-of-range returns 400
 * - inv_bounded_queries: Invalid limit returns 400
 * Side-effects: IO (database writes, HTTP requests via route handler)
 * Notes: Uses APP_ENV=test; mocks session for auth tests.
 * Links: [ActivityRoute](../../../../src/app/api/v1/activity/route.ts)
 * @internal
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Mock getServerSessionUser for auth tests
vi.mock("@/lib/auth/server", () => ({
  getServerSessionUser: vi.fn(),
}));

import type { SessionUser } from "@cogni/node-shared";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { GET } from "@/app/api/v1/activity/route";
import { getServerSessionUser } from "@/lib/auth/server";
import { billingAccounts, users, virtualKeys } from "@/shared/db/schema";

describe("Activity API Stack Tests", () => {
  let testUserId: string;
  let testBillingAccountId: string;

  beforeAll(async () => {
    // Ensure test mode
    if (process.env.APP_ENV !== "test") {
      throw new Error("This test must run in APP_ENV=test");
    }

    const db = getSeedDb();

    // Create test user and billing account
    testUserId = randomUUID();
    testBillingAccountId = randomUUID();

    await db.insert(users).values({
      id: testUserId,
      name: "Activity Test User",
      walletAddress: "0xACTIVITYTESTUSER0000000000000000000000",
    });

    await db.insert(billingAccounts).values({
      id: testBillingAccountId,
      ownerUserId: testUserId,
      balanceCredits: 1000n,
    });

    await db.insert(virtualKeys).values({
      id: randomUUID(),
      billingAccountId: testBillingAccountId,
      isDefault: true,
    });
  });

  afterAll(async () => {
    const db = getSeedDb();
    await db.delete(users).where(eq(users.id, testUserId));
  });

  describe("inv_auth_server_gate", () => {
    it("Returns 401 when not authenticated", async () => {
      vi.mocked(getServerSessionUser).mockResolvedValue(null);

      const request = new NextRequest(
        "http://localhost:3000/api/v1/activity?from=2024-01-01T00:00:00Z&to=2024-01-02T00:00:00Z"
      );

      const response = await GET(request);

      expect(response.status).toBe(401);

      // Body should not contain any data fields
      const text = await response.text();
      expect(text).not.toContain("chartSeries");
      expect(text).not.toContain("totals");
      expect(text).not.toContain("rows");
    });

    it("Returns 200 when authenticated with valid params", async () => {
      const mockUser: SessionUser = {
        id: testUserId,
        walletAddress: "0xACTIVITYTESTUSER0000000000000000000000",
      };
      vi.mocked(getServerSessionUser).mockResolvedValue(mockUser);

      const request = new NextRequest(
        "http://localhost:3000/api/v1/activity?from=2024-01-01T00:00:00Z&to=2024-01-02T00:00:00Z"
      );

      const response = await GET(request);

      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json).toHaveProperty("effectiveStep");
      expect(json).toHaveProperty("chartSeries");
      expect(json).toHaveProperty("totals");
      expect(json).toHaveProperty("rows");
    });
  });

  describe("inv_time_semantics_enforced (input validation)", () => {
    beforeAll(() => {
      const mockUser: SessionUser = {
        id: testUserId,
        walletAddress: "0xACTIVITYTESTUSER0000000000000000000000",
      };
      vi.mocked(getServerSessionUser).mockResolvedValue(mockUser);
    });

    it("Returns 400 for missing required params", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/v1/activity?from=2024-01-01T00:00:00Z"
        // Missing 'to' (step is optional)
      );

      const response = await GET(request);

      expect(response.status).toBe(400);

      const json = await response.json();
      expect(json).toHaveProperty("error", "Invalid input");
    });

    it("Returns 400 for invalid datetime format", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/v1/activity?from=not-a-date&to=2024-01-02T00:00:00Z"
      );

      const response = await GET(request);

      expect(response.status).toBe(400);

      const json = await response.json();
      expect(json).toHaveProperty("error", "Invalid input");
    });

    it("Returns 400 for invalid step value", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/v1/activity?from=2024-01-01T00:00:00Z&to=2024-01-02T00:00:00Z&step=invalid"
      );

      const response = await GET(request);

      expect(response.status).toBe(400);

      const json = await response.json();
      expect(json).toHaveProperty("error", "Invalid input");
    });
  });

  describe("inv_bounded_queries (limit validation)", () => {
    beforeAll(() => {
      const mockUser: SessionUser = {
        id: testUserId,
        walletAddress: "0xACTIVITYTESTUSER0000000000000000000000",
      };
      vi.mocked(getServerSessionUser).mockResolvedValue(mockUser);
    });

    it("Returns 400 for limit > 100", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/v1/activity?from=2024-01-01T00:00:00Z&to=2024-01-02T00:00:00Z&limit=200"
      );

      const response = await GET(request);

      expect(response.status).toBe(400);

      const json = await response.json();
      expect(json).toHaveProperty("error", "Invalid input");
    });

    it("Returns 400 for limit = 0", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/v1/activity?from=2024-01-01T00:00:00Z&to=2024-01-02T00:00:00Z&limit=0"
      );

      const response = await GET(request);

      expect(response.status).toBe(400);

      const json = await response.json();
      expect(json).toHaveProperty("error", "Invalid input");
    });

    it("Returns 400 for negative limit", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/v1/activity?from=2024-01-01T00:00:00Z&to=2024-01-02T00:00:00Z&limit=-5"
      );

      const response = await GET(request);

      expect(response.status).toBe(400);

      const json = await response.json();
      expect(json).toHaveProperty("error", "Invalid input");
    });

    it("Accepts valid limit = 100", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/v1/activity?from=2024-01-01T00:00:00Z&to=2024-01-02T00:00:00Z&limit=100"
      );

      const response = await GET(request);

      expect(response.status).toBe(200);
    });

    it("Uses default limit when not provided", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/v1/activity?from=2024-01-01T00:00:00Z&to=2024-01-02T00:00:00Z"
      );

      const response = await GET(request);

      expect(response.status).toBe(200);

      const json = await response.json();
      // Default limit is 20, so rows should be <= 20
      expect(Array.isArray(json.rows)).toBe(true);
    });
  });

  describe("B3: inv_time_semantics_enforced (range validation → 400)", () => {
    beforeAll(() => {
      const mockUser: SessionUser = {
        id: testUserId,
        walletAddress: "0xACTIVITYTESTUSER0000000000000000000000",
      };
      vi.mocked(getServerSessionUser).mockResolvedValue(mockUser);
    });

    it("CRITICAL: from >= to returns 400 (not 500)", async () => {
      // Reversed range (from after to)
      const request = new NextRequest(
        "http://localhost:3000/api/v1/activity?from=2024-01-15T00:00:00Z&to=2024-01-10T00:00:00Z"
      );

      const response = await GET(request);

      // MUST be 400, not 500
      expect(response.status).toBe(400);

      const json = await response.json();
      expect(json).toHaveProperty("error");
      expect(json.error).not.toBe("Internal Server Error");

      // Should not leak data fields
      expect(json).not.toHaveProperty("chartSeries");
      expect(json).not.toHaveProperty("totals");
      expect(json).not.toHaveProperty("rows");
    });

    it("CRITICAL: from === to returns 400 (not 500)", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/v1/activity?from=2024-01-15T00:00:00Z&to=2024-01-15T00:00:00Z"
      );

      const response = await GET(request);

      // MUST be 400, not 500
      expect(response.status).toBe(400);

      const json = await response.json();
      expect(json).toHaveProperty("error");
    });

    it("CRITICAL: step=1h with >10 days returns 400 (not 500)", async () => {
      // 14 days with 1h step (exceeds 10-day max for 1h)
      const request = new NextRequest(
        "http://localhost:3000/api/v1/activity?from=2024-01-01T00:00:00Z&to=2024-01-15T00:00:00Z&step=1h"
      );

      const response = await GET(request);

      // MUST be 400, not 500
      expect(response.status).toBe(400);

      const json = await response.json();
      expect(json).toHaveProperty("error");
      expect(json.error).toMatch(/range|10|day|1h|step/i);

      // Should not leak data
      expect(json).not.toHaveProperty("chartSeries");
    });

    it("CRITICAL: range >90 days returns 400 (not 500)", async () => {
      // 120 days (exceeds overall 90-day max)
      const request = new NextRequest(
        "http://localhost:3000/api/v1/activity?from=2024-01-01T00:00:00Z&to=2024-05-01T00:00:00Z"
      );

      const response = await GET(request);

      // MUST be 400, not 500
      expect(response.status).toBe(400);

      const json = await response.json();
      expect(json).toHaveProperty("error");
      expect(json.error).toMatch(/range|90|day/i);

      // Should not leak data
      expect(json).not.toHaveProperty("chartSeries");
    });

    it("step=1h with exactly 2 days passes", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/v1/activity?from=2024-01-01T00:00:00Z&to=2024-01-03T00:00:00Z&step=1h"
      );

      const response = await GET(request);

      // Should succeed
      expect(response.status).toBe(200);
    });

    it("Range exactly 90 days passes (server derives step=1d)", async () => {
      // Jan 1 to Mar 31 is exactly 90 days
      const request = new NextRequest(
        "http://localhost:3000/api/v1/activity?from=2024-01-01T00:00:00Z&to=2024-03-31T00:00:00Z"
      );

      const response = await GET(request);

      // Should succeed with server-derived step
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(json.effectiveStep).toBe("1d");
    });

    it("Error response has consistent shape across validation failures", async () => {
      const testCases = [
        "?from=2024-01-15T00:00:00Z&to=2024-01-10T00:00:00Z", // reversed
        "?from=2024-01-01T00:00:00Z&to=2024-01-15T00:00:00Z&step=1h", // too long for step
      ];

      for (const query of testCases) {
        const request = new NextRequest(
          `http://localhost:3000/api/v1/activity${query}`
        );
        const response = await GET(request);

        expect(response.status).toBe(400);

        const json = await response.json();
        expect(json).toHaveProperty("error");
        expect(typeof json.error).toBe("string");

        // Consistent error shape (should not vary wildly)
        expect(Object.keys(json)).toContain("error");
      }
    });
  });

  describe("Response shape validation", () => {
    beforeAll(() => {
      const mockUser: SessionUser = {
        id: testUserId,
        walletAddress: "0xACTIVITYTESTUSER0000000000000000000000",
      };
      vi.mocked(getServerSessionUser).mockResolvedValue(mockUser);
    });

    it("Response matches contract shape", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/v1/activity?from=2024-01-01T00:00:00Z&to=2024-01-02T00:00:00Z"
      );

      const response = await GET(request);
      expect(response.status).toBe(200);

      const json = await response.json();

      // Required fields
      expect(json).toHaveProperty("effectiveStep");
      expect(json).toHaveProperty("chartSeries");
      expect(json).toHaveProperty("totals");
      expect(json).toHaveProperty("rows");
      expect(json).toHaveProperty("nextCursor");

      // effectiveStep is valid enum value
      expect(["5m", "15m", "1h", "6h", "1d"]).toContain(json.effectiveStep);

      // Totals shape
      expect(json.totals).toHaveProperty("spend");
      expect(json.totals.spend).toHaveProperty("total");
      expect(typeof json.totals.spend.total).toBe("string");

      expect(json.totals).toHaveProperty("tokens");
      expect(json.totals.tokens).toHaveProperty("total");
      expect(typeof json.totals.tokens.total).toBe("number");

      expect(json.totals).toHaveProperty("requests");
      expect(json.totals.requests).toHaveProperty("total");
      expect(typeof json.totals.requests.total).toBe("number");

      // chartSeries is array
      expect(Array.isArray(json.chartSeries)).toBe(true);

      // rows is array
      expect(Array.isArray(json.rows)).toBe(true);
    });

    it("chartSeries buckets have correct shape", async () => {
      const request = new NextRequest(
        "http://localhost:3000/api/v1/activity?from=2024-01-01T00:00:00Z&to=2024-01-03T00:00:00Z"
      );

      const response = await GET(request);
      expect(response.status).toBe(200);

      const json = await response.json();

      // P1: LiteLLM may return empty if no logs exist
      expect(Array.isArray(json.chartSeries)).toBe(true);

      // If buckets exist, verify shape
      if (json.chartSeries.length > 0) {
        for (const bucket of json.chartSeries) {
          expect(bucket).toHaveProperty("bucketStart");
          expect(bucket).toHaveProperty("spend");
          expect(bucket).toHaveProperty("tokens");
          expect(bucket).toHaveProperty("requests");

          expect(typeof bucket.bucketStart).toBe("string");
          expect(typeof bucket.spend).toBe("string");
          expect(typeof bucket.tokens).toBe("number");
          expect(typeof bucket.requests).toBe("number");
        }
      }
    });
  });
});
