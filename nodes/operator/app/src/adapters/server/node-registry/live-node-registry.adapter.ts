// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-registry/live-node-registry.adapter`
 * Purpose: The HONESTY filter for the public gallery — a NodeRegistryPort decorator that wraps an inner
 *   registry (the bundled-catalog ∪ DB projection) and returns ONLY the nodes whose PRODUCTION host is
 *   verified-live, per a CACHED prod-liveness snapshot. This is what kills the "ships a dead node" bug:
 *   a node the registry claims exists but whose prod deploy is gone (decommissioned, never promoted) is
 *   filtered out, so adding/removing a node never needs a gallery code edit.
 * Scope: Pure composition over an injected `getLiveSlugs` (the cached rollup) + the inner port. No IO of
 *   its own — the liveness probing + its TTL cache are wired at bootstrap and injected as a closure.
 * Invariants:
 *   - NEVER_PROBES_ON_RENDER: `getLiveSlugs` is the cached snapshot accessor; this adapter NEVER probes
 *     inline. The homepage (highest-traffic public page) pays at most a cache lookup.
 *   - INTERSECTION_IS_HONEST: output = inner registry ∩ live-prod slugs. Empty live set ⇒ empty gallery
 *     (honest), never a hardcoded fallback.
 *   - DEGRADE_TO_INNER: if the cached snapshot accessor itself throws (cold-cache total failure), fall
 *     back to the inner list so a transient infra blip never blanks the homepage; the next refresh heals.
 * Side-effects: none here (IO is in the injected accessor).
 * Links: src/ports/node-registry.port.ts, src/adapters/server/node-registry/prod-liveness.ts,
 *   src/shared/cache/ttl-single-flight.ts, src/bootstrap/container.ts (resolveNodeRegistry)
 * @public
 */

import type { NodeRegistryPort, NodeSummary } from "@/ports";

export interface LiveNodeRegistryDeps {
  /** The inner registry to filter (bundled catalog ∪ DB projection). */
  readonly inner: NodeRegistryPort;
  /**
   * Cached accessor: given the candidate slugs, return the subset whose PRODUCTION host is
   * verified-live. MUST be backed by a short-TTL single-flight cache — the homepage calls this on
   * every render, so it NEVER probes the network inline on the hot path.
   */
  readonly getLiveSlugs: (
    candidateSlugs: readonly string[]
  ) => Promise<ReadonlySet<string>>;
}

/** Filters an inner NodeRegistryPort down to nodes with a verified-live production deployment. */
export class LiveNodeRegistryAdapter implements NodeRegistryPort {
  constructor(private readonly deps: LiveNodeRegistryDeps) {}

  async listPublic(): Promise<readonly NodeSummary[]> {
    const all = await this.deps.inner.listPublic();
    let live: ReadonlySet<string>;
    try {
      live = await this.deps.getLiveSlugs(all.map((node) => node.slug));
    } catch {
      // DEGRADE_TO_INNER: a cold-cache rollup failure must not blank the homepage; the next TTL
      // refresh restores the honest intersection.
      return all;
    }
    return all.filter((node) => live.has(node.slug));
  }
}
