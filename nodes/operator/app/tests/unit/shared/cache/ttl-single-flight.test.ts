// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: tests for `@shared/cache/ttl-single-flight`.
 * Purpose: Pin the cache contract — TTL freshness, single-flight de-dup of concurrent refreshes,
 *   serve-stale-on-failure, and error propagation on a cold-cache failure.
 * Scope: Pure logic with an injected clock + counted compute (no timers, no IO).
 * Side-effects: none
 * Links: src/shared/cache/ttl-single-flight.ts
 */

import { describe, expect, it } from "vitest";
import { ttlSingleFlight } from "@/shared/cache/ttl-single-flight";

/** A controllable clock for deterministic TTL tests. */
function fakeClock(start = 0): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

describe("ttlSingleFlight", () => {
  it("computes once, then serves cached within the TTL", async () => {
    const clock = fakeClock();
    let calls = 0;
    const cache = ttlSingleFlight({
      ttlMs: 100,
      now: clock.now,
      compute: async () => ++calls,
    });

    expect(await cache.get()).toBe(1);
    clock.advance(50);
    expect(await cache.get()).toBe(1); // still fresh
    expect(calls).toBe(1);
  });

  it("refreshes after the TTL elapses", async () => {
    const clock = fakeClock();
    let calls = 0;
    const cache = ttlSingleFlight({
      ttlMs: 100,
      now: clock.now,
      compute: async () => ++calls,
    });

    expect(await cache.get()).toBe(1);
    clock.advance(150);
    expect(await cache.get()).toBe(2);
    expect(calls).toBe(2);
  });

  it("single-flights concurrent cold callers onto ONE compute", async () => {
    const clock = fakeClock();
    let calls = 0;
    let resolve!: (v: number) => void;
    const cache = ttlSingleFlight<number>({
      ttlMs: 100,
      now: clock.now,
      compute: () => {
        calls += 1;
        return new Promise<number>((r) => {
          resolve = r;
        });
      },
    });

    const a = cache.get();
    const b = cache.get();
    const c = cache.get();
    resolve(42);
    expect(await Promise.all([a, b, c])).toEqual([42, 42, 42]);
    expect(calls).toBe(1);
  });

  it("serves the last-good value when a refresh throws", async () => {
    const clock = fakeClock();
    let calls = 0;
    const cache = ttlSingleFlight<number>({
      ttlMs: 100,
      now: clock.now,
      compute: async () => {
        calls += 1;
        if (calls === 1) return 7;
        throw new Error("transient");
      },
    });

    expect(await cache.get()).toBe(7);
    clock.advance(150);
    expect(await cache.get()).toBe(7); // stale-but-good, not a throw
  });

  it("propagates the error when the FIRST compute fails (no prior value)", async () => {
    const cache = ttlSingleFlight<number>({
      ttlMs: 100,
      compute: async () => {
        throw new Error("boom");
      },
    });
    await expect(cache.get()).rejects.toThrow("boom");
  });

  it("retries after a stale-served failure on the next refresh window", async () => {
    const clock = fakeClock();
    let calls = 0;
    const cache = ttlSingleFlight<number>({
      ttlMs: 100,
      now: clock.now,
      compute: async () => {
        calls += 1;
        if (calls === 2) throw new Error("transient");
        return calls;
      },
    });

    expect(await cache.get()).toBe(1);
    clock.advance(150);
    expect(await cache.get()).toBe(1); // call 2 throws ⇒ stale
    clock.advance(150);
    expect(await cache.get()).toBe(3); // call 3 succeeds ⇒ fresh
  });
});
