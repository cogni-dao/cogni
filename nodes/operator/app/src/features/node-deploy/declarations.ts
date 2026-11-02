// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/declarations`
 * Purpose: Turn a node's `.cogni/repo-spec.yaml` text (read at a `sourceSha` through the operator's
 *   GitHub App) into the ONE resolved `NodeWorkloadSpec` a release stores (task.5400).
 * Scope: Pure parse + checks. The GitHub read lives in the route; the release write lives in the store.
 * Invariants:
 *   - DECLARED_AT_THE_SHA: the declaration comes from the repo-spec AT `sourceSha`, never from a
 *     mutable branch, and the resolved spec is frozen into the release row.
 *   - SPEC_IS_THE_NODES_OWN: the spec's `node_id` must equal the requested node; a repo-spec that
 *     names another node is refused, so a caller can never deploy another node's workloads.
 *   - HOST_FOLLOWS_ENV: a declaration names its PRODUCTION host; other environments get the
 *     `-test` (candidate-a) / `-preview` / `-dev` sibling of its first label, so one declaration serves
 *     every environment without a per-env copy.
 * Side-effects: none
 * @internal
 */

import {
  extractNodeId,
  extractNodeWorkloads,
  parseRepoSpec,
} from "@cogni/repo-spec";

import type { NodeWorkloadSpec } from "@/ports";

const ENV_HOST_SUFFIX: Readonly<Record<string, string | undefined>> = {
  production: undefined,
  "candidate-a": "test",
  preview: "preview",
  dev: "dev",
};

/** `node-deploy-canary.cognidao.org` -> `node-deploy-canary-test.cognidao.org` for candidate-a. */
export function hostForEnv(host: string, env: string): string {
  if (!(env in ENV_HOST_SUFFIX)) throw new Error(`unknown environment ${env}`);
  const suffix = ENV_HOST_SUFFIX[env];
  if (!suffix) return host;
  const dot = host.indexOf(".");
  if (dot <= 0) throw new Error(`host ${host} has no zone`);
  return `${host.slice(0, dot)}-${suffix}${host.slice(dot)}`;
}

export type DeclarationErrorCode =
  | "repo_spec_unparseable"
  | "node_mismatch"
  | "workload_not_declared";

export class DeclarationError extends Error {
  constructor(
    readonly code: DeclarationErrorCode,
    message: string
  ) {
    super(message);
    this.name = "DeclarationError";
  }
}

export function resolveWorkloadDeclaration(input: {
  readonly repoSpecText: string;
  readonly nodeId: string;
  readonly env: string;
  readonly workload: string;
}): NodeWorkloadSpec {
  let spec: ReturnType<typeof parseRepoSpec>;
  try {
    spec = parseRepoSpec(input.repoSpecText);
  } catch (error) {
    throw new DeclarationError(
      "repo_spec_unparseable",
      error instanceof Error ? error.message.slice(0, 300) : "unparseable"
    );
  }
  if (extractNodeId(spec) !== input.nodeId)
    throw new DeclarationError(
      "node_mismatch",
      "the repo-spec at this sha belongs to a different node"
    );
  const declared = extractNodeWorkloads(spec).find(
    (w) => w.name === input.workload
  );
  if (!declared)
    throw new DeclarationError(
      "workload_not_declared",
      `workload ${input.workload} is not declared under deployment.workloads`
    );
  if (!("http" in declared.expose)) return declared;
  return {
    ...declared,
    expose: {
      http: { host: hostForEnv(declared.expose.http.host, input.env) },
    },
  };
}
