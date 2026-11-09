// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/repo-spec/node-app-deployment`
 * Purpose: Holds the one source of truth for the `cogni-node-app-v1` deployment declaration.
 *   It is the block a node carries in its own `.cogni/repo-spec.yaml` — what the node scaffold
 *   emits, what the off-cluster-compute gates require, and what a failure message tells you to add.
 * Scope: Pure data plus YAML rendering over the repo-spec schema; does not perform I/O, select a
 *   provider, resolve secret values, or name any node.
 * Invariants:
 *   - PROFILE_IMPLIES_ITS_SECRET_CONTRACT: `cogni-node-app-v1` is a named runtime profile, so the
 *     logical secret keys it needs to boot are IMPLIED BY THE PROFILE, not re-listed per node. The
 *     operator supplies them from `COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS` at workload-build time
 *     (`resolveRuntimeProfileSecretRefs`); a node declares any key BEYOND the profile once, in its
 *     `.cogni/secrets-catalog.yaml` with `workloads` (bug.5254). The repo-spec carries no secret list.
 *     This kills the stale-spec class (bug.5175): a node spec authored before a key was added to the
 *     profile still flights, because the profile — not the git file — is the source of truth.
 *     Scoped by capability (the profile), never by node name.
 *   - SCAFFOLD_AND_RESOLVER_SHARE_ONE_VALUE: the resolver that fills the profile keys at build time
 *     reads the same constant the scaffold and the value-presence gate read, so a stock node and its
 *     deployed workload cannot drift.
 *   - RENDER_ROUND_TRIPS: `renderNodeDeploymentYaml` output re-parses to the same declaration.
 * Side-effects: none
 * Links: packages/repo-spec/src/schema.ts, task.5079, story.5016, bug.5175
 * @public
 */

import { stringify } from "yaml";

import type {
  NodeDeploymentSpec,
  NodeServiceRuntimeProfileSpec,
  NodeServiceSpec,
} from "./schema.js";

/**
 * Logical secret keys the `cogni-node-app-v1` runtime profile requires to boot.
 *
 * This is a CAPABILITY contract, not a node list: any service that opts into the profile owes
 * these refs, and no node is named. Because the profile OWNS this contract, a node does NOT
 * re-list these keys anywhere — the operator unions them in at workload-build time
 * (`resolveRuntimeProfileSecretRefs`). The values themselves live only in the node's own
 * `cogni/<env>/<node>/*` scope and are resolved at the provider-I/O boundary; the value-presence
 * gate (`features/compute/compute-workload-manifest.ts`) already reads THIS constant, never the spec's ref list.
 *
 * The profile also implies the fork-image migration layout — `/app/app/migrate.mjs` +
 * `/app/app/migrations` (plus `migrate-doltgres.mjs` when `DOLTGRES_URL` is declared) — which
 * the operator's off-cluster-compute migration gate runs before any placement (bug.5116).
 */
export const COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS = [
  "AUTH_SECRET",
  "DATABASE_URL",
  "DATABASE_SERVICE_URL",
  "DATABASE_SSL_CA_CERT",
  // The knowledge store + Doltgres work-items are part of cogni-node-app-v1 (container.ts
  // builds knowledgeStorePort iff env.DOLTGRES_URL is set). It is composed into every node's
  // bank (secret-materialize COMPOSED_DSN_KEYS) and reaches k3s pods via ESO dataFrom:extract,
  // but the Akash lane's per-key ExternalSecret only requests the profile+catalog set — so
  // omitting it here left every Akash node's knowledge routes 503 ("knowledge store not
  // configured") fleet-wide (bug.5265; poly+beacon). Listing it also flips the reconciler's
  // migrate-doltgres gate (a DOLTGRES_URL key in the env) ON for Akash, so knowledge_<node> is
  // migrated before serving. DSN, not a password → off-cluster-allowed (like DATABASE_URL).
  "DOLTGRES_URL",
  "EVM_RPC_URL",
  "LITELLM_VIRTUAL_KEY",
  "SCHEDULER_API_TOKEN",
  "BILLING_INGEST_TOKEN",
] as const;

