// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/deploy`
 * Purpose: Composition seam for the read-only `DeployCapability` (the SEE flow). Wires the v0
 *   probe-backed adapter (public `serving` probe) behind the `DeployCapability` interface so the app
 *   layer never imports the adapter directly (no-restricted-imports) and the richer Argo/k8s adapter
 *   can swap in later with zero call-site change.
 * Scope: Wiring only — derive the root base domain from env, construct `ProbeDeployAdapter` with the
 *   public-surface prober. No business logic.
 * Invariants:
 *   - CAPABILITY_INJECTION: built at bootstrap; deps (prober, config) injected, no env read in the adapter.
 *   - GRACEFUL_UNWIRED: returns `undefined` when no base domain is configured (caller maps to 503),
 *     mirroring the metrics/observability capabilities.
 *   - CACHE_IS_CONTAINER_SINGLETON: `getDeployState` is wrapped in a per-cell short-TTL single-flight
 *     cache built ONCE here and shared via the singleton container, so the Fleet dashboard + the
 *     node-page SEE flow (#1773) + the AI deploy tool collapse to ≤1 probe per `(env,node)` cell per
 *     TTL window globally — N viewers × tabs × refetch can no longer storm node hosts.
 * Side-effects: none (factory only)
 * Links: src/adapters/server/deploy/probe-deploy.adapter.ts, src/bootstrap/node-flight.factory.ts,
 *   src/shared/cache/ttl-single-flight.ts, src/bootstrap/capabilities/node-registry.ts (same pattern),
 *   src/features/nodes/flight-status.ts (rootDomain), docs/design/operator-managed-deployments.md § SEE
 * @internal
 */

import type {
  DeployCapability,
  EnvSummary,
  NodeDeployState,
} from "@cogni/ai-tools";

import { ProbeDeployAdapter } from "@/adapters/server";
import {
  type TtlSingleFlight,
  ttlSingleFlight,
} from "@/shared/cache/ttl-single-flight";
import type { ServerEnv } from "@/shared/env";
import { rootDomain } from "@/shared/node-registry/deploy-hosts";
import { baseDomain } from "@/shared/node-registry/resolve";

import { createNodeProber } from "../node-flight.factory";

/** The primary node serves the env apex (test./preview./bare) rather than a slugged host. */
const PRIMARY_SLUG = "operator";

/**
 * Default deploy-state freshness. 30s keeps the SEE/Fleet surfaces near-live while bounding each
 * `(env,node)` cell to ≤1 `/readyz`+`/version` probe per 30s globally, regardless of viewer count.
 */
const DEFAULT_DEPLOY_TTL_MS = 30_000;

/**
 * Wrap a `DeployCapability` so each `(env,node)` cell's `getDeployState` is served from its own
 * short-TTL, single-flight cache. State is per-cell (one node can be live in 3 envs with distinct
 * shas/health), so the cache is keyed `env::node`: concurrent/repeat callers for the same cell within
 * the TTL share ONE in-flight probe and the last-good state. `listEnvironments` is a cheap static
 * rollup (no per-call network storm), so it passes straight through.
 */
function withCachedDeployState(
  inner: DeployCapability,
  ttlMs: number
): DeployCapability {
  const perCell = new Map<string, TtlSingleFlight<NodeDeployState>>();
  return {
    listEnvironments: (): Promise<readonly EnvSummary[]> =>
      inner.listEnvironments(),
    getDeployState: (params: {
      env: string;
      node: string;
    }): Promise<NodeDeployState> => {
      const key = `${params.env}::${params.node}`;
      let cache = perCell.get(key);
      if (!cache) {
        cache = ttlSingleFlight<NodeDeployState>({
          ttlMs,
          compute: () => inner.getDeployState(params),
        });
        perCell.set(key, cache);
      }
      return cache.get();
    },
  };
}

/**
 * Build the read-only `DeployCapability` for this env. v0 = probe-backed: it reuses the validated
 * public `serving` probe to answer "which envs is this node live in?". Returns `undefined` when the
 * operator has no base domain configured (DOMAIN/APP_BASE_URL unset) so the caller can 503 cleanly.
 * The probe adapter is wrapped in a per-cell single-flight cache so it cannot be stormed.
 */
export function createDeployCapability(
  env: ServerEnv,
  ttlMs: number = DEFAULT_DEPLOY_TTL_MS
): DeployCapability | undefined {
  const apex = baseDomain(env);
  if (!apex) return undefined;
  const probe = new ProbeDeployAdapter(createNodeProber(), {
    baseDomain: rootDomain(apex),
    primarySlug: PRIMARY_SLUG,
  });
  return withCachedDeployState(probe, ttlMs);
}
