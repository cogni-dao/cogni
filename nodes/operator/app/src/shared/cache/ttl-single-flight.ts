// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/cache/ttl-single-flight`
 * Purpose: A tiny, layer-neutral async memoizer — short-TTL value cache with single-flight refresh.
 *   Built for the highest-traffic public render paths where a value is expensive to compute (e.g. a
 *   cross-network prod-liveness rollup) and MUST NOT be recomputed on every request: concurrent and
 *   repeat callers within the TTL share ONE in-flight refresh and the last cached value.
 * Scope: Pure control-flow over an injected `compute` + `now` clock. No IO, no env, no domain types.
 * Invariants:
 *   - SINGLE_FLIGHT: while a refresh is in flight, concurrent callers await the SAME promise — never a
 *     thundering herd of N parallel computes.
 *   - SERVE_STALE_ON_FAILURE: if a refresh throws but a previous value exists, callers get the last-good
 *     value (the render path never breaks); the failed refresh does not poison the cache.
 *   - TTL_IS_SOFT: a value older than `ttlMs` triggers a refresh on next access (lazy, not a timer).
 *   - CLOCK_INJECTED: `now()` is injectable so tests are deterministic (no real timers).
 * Side-effects: none (the injected `compute` may do IO; this wrapper does not)
 * Links: src/features/nodes/prod-liveness.ts (primary consumer), src/shared/config/repoSpec.server.ts
 *   (the simpler memoize-forever pattern this generalizes with a TTL + single-flight)
 * @public
 */

/** A cached async value with short-TTL refresh + single-flight de-duplication. */
export interface TtlSingleFlight<T> {
  /** Return the cached value, refreshing it (single-flight) when stale or absent. */
  get(): Promise<T>;
}

export interface TtlSingleFlightOptions<T> {
  /** The expensive async producer. Called at most once per TTL window across concurrent callers. */
  readonly compute: () => Promise<T>;
  /** Soft time-to-live in ms; a value older than this refreshes on next `get()`. */
  readonly ttlMs: number;
  /** Injectable clock (ms epoch). Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Wrap an expensive async `compute` behind a short-TTL, single-flight cache.
 *
 * Behaviour:
 * - First `get()` runs `compute`; concurrent first callers await the same promise.
 * - Within `ttlMs`, `get()` returns the cached value with no recompute.
 * - After `ttlMs`, the next `get()` triggers ONE refresh; concurrent callers during that refresh
 *   share it. If the refresh throws and a prior value exists, callers get the stale value
 *   (SERVE_STALE_ON_FAILURE); if no prior value exists, the error propagates.
 */
export function ttlSingleFlight<T>(
  opts: TtlSingleFlightOptions<T>
): TtlSingleFlight<T> {
  const now = opts.now ?? Date.now;
  let cached: { value: T; storedAt: number } | null = null;
  let inFlight: Promise<T> | null = null;

  const refresh = (): Promise<T> => {
    if (inFlight) return inFlight;
    const p = opts
      .compute()
      .then((value) => {
        cached = { value, storedAt: now() };
        return value;
      })
      .catch((err) => {
        // SERVE_STALE_ON_FAILURE: a transient compute failure must not blank a cached value.
        if (cached) return cached.value;
        throw err;
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = p;
    return p;
  };

  return {
    get(): Promise<T> {
      if (cached && now() - cached.storedAt < opts.ttlMs) {
        return Promise.resolve(cached.value);
      }
      return refresh();
    },
  };
}
