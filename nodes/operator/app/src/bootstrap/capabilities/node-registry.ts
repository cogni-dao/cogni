// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/node-registry`
 * Purpose: Composition seam for the PUBLIC node-gallery prod-liveness snapshot. Builds the
 *   short-TTL, single-flight cached accessor that the `LiveNodeRegistryAdapter` intersects the
 *   registry against — so the highest-traffic public render path (the homepage) NEVER probes the
 *   network inline: it reads a shared, periodically-refreshed snapshot of "which nodes are prod-live".
 * Scope: Wiring only — derive the root base domain from env, build the prober, and memoize the
 *   `resolveLiveProdSlugs` rollup behind `ttlSingleFlight`. No business logic.
 * Invariants:
 *   - CACHE_IS_MODULE_SINGLETON: the cache is built once and shared across all requests (the
 *     `resolveNodeRegistry` accessor is per-request, so the cache CANNOT live inside it).
 *   - NEVER_PROBES_ON_RENDER: returns a `() => Promise<Set>` accessor that is at most a cache lookup
 *     on the hot path; the actual probing happens on a cold/stale cache, off the render critical path
 *     for all but the first concurrent caller.
 *   - GRACEFUL_UNWIRED: returns `undefined` when no base domain is configured (caller then skips the
 *     liveness filter entirely rather than blanking the gallery).
 * Side-effects: none (factory only; the returned accessor does network I/O via the prober).
 * Links: src/adapters/server/node-registry/prod-liveness.ts, src/shared/cache/ttl-single-flight.ts,
 *   src/adapters/server/node-registry/live-node-registry.adapter.ts, src/bootstrap/node-flight.factory.ts
 * @internal
 */

import { resolveLiveProdSlugs } from "@/adapters/server";
import { ttlSingleFlight } from "@/shared/cache/ttl-single-flight";
import type { ServerEnv } from "@/shared/env";
import { rootDomain } from "@/shared/node-registry/deploy-hosts";
import { baseDomain } from "@/shared/node-registry/resolve";

import { createNodeProber } from "../node-flight.factory";

/** The primary node serves the prod apex (bare base domain) rather than a slugged host. */
const PRIMARY_SLUG = "operator";

/** Default snapshot freshness. 60s keeps the gallery honest within a minute without hammering edges. */
const DEFAULT_TTL_MS = 60_000;

/**
 * Build the cached prod-liveness accessor for the public gallery. Returns a function that, given the
 * candidate slugs, yields the verified-live subset from a short-TTL single-flight cache. Returns
 * `undefined` when the operator has no base domain configured (DOMAIN/APP_BASE_URL unset) so the
 * caller can skip the liveness filter cleanly.
 *
 * The cache is keyed implicitly on the FULL candidate set: each call passes the current candidates and
 * the cache stores the last computed live set. Candidate sets are tiny and change rarely, so a single
 * shared snapshot is correct; on a candidate-set change the next refresh re-probes the new union.
 */
export function createLiveSlugsAccessor(
  env: ServerEnv,
  ttlMs: number = DEFAULT_TTL_MS
):
  | ((candidateSlugs: Iterable<string>) => Promise<ReadonlySet<string>>)
  | undefined {
  const apex = baseDomain(env);
  if (!apex) return undefined;

  const deps = {
    prober: createNodeProber(),
    config: { baseDomain: rootDomain(apex), primarySlug: PRIMARY_SLUG },
  };

  // The cache wraps the rollup over the LATEST candidate set seen. We capture candidates in a mutable
  // ref the `compute` closure reads, so the single-flight cache stays a module singleton while still
  // probing whatever candidate union the current request supplies.
  let latestCandidates: readonly string[] = [];
  const cache = ttlSingleFlight<ReadonlySet<string>>({
    ttlMs,
    compute: () => resolveLiveProdSlugs(latestCandidates, deps),
  });

  return (candidateSlugs: Iterable<string>) => {
    latestCandidates = [...new Set(candidateSlugs)];
    return cache.get();
  };
}
