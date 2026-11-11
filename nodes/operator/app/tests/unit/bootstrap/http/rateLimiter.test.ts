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
  extractEdgeClientIp,
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

describe("edge client key and bounded limiter (ported from node-template #333)", () => {
  const request = (headers: Record<string, string>) =>
    new NextRequest("http://localhost:3000/test", { headers });

  it("hasTokens only checks: it spends nothing and creates no bucket; consume spends", () => {
    const limiter = new TokenBucketRateLimiter({
      maxTokens: 2,
      refillRate: 0,
      burstSize: 0,
    });
    for (let i = 0; i < 10; i++) expect(limiter.hasTokens("ip")).toBe(true);
    expect(limiter.getTokens("ip")).toBe(2); // nothing spent, no bucket created
    expect(limiter.consume("ip")).toBe(true);
    expect(limiter.hasTokens("ip")).toBe(true);
    expect(limiter.consume("ip")).toBe(true);
    expect(limiter.hasTokens("ip")).toBe(false);
    expect(limiter.hasTokens("other")).toBe(true); // keys are isolated
  });

  it("maxKeys is a bounded LRU: past the cap the least-recently-seen bucket is evicted, never shared, and a client with no bucket always passes", () => {
    const limiter = new TokenBucketRateLimiter({
      maxTokens: 1,
      refillRate: 0,
      burstSize: 0,
      maxKeys: 2,
    });
    expect(limiter.consume("a")).toBe(true);
    expect(limiter.consume("b")).toBe(true);
    expect(limiter.hasTokens("a")).toBe(false);
    expect(limiter.consume("c")).toBe(true); // evicts "a", the least recently seen
    expect(limiter.hasTokens("a")).toBe(true); // evicted: no bucket, so it passes
    expect(limiter.hasTokens("b")).toBe(false); // still has its own spent bucket
    expect(limiter.hasTokens("d")).toBe(true); // a new client is never throttled by other clients' misses
  });

  it("filling the limiter past maxKeys with misses from distinct IPs does not throttle a valid key from a new IP", () => {
    const limiter = new TokenBucketRateLimiter({
      maxTokens: 1,
      refillRate: 0,
      burstSize: 0,
      maxKeys: 100,
    });
    for (let i = 0; i < 1_000; i++) limiter.consume(`198.51.100.${i}`); // each a miss that spends its own token
    expect(limiter.hasTokens("203.0.113.200")).toBe(true); // a legitimate agent's first call: admitted, and a valid key then spends nothing
    expect(limiter.getTokens("203.0.113.200")).toBe(1);
  });

  it("the key is the Cloudflare-written cf-connecting-ip; a forged x-real-ip or x-forwarded-for never changes it", () => {
    expect(
      extractEdgeClientIp(request({ "cf-connecting-ip": "203.0.113.7" }))
    ).toBe("203.0.113.7");
    expect(
      extractEdgeClientIp(
        request({
          "cf-connecting-ip": "203.0.113.7",
          "x-real-ip": "198.51.100.9",
          "x-forwarded-for": "192.0.2.1, 203.0.113.7",
        })
      )
    ).toBe("203.0.113.7");
    expect(
      extractEdgeClientIp(
        request({ "x-real-ip": "198.51.100.9", "x-forwarded-for": "192.0.2.1" })
      )
    ).toBe("unknown");
    expect(extractEdgeClientIp(request({}))).toBe("unknown");
  });

  it("a malformed or oversized cf-connecting-ip is 'unknown', so a client cannot mint a bucket key from arbitrary text", () => {
    expect(
      extractEdgeClientIp(
        request({ "cf-connecting-ip": "not an ip; drop table" })
      )
    ).toBe("unknown");
    expect(
      extractEdgeClientIp(request({ "cf-connecting-ip": "1".repeat(46) }))
    ).toBe("unknown");
    expect(
      extractEdgeClientIp(request({ "cf-connecting-ip": "2001:db8::1" }))
    ).toBe("2001:db8:0:0::/64");
  });

  it("keys an IPv6 client by its /64 prefix, so one subscriber's addresses share a bucket; IPv4 and an IPv4-mapped address key as the IPv4 address", () => {
    const key = (ip: string) =>
      extractEdgeClientIp(request({ "cf-connecting-ip": ip }));
    expect(key("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(key("2001:0db8:0001:0002:1111:2222:3333:4444")).toBe(
      "2001:db8:1:2::/64"
    );
    expect(key("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(key("2001:DB8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(key("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(key("::1")).toBe("0:0:0:0::/64");
    expect(key("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(key("203.0.113.7")).toBe("203.0.113.7");
    expect(key("1:2:3")).toBe("unknown");
    expect(key("1::2::3")).toBe("unknown");
    expect(key("12345::1")).toBe("unknown");
  });
});

describe("TokenBucketRateLimiter cleanup", () => {
  it("removes a DRAINED bucket after enough idle time (the refilled count is full), and keeps a recently seen or still-drained one", () => {
    const config = { maxTokens: 2, refillRate: 1, burstSize: 0 }; // refills 1 token/s, full in 2s
    const limiter = new TokenBucketRateLimiter(config);
    try {
      const t0 = Date.now();
      expect(limiter.consume("drained")).toBe(true);
      expect(limiter.consume("drained")).toBe(true); // stored tokens now 0: never "full" from storage alone
      limiter.sweep(t0 + 30_000); // refilled, but idle < 60s: kept
      expect(limiter.getTokens("drained")).toBe(0);
      limiter.sweep(t0 + 61_000); // idle > 60s and refilled to capacity: removed
      expect(limiter.getTokens("drained")).toBe(2); // getTokens of an unknown key reports full capacity
      expect(limiter.hasTokens("drained")).toBe(true);
    } finally {
      limiter.destroy();
    }
  });

  it("keeps an idle bucket that has not refilled to capacity (slow refill)", () => {
    const limiter = new TokenBucketRateLimiter({
      maxTokens: 10,
      refillRate: 1 / 600,
      burstSize: 0,
    });
    try {
      const t0 = Date.now();
      for (let i = 0; i < 10; i++) limiter.consume("slow");
      limiter.sweep(t0 + 120_000); // idle > 60s but only 0.2 token refilled
      expect(limiter.getTokens("slow")).toBeLessThan(1);
    } finally {
      limiter.destroy();
    }
  });
});
