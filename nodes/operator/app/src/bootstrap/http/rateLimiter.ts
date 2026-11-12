// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/http/rateLimiter`
 * Purpose: In-memory rate limiter for public API endpoints.
 * Scope: Token bucket algorithm; extracts client IP from X-Real-IP (set by Caddy from TCP source); returns 429 when limit exceeded. Does NOT persist state across instances or restarts.
 * Invariants: 10 req/min/IP + burst 5; new clients start with 15 tokens (10 base + 5 burst); cleanup stale entries every 60s;
 *             X-Real-IP set by Caddy via header_up directive (non-spoofable).
 * Side-effects: global (in-memory rate limit store with periodic cleanup)
 * Notes: Per-instance limitation - multiple app instances each have independent limits (acceptable for MVP).
 *        IP extraction prefers X-Real-IP (Caddy-set) over X-Forwarded-For (fallback).
 * Links: Applied to /api/v1/public/* routes; Caddyfile sets X-Real-IP at infra/compose/edge/configs/Caddyfile.tmpl.
 * @public
 */

import type { NextRequest } from "next/server";

interface BucketState {
  tokens: number; // Remaining tokens
  lastSeen: number; // Timestamp of last update (ms)
}

interface RateLimiterConfig {
  maxTokens: number; // Bucket capacity (e.g., 10)
  refillRate: number; // Tokens per second (e.g., 10/60 = 0.166...)
  burstSize: number; // Burst allowance beyond maxTokens (e.g., 5)
  /**
   * Cap on distinct keys (a bounded LRU). Past it, the least-recently-seen bucket is evicted to make room, so a flood of invented keys cannot grow
   * the map without bound and never makes unrelated clients share a bucket. Default: no cap.
   */
  maxKeys?: number;
  /** Optional per-instance cap on outstanding reserved work, across all keys. */
  maxConcurrent?: number;
}

/**
 * In-memory token bucket rate limiter.
 * Limitation: State is per-instance, not shared across horizontal replicas.
 */
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, BucketState>();
  private readonly config: RateLimiterConfig;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly pending = new Map<string, number>();
  private pendingCount = 0;

  constructor(config: RateLimiterConfig) {
    this.config = config;
    // Cleanup stale entries every 60s
    this.startCleanup();
  }

  /**
   * Check if request is allowed for given key (typically IP address).
   * Returns true if allowed, false if rate limit exceeded.
   */
  public consume(key: string): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (bucket) {
      // Most recently seen goes last, so the first entry is always the least recently seen.
      this.buckets.delete(key);
      this.buckets.set(key, bucket);
    }

    if (!bucket) {
      // New client - initialize with full bucket including burst capacity
      bucket = {
        tokens: this.config.maxTokens + this.config.burstSize,
        lastSeen: now,
      };
      const { maxKeys } = this.config;
      if (maxKeys !== undefined && this.buckets.size >= maxKeys) {
        const oldest = this.buckets.keys().next();
        if (!oldest.done) this.buckets.delete(oldest.value);
      }
      this.buckets.set(key, bucket);
    }

    // Refill tokens based on time elapsed
    const elapsedMs = now - bucket.lastSeen;
    const elapsedSeconds = elapsedMs / 1000;
    const tokensToAdd = elapsedSeconds * this.config.refillRate;

    bucket.tokens = Math.min(
      bucket.tokens + tokensToAdd,
      this.config.maxTokens + this.config.burstSize
    );
    bucket.lastSeen = now;

    // Consume 1 token
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * CHECK-only: would this key pass right now, excluding outstanding reservations?
   */
  public hasTokens(key: string): boolean {
    const bucket = this.buckets.get(key);
    const capacity = this.config.maxTokens + this.config.burstSize;
    const refilled = bucket
      ? Math.min(
          capacity,
          bucket.tokens +
            ((Date.now() - bucket.lastSeen) / 1000) * this.config.refillRate
        )
      : capacity;
    return refilled - (this.pending.get(key) ?? 0) >= 1;
  }

  /** Reserve before any await; release is idempotent. Only a miss consumes a token. */
  public reserve(key: string): (() => void) | null {
    if (
      this.pendingCount >=
        (this.config.maxConcurrent ?? Number.POSITIVE_INFINITY) ||
      !this.hasTokens(key)
    )
      return null;
    this.pendingCount += 1;
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingCount -= 1;
      const count = (this.pending.get(key) ?? 1) - 1;
      if (count === 0) this.pending.delete(key);
      else this.pending.set(key, count);
    };
  }

  /**
   * Start periodic cleanup of stale entries (entries with full tokens unused for >60s).
   */
  private startCleanup(): void {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const staleThresholdMs = 60_000; // 60 seconds

      for (const [key, bucket] of this.buckets.entries()) {
        const timeSinceLastSeen = now - bucket.lastSeen;
        const isFull =
          bucket.tokens >= this.config.maxTokens + this.config.burstSize;

        // Remove if bucket is full and unused for >60s
        if (isFull && timeSinceLastSeen > staleThresholdMs) {
          this.buckets.delete(key);
        }
      }
    }, 60_000); // Run every 60s

    // Prevent cleanup from keeping process alive in tests
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Stop cleanup interval (for tests).
   */
  public destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Get current token count for a key (for testing/monitoring).
   */
  public getTokens(key: string): number {
    return this.buckets.get(key)?.tokens ?? this.config.maxTokens;
  }
}

