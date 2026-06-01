// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/http/wrapPublicRoute`
 * Purpose: Unit tests for public route wrapper factory, especially rate limit bypass behavior.
 * Scope: Tests bypass enabled/disabled behavior, header matching. Does NOT test full HTTP flow (see stack tests).
 * Invariants: Bypass only works when config.enabled=true AND header matches; limiter consulted otherwise.
 * Side-effects: none (isolated test instances)
 * Notes: Uses makeWrapPublicRoute factory for testability; validates production safety.
 * Links: src/bootstrap/http/wrapPublicRoute.ts, tests/stack/public/analytics-rate-limit.stack.test.ts
 * @public
 */

import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TokenBucketRateLimiter } from "@/bootstrap/http/rateLimiter";
import {
  makeWrapPublicRoute,
  type WrapPublicRouteDeps,
} from "@/bootstrap/http/wrapPublicRoute";

// Mock container to avoid env validation issues
vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(() => ({
    log: {
      child: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      })),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    config: {
      unhandledErrorPolicy: "rethrow",
    },
  })),
}));

vi.mock("@/shared/observability", async (importOriginal) => {
  // Mock observability - no serverEnv mock needed since DEPLOY_ENVIRONMENT is injected via deps
  const actual =
    await importOriginal<typeof import("@/shared/observability")>();
  return {
    ...actual,
    logRequestWarn: vi.fn(),
    publicRateLimitExceededTotal: { inc: vi.fn() },
    makeRequestContext: vi.fn(() => ({
      reqId: "test-req-id",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })),
  };
});

describe("makeWrapPublicRoute - Rate Limit Bypass", () => {
  let limiter: TokenBucketRateLimiter;
  let consumeSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    limiter = new TokenBucketRateLimiter({
      maxTokens: 10,
      refillRate: 10 / 60,
      burstSize: 5,
    });
    consumeSpy = vi.spyOn(limiter, "consume");
  });

  const createTestHandler = () =>
    vi.fn(async () => NextResponse.json({ ok: true }));

  const createRequest = (headers: Record<string, string> = {}) =>
    new NextRequest("http://localhost:3000/api/v1/public/test", { headers });

  describe("bypass enabled (APP_ENV=test)", () => {
    it("should skip limiter when bypass header present and enabled", async () => {
      const deps: WrapPublicRouteDeps = {
        rateLimitBypass: {
          enabled: true,
          headerName: "x-stack-test",
          headerValue: "1",
        },
        rateLimiter: limiter,
        DEPLOY_ENVIRONMENT: "test",
      };

      const wrapPublicRoute = makeWrapPublicRoute(deps);
      const handler = createTestHandler();
      const wrappedHandler = wrapPublicRoute(
        { routeId: "test.route" },
        handler
      );

      const request = createRequest({ "x-stack-test": "1" });
      const response = await wrappedHandler(request);

      expect(response.status).toBe(200);
      expect(consumeSpy).not.toHaveBeenCalled();
    });

    it("should consult limiter when bypass header absent", async () => {
      const deps: WrapPublicRouteDeps = {
        rateLimitBypass: {
          enabled: true,
          headerName: "x-stack-test",
          headerValue: "1",
        },
        rateLimiter: limiter,
        DEPLOY_ENVIRONMENT: "test",
      };

      const wrapPublicRoute = makeWrapPublicRoute(deps);
      const handler = createTestHandler();
      const wrappedHandler = wrapPublicRoute(
        { routeId: "test.route" },
        handler
      );

      const request = createRequest(); // No bypass header
      await wrappedHandler(request);

      expect(consumeSpy).toHaveBeenCalled();
    });

    it("should consult limiter when bypass header has wrong value", async () => {
      const deps: WrapPublicRouteDeps = {
        rateLimitBypass: {
          enabled: true,
          headerName: "x-stack-test",
          headerValue: "1",
        },
        rateLimiter: limiter,
        DEPLOY_ENVIRONMENT: "test",
      };

      const wrapPublicRoute = makeWrapPublicRoute(deps);
      const handler = createTestHandler();
      const wrappedHandler = wrapPublicRoute(
        { routeId: "test.route" },
        handler
      );

      const request = createRequest({ "x-stack-test": "wrong" });
      await wrappedHandler(request);

      expect(consumeSpy).toHaveBeenCalled();
    });
  });

  describe("bypass disabled (APP_ENV=production)", () => {
    it("should consult limiter even when bypass header present", async () => {
      const deps: WrapPublicRouteDeps = {
        rateLimitBypass: {
          enabled: false, // Production - bypass disabled
          headerName: "x-stack-test",
          headerValue: "1",
        },
        rateLimiter: limiter,
        DEPLOY_ENVIRONMENT: "production",
      };

      const wrapPublicRoute = makeWrapPublicRoute(deps);
      const handler = createTestHandler();
      const wrappedHandler = wrapPublicRoute(
        { routeId: "test.route" },
        handler
      );

      const request = createRequest({ "x-stack-test": "1" }); // Header present but ignored
      await wrappedHandler(request);

      expect(consumeSpy).toHaveBeenCalled();
    });

    it("should return 429 when rate limited in production mode", async () => {
      // Create limiter with 0 tokens to force rate limit
      const emptyLimiter = new TokenBucketRateLimiter({
        maxTokens: 0,
        refillRate: 0,
        burstSize: 0,
      });

      const deps: WrapPublicRouteDeps = {
        rateLimitBypass: {
          enabled: false,
          headerName: "x-stack-test",
          headerValue: "1",
        },
        rateLimiter: emptyLimiter,
        DEPLOY_ENVIRONMENT: "production",
      };

      const wrapPublicRoute = makeWrapPublicRoute(deps);
      const handler = createTestHandler();
      const wrappedHandler = wrapPublicRoute(
        { routeId: "test.route" },
        handler
      );

      const request = createRequest({ "x-stack-test": "1" }); // Header ignored in production
      const response = await wrappedHandler(request);

      expect(response.status).toBe(429);
      expect(handler).not.toHaveBeenCalled(); // Handler should not be called when rate limited
    });
  });

  describe("cache headers", () => {
    it("should apply cache headers to successful responses", async () => {
      const deps: WrapPublicRouteDeps = {
        rateLimitBypass: {
          enabled: true,
          headerName: "x-stack-test",
          headerValue: "1",
        },
        rateLimiter: limiter,
        DEPLOY_ENVIRONMENT: "test",
      };

      const wrapPublicRoute = makeWrapPublicRoute(deps);
      const handler = createTestHandler();
      const wrappedHandler = wrapPublicRoute(
        {
          routeId: "test.route",
          cacheTtlSeconds: 120,
          staleWhileRevalidateSeconds: 600,
        },
        handler
      );

      const request = createRequest({ "x-stack-test": "1" });
      const response = await wrappedHandler(request);

      expect(response.headers.get("Cache-Control")).toBe(
        "public, max-age=120, stale-while-revalidate=600"
      );
    });
  });
});
