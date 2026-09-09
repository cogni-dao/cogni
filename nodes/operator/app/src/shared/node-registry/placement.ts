// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-registry/placement`
 * Purpose: PLACEMENT_DECIDES_THE_ADDRESS — one pure mapping from a node's DECLARED deployment
 *   provider to the base URL the operator dials for that node's app. The operator is
 *   cluster-resident, so it can only use in-cluster Service DNS for a node that is also in the
 *   cluster; a node placed on decentralized compute has no `<slug>-node-app` Service and must be
 *   dialed at the public host it actually serves (bug.5106, story.5016).
 * Scope: Address math only. No I/O, no env read, no DB — callers supply the resolved placement,
 *   this environment's deploy env, and the operator's own apex domain.
 * Invariants:
 *   - K3S_IS_DEFAULT: an absent per-env declaration keeps the existing in-cluster lane, byte-for-byte
 *     the same default as `resolveNodeDeploymentProvider()` and `deployment_provider_for_target()`
 *     (scripts/ci/lib/image-tags.sh). Adding a node never requires a placement edit.
 *   - PLACEMENT_IS_NOT_A_SECOND_LIST: there is no "the akash nodes" enumeration anywhere in operator
 *     code. Placement is DECLARED DATA (`infra/catalog/<slug>.yaml` `deployment_provider.<env>`,
 *     projected into the node registry), never a node name in a branch.
 *   - EXTERNAL_ADDRESS_IS_THE_PUBLIC_HOST: an off-cluster node is reached at the SAME host its
 *     ComputeWorkload publishes — `hostForEnv` over the env's ROOT domain — so there is one host
 *     convention for DNS, the workload's ingress, liveness probes, and this resolution.
 *   - FAIL_LOUD_WITHOUT_A_DOMAIN: an off-cluster node with no resolvable base domain throws. Falling
 *     back to in-cluster DNS would silently reproduce the ENOTFOUND this module exists to remove.
 * Side-effects: none (pure)
 * Links: src/shared/node-registry/deploy-hosts.ts (hostForEnv/rootDomain), src/shared/node-registry/resolve.ts
 *   (internalNodeAppUrl), src/features/compute/node-deployment-provider.ts (the catalog policy twin),
 *   scripts/ci/lib/image-tags.sh (node_app_url_for_target — the CI twin), bug.5106, bug.5094
 * @public
 */

import { type FlightEnv, hostForEnv, rootDomain } from "./deploy-hosts";
import { internalNodeAppUrl } from "./resolve";

/** Where a node's app workload runs. Mirrors `infra/catalog/_schema.json` `deployment_provider`. */
export const NODE_DEPLOYMENT_PROVIDERS = ["k3s", "akash"] as const;

/** One placement value. Structurally identical to `@features/compute` `NodeDeploymentProvider`. */
export type NodeDeploymentProvider = (typeof NODE_DEPLOYMENT_PROVIDERS)[number];

/**
 * One node's declared per-environment placement, as projected from its catalog row. Partial by
 * construction: an omitted environment is `k3s` (K3S_IS_DEFAULT), never "unknown".
 */
export type NodeDeploymentPlacement = Readonly<
  Partial<Record<FlightEnv, NodeDeploymentProvider | undefined>>
>;

/** Guard for the provider union — use instead of re-deriving a local literal list. */
export function isNodeDeploymentProvider(
  value: unknown
): value is NodeDeploymentProvider {
  return (
    typeof value === "string" &&
    (NODE_DEPLOYMENT_PROVIDERS as readonly string[]).includes(value)
  );
}

/**
 * Narrow an untrusted projection (a jsonb column, a parsed catalog row) to a placement map,
 * dropping keys/values that are not part of the declared vocabulary. A malformed entry degrades
 * to K3S_IS_DEFAULT for that env rather than poisoning the whole map.
 */
export function toNodeDeploymentPlacement(
  value: unknown
): NodeDeploymentPlacement {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const placement: Partial<
    Record<FlightEnv, NodeDeploymentProvider | undefined>
  > = {};
  for (const [env, provider] of Object.entries(value)) {
    if (isFlightEnvKey(env) && isNodeDeploymentProvider(provider)) {
      placement[env] = provider;
    }
  }
  return placement;
}

function isFlightEnvKey(value: string): value is FlightEnv {
  return (
    value === "candidate-a" || value === "preview" || value === "production"
  );
}

/** Resolve one environment's provider. An absent declaration is deliberately the existing k3s lane. */
export function providerForEnv(
  placement: NodeDeploymentPlacement | null | undefined,
  environment: FlightEnv
): NodeDeploymentProvider {
  return placement?.[environment] ?? "k3s";
}

export interface NodeAppBaseUrlInput {
  readonly slug: string;
  readonly provider: NodeDeploymentProvider;
  /** The environment doing the dialing — the operator's OWN deploy env. */
  readonly environment: FlightEnv;
  /**
   * The apex this operator serves (`test.cognidao.org` / `preview.cognidao.org` / `cognidao.org`).
   * Only off-cluster placement needs it; `rootDomain` strips the env prefix so the per-env host
   * convention is applied exactly once.
   */
  readonly apexDomain?: string | undefined;
}

/**
 * The base URL the operator must dial to reach one node's app. Placement decides it:
 *   k3s   → the in-cluster Service DNS convention (`http://<slug>-node-app:3000`), unchanged.
 *   akash → `https://<the node's public host for this env>` — the node left the cluster, so the
 *           only address that exists is the one its workload publishes.
 * A foreign node is never the environment's primary (the operator itself serves the apex and always
 * reads its own ledger locally), so the non-primary host convention applies.
 */
export function nodeAppBaseUrl(input: NodeAppBaseUrlInput): string {
  if (input.provider === "k3s") return internalNodeAppUrl(input.slug);

  const apex = input.apexDomain?.trim();
  if (!apex) {
    throw new Error(
      `[placement] node '${input.slug}' is deployment_provider=${input.provider} in '${input.environment}' but no base domain is configured (DOMAIN / APP_BASE_URL) to resolve its public address`
    );
  }
  return `https://${hostForEnv(input.slug, false, input.environment, rootDomain(apex))}`;
}
