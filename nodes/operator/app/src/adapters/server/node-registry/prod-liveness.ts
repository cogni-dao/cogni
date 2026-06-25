// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-registry/prod-liveness`
 * Purpose: The cross-node liveness + IDENTITY rollup — given a set of candidate node slugs, probe each
 *   node's public surface ONCE (env-scoped) to learn BOTH whether it serves (`/readyz`) AND its
 *   self-described identity (`/.well-known/agent.json` `identity`). This is the single truth source the
 *   homepage gallery reads: the operator holds ZERO per-node identity literals — title/tagline/thumbnail/
 *   color all come from each node's own repo-spec projection, read here. A decommissioned node reads
 *   `down` (and the gallery surfaces that honestly); a fork not yet projecting identity reads `null`
 *   identity (the gallery degrades to a titleCase monogram).
 *   Lives in the adapter layer (alongside ProbeDeployAdapter) because it does network I/O via a
 *   NodeProber port — `shared` cannot import `@/ports` and `bootstrap` cannot import `features`.
 * Scope: Pure orchestration over an injected `NodeProber` + host config. No fetch/db/env here; the
 *   prober does all network I/O. Host derivation reuses `hostForEnv(..., config.env, ...)` so there is
 *   one source of truth for the env→host convention (ENV_SCOPED_VIEW).
 * Invariants:
 *   - ONE_PROBE_PER_SLUG: serving + identity are read in a SINGLE per-slug pass against the same host, so
 *     the gallery learns liveness AND identity from one probe (not two rollups).
 *   - PROBE_IS_TRUTH: `health: "live"` iff the `serving` rung passes (`/readyz` 200). A network error /
 *     5xx / 525 edge ⇒ `down` (honest, never a guess). Identity is read independently — a `down` node may
 *     still have no identity; a `live` node with un-projected identity reads `null`.
 *   - PER_NODE_DEGRADE: one node's probe throw NEVER fails the rollup — that slug reads `{down, null}`.
 *   - CONCURRENT: all candidates are probed in parallel (the homepage waits on the slowest single probe,
 *     not the sum). The caller is expected to wrap this in a TTL cache so render never probes inline.
 *   - ENV_SCOPED: probes the operator's OWN env hosts (`config.env`), never a hardcoded `production`.
 * Side-effects: network I/O via the injected prober.
 * Links: src/ports/node-flight.port.ts (NodeProber, NodeIdentity), src/shared/node-registry/deploy-hosts.ts
 *   (hostForEnv), src/adapters/server/node-registry/live-node-registry.adapter.ts (consumer),
 *   src/shared/cache/ttl-single-flight.ts (the cache the bootstrap wraps this in)
 * @public
 */

import type { NodeIdentity, NodeProber } from "@/ports";
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

/** Per-slug liveness + self-described identity, read in one env-scoped probe. */
export interface NodeLiveness {
  /** `live` iff the node's `/readyz` passes; `down` on any non-pass / network error. */
  readonly health: "live" | "down";
  /** The node's well-known identity, or `null` when unreachable / not yet projecting identity. */
  readonly identity: NodeIdentity | null;
}

/** slug → liveness+identity snapshot. */
export type LivenessRollup = ReadonlyMap<string, NodeLiveness>;

/**
 * Probe each candidate slug's env host ONCE for BOTH liveness (`/readyz`) and self-described identity
 * (`/.well-known/agent.json`), returning a slug→snapshot map. Probes run concurrently; a thrown probe
 * degrades that slug to `{health: "down", identity: null}` (never a rollup failure). The map's key set
 * equals the deduped candidate set — the operator OWNS displaying health, so nothing is filtered here.
 */
export async function resolveNodeLiveness(
  candidateSlugs: Iterable<string>,
  deps: ProdLivenessDeps
): Promise<LivenessRollup> {
  const slugs = [...new Set(candidateSlugs)];
  const entries = await Promise.all(
    slugs.map(async (slug): Promise<[string, NodeLiveness]> => {
      const host = hostForEnv(
        slug,
        slug === deps.config.primarySlug,
        deps.config.env,
        deps.config.baseDomain
      );
      // serving + identity are independent reads against the SAME host (ONE_PROBE_PER_SLUG); each
      // degrades on its own so a node can be `live` with no identity, or `down` with none either.
      const [serving, identity] = await Promise.all([
        deps.prober.serving(host).catch(() => null),
        deps.prober.identity(host).catch(() => null),
      ]);
      return [
        slug,
        { health: serving?.status === "pass" ? "live" : "down", identity },
      ];
    })
  );
  return new Map(entries);
}
