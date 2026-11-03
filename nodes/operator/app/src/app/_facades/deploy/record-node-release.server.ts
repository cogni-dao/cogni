// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/deploy/record-node-release.server`
 * Purpose: The ONE writer of node-deploy releases (story.5137, task.5400). Records the intent to deploy ONE
 *   declared workload of one node at a source sha: reads the node's own repo-spec and manifests at the sha,
 *   lowers an image of `.` to the digest node CI built, checks the manifests, and writes an immutable
 *   release plus the desired row in one transaction. `POST /api/v1/deploy/workloads` calls it; the
 *   merge-to-preview webhook will call it too (no second brain).
 * Scope: Everything AFTER authorization and the lane refusals. It authorizes nothing, never calls the
 *   actuator and never touches DNS: the sequencer executes the intent. Returns a typed result (status +
 *   body) instead of an HTTP response so a non-route caller can use it.
 * Invariants:
 *   - INTENT_ONLY: `ok: true` means a release row exists, not that anything is deployed.
 *   - DECLARED_AT_THE_SHA: the manifests and the repo-spec are read at `sourceSha` from the node's repo,
 *     and the repo-spec `node_id` must equal the requested node.
 *   - NODE_DEPLOYS_FROM_ITS_OWN_REPO: the repo comes from the node's row in the IMAGE catalog
 *     (`createNodeSourceResolver`, story.5137), never from a GitHub read of an env-specific parent repo,
 *     so every env and every caller is the same call: a remote-source node reads its own `source_repo` and
 *     image repository; an in-repo node (the operator) reads the parent repo and has no built image.
 *   - READ_NEEDS_NO_NEW_SECRET: the operator App read is tried first; a public repo the App is not
 *     installed on is read anonymously (read-only). Nothing is ever written to a node repo.
 *   - ALWAYS_DEFER (story.5137): an image of `.` lowers to `<image_repository>:sha-<sha>` with
 *     `imagePending: true` in EVERY env for EVERY caller. This facade never waits on node CI and never
 *     reads the registry: the sequencer resolves the digest once, pins it write-once on the release, and
 *     waits as `DependencyNotReady` until the image exists. Only a malformed reference is refused here: an
 *     image of `.` on a node with no image repository (the operator) is 422 `built_image_unresolved`.
 *   - REFUSED_BEFORE_PAID_CREATE: a manifest the two-pass check refuses returns 422
 *     `workload_manifest_refused` with every issue; no release row is written.
 *   - STATE_IS_CREATE_ONCE: a `state` workload that already has a desired row is refused with 409; a
 *     state lease is never replaced by a deploy.
 *   - G4_STATE_ADMISSION: a new production `state` workload is refused 422 `state_admission_refused`
 *     until the off-provider backup debt row closes; the only exception is the operator node's own
 *     `canary-db`.
 *   - NO_SOURCE_ECHO: a 502 read failure never returns the GitHub/Octokit message.
 * Side-effects: IO (image catalog file read, GitHub App or anonymous contents read, operator Postgres write)
 * Links: contracts/deploy.workloads.v1.contract.ts, features/node-deploy/declarations.ts,
 *   features/node-deploy/read-declarations.ts, features/node-deploy/sequencer.ts (pinImage),
 *   hub `node-service-delivery`, hub `workload-manifest`
 * @public
 */

import { createNodeDeployStore } from "@/bootstrap/capabilities/node-deploy-store";
import {
  createDeclarationReader,
  createNodeSourceResolver,
} from "@/bootstrap/capabilities/node-source-resolver";
import type { DeployWorkloadInput } from "@/contracts/deploy.workloads.v1.contract";
import {
  DeclarationError,
  resolveWorkloadDeclaration,
} from "@/features/node-deploy/declarations";
import {
  readWorkloadDeclarations,
  type WorkloadDeclarationsRead,
} from "@/features/node-deploy/read-declarations";
import type { ResolvedNodeSource } from "@/ports";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";

/**
 * G4 canary-only exception: the one production state workload admitted before backups exist. It
 * holds only for the operator's OWN node (`getNodeId()`), never for another node's `canary-db`.
 */
const G4_PRODUCTION_STATE_EXCEPTION = "canary-db";