/**
 * Extract client IP from Next.js request.
 *
 * Security Model (structural, not configurable):
 * - Edge (Caddy) sets X-Real-IP from TCP connection source via header_up directive
 * - App prefers X-Real-IP (single IP, set by edge, non-spoofable by client)
 * - Fallback to X-Forwarded-For first IP (for non-Caddy environments)
 *
 * Pre-CDN (current):
 * - Caddy sets X-Real-IP from {remote_host} (direct TCP connection)
 * - Client cannot spoof this (it's the network layer, not HTTP headers)
 *
 * Post-CDN (future):
 * - REQUIRES: Configure trusted_proxies in Caddy global options with CDN IP ranges
 * - CDN must set X-Real-IP or CF-Connecting-IP to actual client IP
 * - Caddy must validate request is from trusted CDN IP before trusting headers
 * - WITHOUT trusted_proxies validation, CDN headers can be spoofed
 *
 * References:
 * - Caddyfile: infra/compose/edge/configs/Caddyfile.tmpl (header_up X-Real-IP)
 * - Unit tests: tests/unit/bootstrap/http/rateLimiter.test.ts
 */
export function extractClientIp(request: NextRequest): string {
  // Prefer X-Real-IP (set by Caddy from TCP source, non-spoofable)
  const realIp = request.headers.get("x-real-ip");
  if (realIp) return realIp.trim();

  // Fallback: X-Forwarded-For first IP (for non-Caddy environments)
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const firstIp = forwardedFor.split(",")[0]?.trim();
    if (firstIp) return firstIp;
  }

  // Last resort: group all unidentified clients together
  return "unknown";
}

/**
 * Public API rate limiter singleton.
 * Config: 10 requests per minute + burst 5.
 */
export const publicApiLimiter = new TokenBucketRateLimiter({
  maxTokens: 10,
  refillRate: 10 / 60, // 10 tokens per 60 seconds
  burstSize: 5,
});

/**
 * Client key for the credential-lookup limiter. Operator divergence from node-template (recorded, edge-driven): the operator's prod edge is its
 * own Caddy (`header_up X-Real-IP {remote_host}`, infra/compose/edge/configs/Caddyfile.tmpl), so `x-real-ip` is the trusted source here;
 * `cf-connecting-ip` is the fallback for Cloudflare-fronted lanes (candidate). Nothing else is trusted. A shape that does not parse is "unknown".
 * Residual risk is the same as node-template's: a client that reaches the origin without the edge picks its own bucket; `maxKeys` bounds only
 * memory. Valid keys spend no miss tokens, but still share bounded concurrent lookup capacity.
 */
export function extractEdgeClientIp(request: {
  headers: { get(name: string): string | null };
}): string {
  const ip = (
    request.headers.get("x-real-ip") ?? request.headers.get("cf-connecting-ip")
  )?.trim();
  if (!ip || ip.length > 45 || !/^[0-9a-fA-F:.]+$/.test(ip)) return "unknown";
  return ip.includes(":") ? ipv6Prefix64(ip) : ip;
}

/**
 * An IPv6 client is keyed by its /64 prefix (one subscriber normally holds a whole /64, so keying on the full address would hand it unlimited
 * buckets). An IPv4-mapped address (`::ffff:a.b.c.d`) is keyed as that IPv4 address. A shape that does not parse is "unknown".
 */
function ipv6Prefix64(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  const halves = ip.split("::");
  if (halves.length > 2) return "unknown";
  const side = (text: string | undefined) => (text ? text.split(":") : []);
  const head = side(halves[0]);
  const tail = side(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return "unknown";
  const groups =
    halves.length === 1
      ? head
      : [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return "unknown";
  return `${groups
    .slice(0, 4)
    .map((g) => Number.parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}

/**
 * Per-IP limit on revocable-key lookups that find nothing (task.5474 / story.5156). Every shape-valid revocable bearer costs one query on the small
 * service pool, so an unauthenticated flood of well-formed random keys could starve the other service-pool users.
 * SPEND_ON_MISS: synchronous reservation covers the async lookup; only a miss consumes a token. Success/outage refund the reservation.
 * Two outstanding bearer verifications per instance leave capacity in the four-connection service pool; excess receives 429 before lookup.
 * 300 misses/min + 100 burst per client; shape/checksum failures never reserve. Pending work also reserves miss budget, including for new keys.
 * At most 10 000 miss buckets (bounded LRU) plus two pending keys; no shared bucket or unbounded admission queue.
 */
export const credentialLookupLimiter = new TokenBucketRateLimiter({
  maxTokens: 300,
  refillRate: 300 / 60,
  burstSize: 100,
  maxKeys: 10_000,
  maxConcurrent: 2,
});
