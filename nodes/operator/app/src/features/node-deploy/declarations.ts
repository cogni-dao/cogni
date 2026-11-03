// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/declarations`
 * Purpose: Turn a node's workload manifests (`.cogni/workloads/*.yaml`) plus its `.cogni/repo-spec.yaml`,
 *   all read at one `sourceSha` through the operator's GitHub App, into the ONE resolved
 *   `NodeWorkloadSpec` a release stores (task.5400, story.5137).
 * Scope: Pure checks. The GitHub reads live in the route; the release write lives in the store; the
 *   two-pass manifest check and the lowering live in `@cogni/repo-spec` (workload-manifest).
 * Invariants:
 *   - DECLARED_AT_THE_SHA: every manifest and the repo-spec come from the tree AT `sourceSha`, never
 *     from a mutable branch, and the resolved spec is frozen into the release row.
 *   - SPEC_IS_THE_NODES_OWN: the repo-spec `node_id` must equal the requested node; a tree that names
 *     another node is refused, so a caller can never deploy another node's workloads.
 *   - WHOLE_SET_CHECKED: all of the node's manifests are checked together (ids unique, ids differ from
 *     workload names) before any one workload resolves, so a refused sibling refuses the release.
 *   - EXCLUSIVE_IS_REFUSED (CD6): the manifest check refuses `cogni.dev/exclusive: "true"`, because
 *     blue and green overlap and the fenced lock that makes that safe is not built yet.
 *   - HOST_FOLLOWS_ENV: a manifest names its PRODUCTION host; other environments get the
 *     `-test` (candidate-a) / `-preview` / `-dev` sibling of its first label, so one manifest serves
 *     every environment without a per-env copy.
 * Side-effects: none
 * @internal
 */

import {
  extractNodeId,
  lowerWorkloadManifests,
  parseRepoSpec,
  WorkloadManifestError,
  type WorkloadManifestFile,
  type WorkloadManifestIssue,
} from "@cogni/repo-spec";

import { parse as parseYaml } from "yaml";

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
  | "workload_not_declared"
  | "workload_manifest_refused";

export class DeclarationError extends Error {
  constructor(
    readonly code: DeclarationErrorCode,
    message: string,
    readonly issues: readonly WorkloadManifestIssue[] = []
  ) {
    super(message);
    this.name = "DeclarationError";
  }
}

export function resolveWorkloadDeclaration(input: {
  readonly repoSpecText: string;
  readonly manifests: readonly WorkloadManifestFile[];
  readonly nodeId: string;
  readonly env: string;
  readonly workload: string;
}): NodeWorkloadSpec {
  // NO_SOURCE_ECHO: parse the YAML without pretty errors, and never return the parser's or the
  // schema's message (either can quote repo-spec text).
  let raw: unknown;
  try {
    raw = parseYaml(input.repoSpecText, {
      prettyErrors: false,
      logLevel: "error",
    });
  } catch {
    throw new DeclarationError(
      "repo_spec_unparseable",
      "repo-spec is not valid YAML"
    );
  }
  let spec: ReturnType<typeof parseRepoSpec>;
  try {
    spec = parseRepoSpec(raw);
  } catch {
    throw new DeclarationError(
      "repo_spec_unparseable",
      "repo-spec does not match the repo-spec schema"
    );
  }
  if (extractNodeId(spec) !== input.nodeId)
    throw new DeclarationError(
      "node_mismatch",
      "the repo-spec at this sha belongs to a different node"
    );
  let workloads: NodeWorkloadSpec[];
  try {
    workloads = lowerWorkloadManifests(input.manifests);
  } catch (error) {
    if (error instanceof WorkloadManifestError)
      throw new DeclarationError(
        "workload_manifest_refused",
        error.message,
        error.issues.slice(0, 20)
      );
    throw error;
  }
  const declared = workloads.find((w) => w.name === input.workload);
  if (!declared)
    throw new DeclarationError(
      "workload_not_declared",
      `workload ${input.workload} is not declared by any .cogni/workloads/*.yaml manifest`
    );
  if (!("http" in declared.expose)) return declared;
  return {
    ...declared,
    expose: {
      http: { host: hostForEnv(declared.expose.http.host, input.env) },
    },
  };
}