/**
 * Secret needed for the private Activity hop back into the node app. Temporal connection
 * details are non-secret profile env today; namespace-scoped Temporal credentials join this
 * contract when the self-hosted server enables its authentication/authorization boundary.
 */
export const COGNI_WORKFLOW_WORKER_V1_REQUIRED_SECRET_KEYS = [
  "SCHEDULER_API_TOKEN",
] as const;

function requiredSecretKeysForRuntimeProfile(
  runtimeProfile: NodeServiceRuntimeProfileSpec | undefined
): readonly string[] {
  switch (runtimeProfile) {
    case "cogni-node-app-v1":
      return COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS;
    case "cogni-workflow-worker-v1":
      return COGNI_WORKFLOW_WORKER_V1_REQUIRED_SECRET_KEYS;
    default:
      return [];
  }
}

/**
 * The single public Next.js app service every freshly-minted Cogni node ships with.
 * Identical in shape to the historical node-template workload. It declares no secrets: the
 * `cogni-node-app-v1` runtime profile owns that contract and the operator unions the required keys
 * in at build time (`resolveRuntimeProfileSecretRefs`). A node declares a secret BEYOND the profile
 * in its `.cogni/secrets-catalog.yaml`, never here.
 */
const COGNI_NODE_APP_V1_SERVICE: NodeServiceSpec = {
  name: "app",
  artifact: {
    name: "app",
    context: ".",
    dockerfile: "Dockerfile",
    target: "runner",
  },
  port: 3200,
  visibility: "public",
  runtime_profile: "cogni-node-app-v1",
  bindings: {},
  bind_host: "0.0.0.0",
  resources: { cpu_units: 2, memory_mi: 2048, storage_mi: 4096 },
};

/** Complete, provider-neutral `deployment:` declaration for a stock Cogni node. */
export const COGNI_NODE_APP_V1_DEPLOYMENT: NodeDeploymentSpec = {
  services: [COGNI_NODE_APP_V1_SERVICE],
};

/**
 * The fallback used when a node declares no `deployment:` block at all. k3s nodes resolve their
 * env through their per-node ExternalSecret overlay, so they ride this default. The distinction that
 * matters for off-cluster placement is PRESENCE of a declared block (`hasDeclaredNodeDeployment`):
 * profile keys are supplied at build time, so the declared block and this fallback are the same.
 */
export const LEGACY_DEFAULT_NODE_DEPLOYMENT: NodeDeploymentSpec = {
  services: [COGNI_NODE_APP_V1_SERVICE],
};

/**
 * The secret refs a service's workload receives from its runtime profile: the keys the profile
 * implies, in contract order. This is where the profile's ownership of its secret contract is
 * realized: the operator supplies the standard keys so a node does not re-list them in git. Keys
 * BEYOND the profile come from the node's secrets catalog (`catalogSecretKeysFor`), never from here.
 * A service with no recognized runtime profile gets none.
 */
export function resolveRuntimeProfileSecretRefs(input: {
  readonly runtimeProfile?: NodeServiceRuntimeProfileSpec | undefined;
}): readonly { readonly key: string }[] {
  return requiredSecretKeysForRuntimeProfile(input.runtimeProfile).map(
    (key) => ({ key })
  );
}

/**
 * Render a `deployment:` block as top-level `.cogni/repo-spec.yaml` YAML.
 * Used both to mint a node and to show an author exactly what to paste when theirs is absent.
 *
 * The block carries no secret list: the profile supplies the standard keys, and a node declares
 * any extra key in its secrets catalog.
 */
export function renderNodeDeploymentYaml(
  deployment: NodeDeploymentSpec = COGNI_NODE_APP_V1_DEPLOYMENT
): string {
  return stringify({ deployment }, { lineWidth: 0 });
}
