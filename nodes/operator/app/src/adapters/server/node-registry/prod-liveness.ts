// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-registry/prod-liveness`
 * Purpose: The cross-node PRODUCTION-liveness rollup — given a set of candidate node slugs, prove which
 *   ones actually serve a live production deployment by probing their public `/readyz` surface. This is
 *   the truth source the honest homepage gallery intersects the node registry against, so a node that
 *   the registry CLAIMS exists but whose prod host is dead (e.g. a decommissioned node) is excluded.
 *   Lives in the adapter layer (alongside ProbeDeployAdapter) because it does network I/O via a
 *   NodeProber port — `shared` cannot import `@/ports` and `bootstrap` cannot import `features`.
 * Scope: Pure orchestration over an injected `NodeProber` + host config. No fetch/db/env here; the
 *   prober does all network I/O. Host derivation reuses `hostForEnv(..., "production", ...)` so there is
 *   one source of truth for the env→host convention.
 * Invariants:
 *   - PROBE_IS_TRUTH: a slug is "live" iff its production `serving` rung passes (`/readyz` 200). A
 *     network error / 5xx / 525 edge ⇒ NOT live (honest exclusion, never a guess).
 *   - PER_NODE_DEGRADE: one node's probe failure NEVER fails the rollup — it just drops that slug.
 *   - CONCURRENT: all candidates are probed in parallel (the homepage waits on the slowest single probe,
 *     not the sum). The caller is expected to wrap this in a TTL cache so render never probes inline.
 *   - PRODUCTION_ONLY: this rollup is about the PUBLIC homepage gallery, which only ever shows the prod
 *     surface; candidate-a / preview liveness is the flight-status feature's concern, not this one.
 * Side-effects: network I/O via the injected prober.
 * Links: src/ports/node-flight.port.ts (NodeProber), src/shared/node-registry/deploy-hosts.ts
 *   (hostForEnv), src/adapters/server/node-registry/live-node-registry.adapter.ts (consumer),
 *   src/shared/cache/ttl-single-flight.ts (the cache the bootstrap wraps this in)
 * @public
 */

import type { NodeProber } from "@/ports";
import {
  type FlightEnv,
  hostForEnv,
} from "@/shared/node-registry/deploy-hosts";

/** Static host-derivation config — injected so this rollup never reads env. */
export interface ProdLivenessConfig {
  /** Root zone the network serves under (e.g. `cognidao.org`), env subdomains stripped. */
  readonly baseDomain: string;
  /** Slug of the PRIMARY node (operator), which serves the env apex rather than a slugged host. */
  readonly primarySlug: string;
  /**
   * The operator's OWN deploy env — probe THIS env's hosts, never a hardcoded `production`
   * (`ENV_SCOPED_VIEW`): test operator → `<slug>-test`, preview → `<slug>-preview`, prod → `<slug>`.
   */
  readonly env: FlightEnv;
}

export interface ProdLivenessDeps {
  readonly prober: NodeProber;
  readonly config: ProdLivenessConfig;
}

/**
 * Probe each candidate slug's PRODUCTION host and return the subset that is verified-live. Probes run
 * concurrently; any non-passing rung (network error, 5xx, edge 525) drops that slug. The returned set
 * is a strict subset of `candidateSlugs`.
 */
export async function resolveLiveProdSlugs(
  candidateSlugs: Iterable<string>,
  deps: ProdLivenessDeps
): Promise<ReadonlySet<string>> {
  const slugs = [...new Set(candidateSlugs)];
  const results = await Promise.all(
    slugs.map(async (slug) => {
      const host = hostForEnv(
        slug,
        slug === deps.config.primarySlug,
        deps.config.env,
        deps.config.baseDomain
      );
      try {
        const serving = await deps.prober.serving(host);
        return serving.status === "pass" ? slug : null;
      } catch {
        // PER_NODE_DEGRADE: a thrown probe is an exclusion, never a rollup failure.
        return null;
      }
    })
  );
  return new Set(results.filter((s): s is string => s !== null));
}
