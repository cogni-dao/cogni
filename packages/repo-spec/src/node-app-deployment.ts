// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/repo-spec/node-app-deployment`
 * Purpose: Holds the one source of truth for the `cogni-node-app-v1` deployment declaration.
 *   It is the block a node carries in its own `.cogni/repo-spec.yaml` — what the node scaffold
 *   emits, what the external-compute gates require, and what a failure message tells you to add.
 * Scope: Pure data plus YAML rendering over the repo-spec schema; does not perform I/O, select a
 *   provider, resolve secret values, or name any node.
 * Invariants:
 *   - PROFILE_OWNS_ITS_SECRET_CONTRACT: `cogni-node-app-v1` is a named runtime profile declared in
 *     the repo-spec, so the logical secret keys that profile needs to boot are declared beside it.
 *     Scoped by capability (the profile), never by node name.
 *   - SCAFFOLD_AND_GATE_SHARE_ONE_VALUE: the generator that mints a node and the gate that rejects
 *     an incomplete node read the same constant, so they cannot drift.
 *   - RENDER_ROUND_TRIPS: `renderNodeDeploymentYaml` output re-parses to the same declaration.
 * Side-effects: none
 * Links: packages/repo-spec/src/schema.ts, task.5079, story.5016
 * @public
 */

import { stringify } from "yaml";

import type { NodeDeploymentSpec, NodeServiceSpec } from "./schema.js";

/**
 * Logical secret keys the `cogni-node-app-v1` runtime profile requires to boot.
 *
 * This is a CAPABILITY contract, not a node list: any service that opts into the profile owes
 * these refs, and no node is named. The values themselves live only in the node's own
 * `cogni/<env>/<node>/*` scope and are resolved at the provider-I/O boundary.
 */
export const COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS = [
  "AUTH_SECRET",
  "DATABASE_URL",
  "DATABASE_SERVICE_URL",
  "LITELLM_VIRTUAL_KEY",
  "SCHEDULER_API_TOKEN",
  "BILLING_INGEST_TOKEN",
] as const;

/**
 * The single public Next.js app service every freshly-minted Cogni node ships with.
 * Identical in shape to the historical node-template workload, plus the secret refs the
 * runtime profile has always needed but nobody wrote down.
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
  secret_refs: COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS.map((key) => ({ key })),
  bind_host: "0.0.0.0",
  resources: { cpu_units: 2, memory_mi: 2048, storage_mi: 4096 },
};

/** Complete, provider-neutral `deployment:` declaration for a stock Cogni node. */
export const COGNI_NODE_APP_V1_DEPLOYMENT: NodeDeploymentSpec = {
  services: [COGNI_NODE_APP_V1_SERVICE],
};

/**
 * The pre-`deployment:` behavior, expressed as the same declaration with the secret contract
 * stripped. k3s nodes resolve their env through their per-node ExternalSecret overlay rather
 * than through `secret_refs`, so their fallback intentionally declares none — the empty list is
 * what makes it *safe* to keep defaulting for that lane, and what makes it *unsafe* to boot an
 * externally hosted workload from.
 */
export const LEGACY_DEFAULT_NODE_DEPLOYMENT: NodeDeploymentSpec = {
  services: [{ ...COGNI_NODE_APP_V1_SERVICE, secret_refs: [] }],
};

/** Required keys a runtime-profiled service has not declared, in contract order. */
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
 * Render a `deployment:` block as top-level `.cogni/repo-spec.yaml` YAML.
 * Used both to mint a node and to show an author exactly what to paste when theirs is absent.
 */
export function renderNodeDeploymentYaml(
  deployment: NodeDeploymentSpec = COGNI_NODE_APP_V1_DEPLOYMENT
): string {
  return stringify({ deployment }, { lineWidth: 0 });
}
