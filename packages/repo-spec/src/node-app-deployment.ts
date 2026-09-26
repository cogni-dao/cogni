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
 *     (`resolveRuntimeProfileSecretRefs`); a node's repo-spec declares only refs BEYOND the profile.
 *     This kills the stale-spec class (bug.5175): a node spec authored before a key was added to the
 *     profile still flights, because the profile — not the git file — is the source of truth.
 *     Scoped by capability (the profile), never by node name.
 *   - SCAFFOLD_AND_RESOLVER_SHARE_ONE_VALUE: the block the node scaffold emits carries NO profile
 *     refs, and the resolver that fills them at build time reads the same constant, so a stock node
 *     and its deployed workload cannot drift.
 *   - RENDER_ROUND_TRIPS: `renderNodeDeploymentYaml` output re-parses to the same declaration.
 * Side-effects: none
 * Links: packages/repo-spec/src/schema.ts, task.5079, story.5016, bug.5175
 * @public
 */

import { stringify } from "yaml";

import type { NodeDeploymentSpec, NodeServiceSpec } from "./schema.js";

/**
 * Logical secret keys the `cogni-node-app-v1` runtime profile requires to boot.
 *
 * This is a CAPABILITY contract, not a node list: any service that opts into the profile owes
 * these refs, and no node is named. Because the profile OWNS this contract, a node does NOT
 * re-list these keys in its repo-spec — the operator unions them in at workload-build time
 * (`resolveRuntimeProfileSecretRefs`). The values themselves live only in the node's own
 * `cogni/<env>/<node>/*` scope and are resolved at the provider-I/O boundary; the value-presence
 * gate (`compute-workload-reconciler`) already reads THIS constant, never the spec's ref list.
 *
 * The profile also implies the fork-image migration layout — `/app/app/migrate.mjs` +
 * `/app/app/migrations` (plus `migrate-doltgres.mjs` when `DOLTGRES_URL` is declared) — which
 * the operator's off-cluster-compute migration gate runs before any placement (bug.5116).
 */
export const COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS = [
  "AUTH_SECRET",
  "DATABASE_URL",
  "DATABASE_SERVICE_URL",
  // The knowledge store + Doltgres work-items are part of cogni-node-app-v1 (container.ts
  // builds knowledgeStorePort iff env.DOLTGRES_URL is set). It is composed into every node's
  // bank (secret-materialize COMPOSED_DSN_KEYS) and reaches k3s pods via ESO dataFrom:extract,
  // but the Akash lane's per-key ExternalSecret only requests the profile+secret_refs set — so
  // omitting it here left every Akash node's knowledge routes 503 ("knowledge store not
  // configured") fleet-wide (bug.5265; poly+beacon). Listing it also flips the reconciler's
  // migrate-doltgres gate (secretRefs.some(DOLTGRES_URL)) ON for Akash, so knowledge_<node> is
  // migrated before serving. DSN, not a password → off-cluster-allowed (like DATABASE_URL).
  "DOLTGRES_URL",
  "EVM_RPC_URL",
  "LITELLM_VIRTUAL_KEY",
  "SCHEDULER_API_TOKEN",
  "BILLING_INGEST_TOKEN",
] as const;

/**
 * The single public Next.js app service every freshly-minted Cogni node ships with.
 * Identical in shape to the historical node-template workload. It declares NO `secret_refs`:
 * the `cogni-node-app-v1` runtime profile owns that contract and the operator unions the
 * required keys in at build time (`resolveRuntimeProfileSecretRefs`). A node lists refs here
 * only when it needs a secret BEYOND the profile.
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
  secret_refs: [],
  bind_host: "0.0.0.0",
  resources: { cpu_units: 2, memory_mi: 2048, storage_mi: 4096 },
};

/** Complete, provider-neutral `deployment:` declaration for a stock Cogni node. */
export const COGNI_NODE_APP_V1_DEPLOYMENT: NodeDeploymentSpec = {
  services: [COGNI_NODE_APP_V1_SERVICE],
};

/**
 * The fallback used when a node declares no `deployment:` block at all. k3s nodes resolve their
 * env through their per-node ExternalSecret overlay rather than through `secret_refs`, so they
 * ride this default. The distinction that matters for off-cluster placement is now PRESENCE of a
 * declared block (`hasDeclaredNodeDeployment`), not the ref list: profile refs are supplied at
 * build time, so the declared block and this fallback share the same empty `secret_refs`.
 */
export const LEGACY_DEFAULT_NODE_DEPLOYMENT: NodeDeploymentSpec = {
  services: [{ ...COGNI_NODE_APP_V1_SERVICE, secret_refs: [] }],
};

/** Required keys a runtime-profiled service has not explicitly declared, in contract order. */
export function missingRuntimeProfileSecretKeys(input: {
  readonly runtimeProfile?: "cogni-node-app-v1" | undefined;
  readonly secretRefs: readonly { readonly key: string }[];
}): readonly string[] {
  if (input.runtimeProfile !== "cogni-node-app-v1") return [];
  const declared = new Set(input.secretRefs.map((ref) => ref.key));
  return COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS.filter(
    (key) => !declared.has(key)
  );
}

/**
 * Resolve the secret refs a service's workload actually receives: the keys its runtime profile
 * implies, unioned with any EXTRA refs the node declared. This is where the profile's ownership
 * of its secret contract is realized — the operator supplies the standard keys so a node need
 * not (and should not) re-list them in git.
 *
 * Profile keys come first, in contract order, then any node-declared extras, deduped. A service
 * with no recognized runtime profile is returned unchanged (its refs are whatever it declared).
 */
export function resolveRuntimeProfileSecretRefs(input: {
  readonly runtimeProfile?: "cogni-node-app-v1" | undefined;
  readonly secretRefs: readonly { readonly key: string }[];
}): readonly { readonly key: string }[] {
  if (input.runtimeProfile !== "cogni-node-app-v1") return input.secretRefs;
  const seen = new Set<string>();
  const resolved: { readonly key: string }[] = [];
  for (const key of COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS) {
    if (!seen.has(key)) {
      seen.add(key);
      resolved.push({ key });
    }
  }
  for (const ref of input.secretRefs) {
    if (!seen.has(ref.key)) {
      seen.add(ref.key);
      resolved.push({ key: ref.key });
    }
  }
  return resolved;
}

/**
 * Render a `deployment:` block as top-level `.cogni/repo-spec.yaml` YAML.
 * Used both to mint a node and to show an author exactly what to paste when theirs is absent.
 *
 * An empty `secret_refs` list is omitted from the rendered YAML so the block a node carries is
 * clean: the profile supplies the standard keys, and a node adds refs here only for extras.
 * Round-trips because the schema re-applies the `secret_refs: []` default on parse.
 */
export function renderNodeDeploymentYaml(
  deployment: NodeDeploymentSpec = COGNI_NODE_APP_V1_DEPLOYMENT
): string {
  const services = deployment.services.map((service) => {
    if (service.secret_refs.length > 0) return service;
    const { secret_refs: _omit, ...rest } = service;
    return rest;
  });
  return stringify(
    { deployment: { ...deployment, services } },
    {
      lineWidth: 0,
    }
  );
}
