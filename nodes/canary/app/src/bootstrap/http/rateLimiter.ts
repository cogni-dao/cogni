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
}

/**
 * In-memory token bucket rate limiter.
 * Limitation: State is per-instance, not shared across horizontal replicas.
 */
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, BucketState>();
  private readonly config: RateLimiterConfig;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

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

    if (!bucket) {
      // New client - initialize with full bucket including burst capacity
      bucket = {
        tokens: this.config.maxTokens + this.config.burstSize,
        lastSeen: now,
      };
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
