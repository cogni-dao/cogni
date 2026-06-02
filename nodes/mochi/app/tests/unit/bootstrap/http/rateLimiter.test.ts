// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/http/rateLimiter`
 * Purpose: Unit tests for token bucket rate limiter behavior contracts.
 * Scope: Tests rate limit enforcement, refill after window, key isolation, IP extraction. Does NOT test token bucket math internals or singleton wiring.
 * Invariants: N requests allowed then block; refill after window; keys isolated; X-Real-IP preferred over X-Forwarded-For.
 * Side-effects: none (isolated test instances with fake timers)
 * Notes: Uses per-test limiter instances for determinism; stack test validates actual endpoint wiring.
 *        Tests verify X-Real-IP precedence to prevent spoofing.
 * Links: src/bootstrap/http/rateLimiter.ts, infra/compose/edge/configs/Caddyfile.tmpl
 * @public
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  extractClientIp,
  TokenBucketRateLimiter,
} from "@/bootstrap/http/rateLimiter";

describe("TokenBucketRateLimiter", () => {
  let limiter: TokenBucketRateLimiter;

  beforeEach(() => {
    limiter = new TokenBucketRateLimiter({
      maxTokens: 10,
      refillRate: 10 / 60, // 10 tokens per 60 seconds
      burstSize: 5,
    });
  });

  describe("Rate limit enforcement", () => {
    it("should allow N+burst requests then block for new client", () => {
      const key = "test-ip-1";

      // New client starts with 15 tokens (10 base + 5 burst)
      for (let i = 0; i < 15; i++) {
        expect(limiter.consume(key)).toBe(true);
      }

      // 16th request should be blocked
      expect(limiter.consume(key)).toBe(false);
    });

    it("should allow requests again after advancing time by window", () => {
      vi.useFakeTimers();
      const key = "test-ip-2";

      // Exhaust bucket (15 tokens)
      for (let i = 0; i < 15; i++) {
        limiter.consume(key);
      }

      // Should be blocked
      expect(limiter.consume(key)).toBe(false);

      // Advance time by 60 seconds (refills 10 tokens)
      vi.advanceTimersByTime(60_000);

      // Should allow 10 more requests (refill rate, not burst)
      for (let i = 0; i < 10; i++) {
        expect(limiter.consume(key)).toBe(true);
      }

      // 11th should fail (only refilled base amount, not burst)
      expect(limiter.consume(key)).toBe(false);

      vi.useRealTimers();
    });

    it("should isolate keys (exhausting A does not affect B)", () => {
      const keyA = "192.168.1.1";
      const keyB = "192.168.1.2";

      // Exhaust keyA (15 tokens)
      for (let i = 0; i < 15; i++) {
        limiter.consume(keyA);
      }

      // keyA should be blocked
      expect(limiter.consume(keyA)).toBe(false);

      // keyB should still have full allowance (15 tokens)
      expect(limiter.consume(keyB)).toBe(true);
    });

    it("should provide immediate burst capacity for new clients", () => {
      const key = "burst-test-ip";

      // New client should be able to make 15 rapid requests (10 base + 5 burst)
      const results: boolean[] = [];
      for (let i = 0; i < 16; i++) {
        results.push(limiter.consume(key));
      }

      // First 15 should succeed
      expect(results.slice(0, 15).every((r) => r === true)).toBe(true);
      // 16th should fail
      expect(results[15]).toBe(false);
    });
  });

  describe("extractClientIp", () => {
    it("should prefer X-Real-IP over X-Forwarded-For", () => {
      const req = new NextRequest("http://localhost:3000/test", {
        headers: {
          "x-real-ip": "203.0.113.1",
          "x-forwarded-for": "198.51.100.1, 192.0.2.1",
        },
      });

      expect(extractClientIp(req)).toBe("203.0.113.1");
    });

    it("should use X-Real-IP when only X-Real-IP present", () => {
      const req = new NextRequest("http://localhost:3000/test", {
        headers: { "x-real-ip": "203.0.113.1" },
      });

      expect(extractClientIp(req)).toBe("203.0.113.1");
    });

    it("should trim whitespace from X-Real-IP", () => {
      const req = new NextRequest("http://localhost:3000/test", {
        headers: { "x-real-ip": "  203.0.113.1  " },
      });

      expect(extractClientIp(req)).toBe("203.0.113.1");
    });

    it("should fallback to X-Forwarded-For when X-Real-IP missing", () => {
      const req = new NextRequest("http://localhost:3000/test", {
        headers: { "x-forwarded-for": "203.0.113.1, 198.51.100.1" },
      });

      expect(extractClientIp(req)).toBe("203.0.113.1");
    });

    it("should return 'unknown' when both headers missing", () => {
      const req = new NextRequest("http://localhost:3000/test");
      expect(extractClientIp(req)).toBe("unknown");
    });

    it("should integrate with rate limiter", () => {
      const req = new NextRequest("http://localhost:3000/test", {
        headers: { "x-real-ip": "203.0.113.50" },
      });

      const ip = extractClientIp(req);
      const limiter = new TokenBucketRateLimiter({
        maxTokens: 2,
        refillRate: 1,
        burstSize: 0,
      });

      expect(limiter.consume(ip)).toBe(true);
      expect(limiter.consume(ip)).toBe(true);
      expect(limiter.consume(ip)).toBe(false);
    });
  });
});
