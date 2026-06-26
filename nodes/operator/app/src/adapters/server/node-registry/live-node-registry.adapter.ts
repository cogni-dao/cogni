// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-registry/live-node-registry.adapter`
 * Purpose: The IDENTITY + HEALTH decorator for the public gallery — a NodeRegistryPort decorator that
 *   wraps an inner registry (the bundled-catalog ∪ DB projection skeleton) and ENRICHES each node with
 *   its self-described identity (title=hook, tagline=mission, thumbnail, brandColor) and liveness
 *   (live/down), read from a CACHED per-slug probe. The operator holds ZERO per-node identity literals:
 *   every gallery card's display data comes from the node's OWN well-known projection, merged here.
 *   Decision: down nodes are NOT hidden — the operator OWNS displaying health, so a decommissioned node
 *   reads `down` honestly rather than vanishing.
 * Scope: Pure composition over an injected `getLiveness` (the cached rollup) + the inner port. No IO of
 *   its own — the probing + its TTL cache are wired at bootstrap and injected as a closure.
 * Invariants:
 *   - NEVER_PROBES_ON_RENDER: `getLiveness` is the cached snapshot accessor; this adapter NEVER probes
 *     inline. The homepage (highest-traffic public page) pays at most a cache lookup.
 *   - IDENTITY_OVERWRITES_SKELETON: when a node projects identity, its hook/mission/brand REPLACE the
 *     skeleton's titleCase(slug)/empty fallbacks. A node with no identity keeps the fallbacks (clean
 *     degradation until forks project identity).
 *   - ROSTER_NOT_FILTERED: output is the full inner roster, each annotated with `health`. Nothing is
 *     dropped — honesty is shown, not hidden.
 *   - DEGRADE_TO_INNER: if the cached accessor itself throws (cold-cache total failure), fall back to the
 *     inner list unannotated so a transient infra blip never blanks the homepage; the next refresh heals.
 * Side-effects: none here (IO is in the injected accessor).
 * Links: src/ports/node-registry.port.ts, src/adapters/server/node-registry/prod-liveness.ts,
 *   src/shared/cache/ttl-single-flight.ts, src/bootstrap/container.ts (resolveNodeRegistry)
 * @public
 */

import type {
  LivenessRollup,
  NodeLiveness,
} from "@/adapters/server/node-registry/prod-liveness";
import type { NodeRegistryPort, NodeSummary } from "@/ports";

export interface LiveNodeRegistryDeps {
  /** The inner registry to enrich (bundled catalog ∪ DB projection skeleton). */
  readonly inner: NodeRegistryPort;
  /**
   * Cached accessor: given the candidate slugs, return a slug→{health, identity} snapshot. MUST be backed
   * by a short-TTL single-flight cache — the homepage calls this on every render, so it NEVER probes the
   * network inline on the hot path.
   */
  readonly getLiveness: (
    candidateSlugs: readonly string[]
  ) => Promise<LivenessRollup>;
}

/** Enriches an inner NodeRegistryPort's nodes with self-described identity + liveness from a cached probe. */
export class LiveNodeRegistryAdapter implements NodeRegistryPort {
  constructor(private readonly deps: LiveNodeRegistryDeps) {}

  async listPublic(): Promise<readonly NodeSummary[]> {
    const all = await this.deps.inner.listPublic();
    let rollup: LivenessRollup;
    try {
      rollup = await this.deps.getLiveness(all.map((node) => node.slug));
    } catch {
      // DEGRADE_TO_INNER: a cold-cache rollup failure must not blank the homepage; the next TTL refresh
      // restores identity + health. Until then the skeleton (titleCase/empty/no health) renders cleanly.
      return all;
    }
    return all.map((node) => enrich(node, rollup.get(node.slug)));
  }
}

/**
 * Merge one node's cached liveness snapshot onto its skeleton summary. Identity fields (hook→title,
 * mission→tagline, brand) OVERWRITE the skeleton only when the node actually projected them; a node with
 * no identity keeps the skeleton's titleCase(slug)/empty fallbacks. `health` is always annotated.
 */
function enrich(
  node: NodeSummary,
  snapshot: NodeLiveness | undefined
): NodeSummary {
  if (!snapshot) return node;
  const { health, identity } = snapshot;
  if (!identity) return { ...node, health };
  // Card model: title = the node NAME (skeleton's titleCase(slug) — never the hook), tagline = the
  // short HOOK (≤5 words). The MISSION is the cognition-bootstrap north-star and is deliberately NOT
  // rendered in the gallery. Conditional spreads (exactOptionalPropertyTypes) only overwrite a field
  // the node actually declared; an undeclared field keeps the skeleton fallback (titleCase title /
  // empty tagline / monogram).
  return {
    ...node,
    health,
    ...(identity.hook !== null && { tagline: identity.hook }),
    ...(identity.brand.icon !== null && { icon: identity.brand.icon }),
    ...(identity.brand.thumbnail !== null && {
      thumbnailUrl: identity.brand.thumbnail,
    }),
    ...(identity.brand.color !== null && { brandColor: identity.brand.color }),
  };
}
