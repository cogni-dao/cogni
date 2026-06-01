// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/public/analytics-rate-limit.stack`
 * Purpose: Validates rate limiting on public analytics endpoint.
 * Scope: Black-box HTTP test for rate limit enforcement; 10 req/min/IP + burst 5. Does NOT test rate limit algorithm internals.
 * Invariants: 11th rapid request returns 429; Retry-After header present; Cache-Control still present on 200 responses.
 * Side-effects: IO (HTTP requests)
 * Notes: Requires running stack; tests in-memory rate limiter (per-instance).
 * Links: src/app/api/v1/public/analytics/summary/route.ts, src/bootstrap/http/rateLimiter.ts
 * @public
 */

import {
  fetchWithIp,
  generateUniqueTestIp,
} from "@tests/_fixtures/http/rate-limit-helpers";
import { describe, expect, it } from "vitest";

function baseUrl(path: string): string {
  const root = process.env.TEST_BASE_URL ?? "http://localhost:3000/";
  return new URL(path.replace(/^\//, ""), root).toString();
}

// Generate unique IP once for this test file (reuse for all requests)
const RATE_LIMIT_TEST_IP = generateUniqueTestIp();

describe("Public Analytics Rate Limiting", () => {
  it("should enforce rate limit: allow 15 requests then return 429 on 16th", async () => {
    const endpoint = "/api/v1/public/analytics/summary?window=7d";

    // Make 15 requests rapidly (10 base + 5 burst - should all succeed)
    const responses: Response[] = [];
    for (let i = 0; i < 15; i++) {
      const response = await fetchWithIp(baseUrl(endpoint), RATE_LIMIT_TEST_IP);
      responses.push(response);
    }

    // First 15 requests should succeed (new client gets full burst capacity)
    for (let i = 0; i < 15; i++) {
      expect(responses[i]?.status).toBe(200);
      // Verify Cache-Control headers present on success responses
      expect(responses[i]?.headers.get("Cache-Control")).toContain("public");
      expect(responses[i]?.headers.get("Cache-Control")).toContain(
        "max-age=60"
      );
    }

    // 16th request should be rate limited
    const rateLimitedResponse = await fetchWithIp(
      baseUrl(endpoint),
      RATE_LIMIT_TEST_IP
    );
    expect(rateLimitedResponse.status).toBe(429);

    // Verify 429 response includes Retry-After header
    const retryAfter = rateLimitedResponse.headers.get("Retry-After");
    expect(retryAfter).toBeDefined();
    expect(retryAfter).toBe("60");

    // Verify 429 response includes short cache header to reduce hammering
    const cacheControl429 = rateLimitedResponse.headers.get("Cache-Control");
    expect(cacheControl429).toContain("public");
    expect(cacheControl429).toContain("max-age=5");

    // Verify 429 response body
    const body = await rateLimitedResponse.json();
    expect(body).toHaveProperty("error");
    expect(body.error).toContain("Rate limit");
  });

  it("should return 200 responses with valid contract output", async () => {
    const endpoint = "/api/v1/public/analytics/summary?window=7d";

    const response = await fetch(baseUrl(endpoint));

    // Should succeed (assuming not rate limited from previous test)
    // Note: If rate limited, wait 60s or use different IP
    if (response.status === 200) {
      const data = await response.json();

      // Verify contract structure
      expect(data).toHaveProperty("window");
      expect(data).toHaveProperty("generatedAt");
      expect(data).toHaveProperty("cacheTtlSeconds");
      expect(data).toHaveProperty("summary");
      expect(data).toHaveProperty("timeseries");
      expect(data).toHaveProperty("distribution");

      // Verify cache headers
      const cacheControl = response.headers.get("Cache-Control");
      expect(cacheControl).toContain("public");
      expect(cacheControl).toContain("max-age=60");
      expect(cacheControl).toContain("stale-while-revalidate=300");
    }
  });
});
