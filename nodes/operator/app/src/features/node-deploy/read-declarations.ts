// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/read-declarations`
 * Purpose: Read a node's `.cogni/repo-spec.yaml` and every workload manifest (`.cogni/workloads/*.yaml`)
 *   at ONE source sha through the deploy plane, so the deploy route only maps outcomes to HTTP (story.5137).
 * Scope: Read orchestration only. It does not check or lower manifests (that is `declarations.ts` plus
 *   `@cogni/repo-spec`), and it does not write anything.
 * Invariants:
 *   - DECLARED_AT_THE_SHA: every read names `ref: sourceSha`; nothing reads a branch.
 *   - NOTHING_SILENTLY_DROPPED: every `.cogni/workloads` entry is checked; any entry that is not a
 *     regular `*.yaml` file (or too many entries) returns `refused` with its issues, before any manifest
 *     read. A file listed at a fixed sha that then reads as absent throws (a failed read, never a skip).
 *   - Read failures throw; the caller maps them to 502 `declaration_read_failed`.
 * Side-effects: IO (deploy-plane GitHub contents reads)
 * Links: features/node-deploy/declarations.ts, app/api/v1/deploy/workloads/route.ts,
 *   packages/repo-spec/src/workload-manifest.ts
 * @internal
 */

import {
  checkWorkloadDirectoryEntries,
  WORKLOAD_MANIFEST_DIR,
  WorkloadManifestError,
  type WorkloadManifestFile,
  type WorkloadManifestIssue,
} from "@cogni/repo-spec";

import type { DeployPlanePort } from "@/ports";

export const REPO_SPEC_PATH = ".cogni/repo-spec.yaml";

export type WorkloadDeclarationsRead =
  | {
      readonly kind: "ok";
      readonly repoSpecText: string;
      readonly manifests: readonly WorkloadManifestFile[];
    }
  | { readonly kind: "repo_spec_not_found" }
  | {
      readonly kind: "refused";
      readonly message: string;
      readonly issues: readonly WorkloadManifestIssue[];
    };

export async function readWorkloadDeclarations(
  plane: Pick<DeployPlanePort, "fetchFileText" | "listDirectoryEntries">,
  input: {
    readonly owner: string;
    readonly repo: string;
    readonly sourceSha: string;
  }
): Promise<WorkloadDeclarationsRead> {
  const { owner, repo, sourceSha } = input;
  const repoSpecText = await plane.fetchFileText({
    owner,
    repo,
    path: REPO_SPEC_PATH,
    ref: sourceSha,
  });
  if (repoSpecText === null) return { kind: "repo_spec_not_found" };

  const entries =
    (await plane.listDirectoryEntries({
      owner,
      repo,
      path: WORKLOAD_MANIFEST_DIR,
      ref: sourceSha,
    })) ?? [];
  let names: string[];
  try {
    names = checkWorkloadDirectoryEntries(entries);
  } catch (error) {
    if (!(error instanceof WorkloadManifestError)) throw error;
    return {
      kind: "refused",
      message: error.message,
      issues: error.issues.slice(0, 20),
    };
  }

  const manifests: WorkloadManifestFile[] = [];
  for (const name of names) {
    const path = `${WORKLOAD_MANIFEST_DIR}/${name}`;
    const text = await plane.fetchFileText({
      owner,
      repo,
      path,
      ref: sourceSha,
    });
    if (text === null) throw new Error(`${path} listed but unreadable`);
    manifests.push({ path, text });
  }
  return { kind: "ok", repoSpecText, manifests };
}