export interface RecordNodeReleaseInput {
  readonly node: { readonly id: string; readonly slug: string };
  readonly env: DeployWorkloadInput["env"];
  readonly workload: string;
  readonly sourceSha: string;
  /** `user:<id>` for a verb call; the webhook passes its own principal. */
  readonly createdBy: string;
  readonly log: { warn(fields: object, msg: string): void };
  readonly reqId?: string;
}

export type RecordNodeReleaseResult =
  | {
      readonly ok: true;
      readonly releaseId: string;
      readonly desiredState: string;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly body: Record<string, unknown>;
    };

const refused = (
  status: number,
  body: Record<string, unknown>
): RecordNodeReleaseResult => ({ ok: false, status, body });

export async function recordNodeRelease(
  input: RecordNodeReleaseInput
): Promise<RecordNodeReleaseResult> {
  const { node, env, workload, sourceSha, log } = input;
  const envConfig = serverEnv();
  const owner = envConfig.NODE_SUBMODULE_PARENT_OWNER;
  const repo = envConfig.NODE_SUBMODULE_PARENT_REPO;
  if (!owner || !repo)
    return refused(503, { error: "deploy_target_not_configured" });

  let source: ResolvedNodeSource;
  let read: WorkloadDeclarationsRead;
  try {
    source = await createNodeSourceResolver().resolveNodeSource({
      nodeId: node.id,
      parentOwner: owner,
      parentRepo: repo,
    });
    read = await readWorkloadDeclarations(createDeclarationReader(envConfig), {
      owner: source.owner,
      repo: source.repo,
      sourceSha,
    });
  } catch (error) {
    if ((error as { code?: unknown })?.code === "catalog_missing")
      return refused(404, { error: "catalog_missing" });
    // NO_SOURCE_ECHO: never return the Octokit/GitHub message; log it for the operator instead.
    log.warn(
      {
        reqId: input.reqId,
        err: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      },
      "node-deploy declaration read failed"
    );
    return refused(502, {
      error: "declaration_read_failed",
      message: "could not read the declarations at this sha",
    });
  }
  if (read.kind === "repo_spec_not_found")
    return refused(422, { error: "repo_spec_not_found" });
  if (read.kind === "refused")
    // NOTHING_SILENTLY_DROPPED: a non-*.yaml entry or too many manifests; every issue is returned.
    return refused(422, {
      error: "workload_manifest_refused",
      message: read.message,
      issues: read.issues,
    });

  // ALWAYS_DEFER: an image of `.` becomes the tag node CI publishes at this sha, pending. A node with no
  // image repository (the operator) has none, so `.` stays refused (`built_image_unresolved`).
  const pendingImage = source.imageRepository
    ? `${source.imageRepository}:sha-${sourceSha.toLowerCase()}`
    : undefined;
  let spec: ReturnType<typeof resolveWorkloadDeclaration>;
  try {
    spec = resolveWorkloadDeclaration({
      repoSpecText: read.repoSpecText,
      manifests: read.manifests,
      nodeId: node.id,
      env,
      workload,
      pendingImage,
    });
  } catch (error) {
    if (error instanceof DeclarationError)
      return refused(error.code === "workload_not_declared" ? 404 : 422, {
        error: error.code,
        message: error.message,
        ...(error.issues.length > 0 ? { issues: error.issues } : {}),
      });
    throw error;
  }

  // G4: no NEW production state until the off-provider backup debt row closes (hub
  // node-service-delivery, debt ledger). `canary-db` is the one canary-only exception: it holds
  // canary boot rows, no user data. Lift this guard when that debt row closes.
  if (
    env === "production" &&
    spec.kind === "state" &&
    !(node.id === getNodeId() && workload === G4_PRODUCTION_STATE_EXCEPTION)
  )
    return refused(422, {
      error: "state_admission_refused",
      message:
        "a new production state workload is refused until off-provider backups exist (G4)",
    });

  const store = createNodeDeployStore();
  if (spec.kind === "state") {
    const existing = await store.getDesired({
      nodeId: node.id,
      env,
      workload,
    });
    if (existing) return refused(409, { error: "state_workload_exists" });
  }
  const { release, desired } = await store.recordRelease({
    nodeId: node.id,
    env,
    workload,
    sourceSha,
    spec,
    createdBy: input.createdBy,
  });
  return { ok: true, releaseId: release.id, desiredState: desired.state };
}
