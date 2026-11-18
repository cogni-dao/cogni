// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/instance-directory`
 * Purpose: Name each running copy of a node (its INSTANCE) and list, for one node and env, the instances
 *   that serve right now with the host each one serves from (story.5159 step 1, design hub
 *   `candidate-pr-lanes`). A run carries an instance name, never a URL; the scheduler-worker resolves that
 *   name here, so a callback never reaches a copy the run did not start on (node-template bug.0050).
 * Scope: Pure projection over the sequencer's durable rows through `StorePort`. It writes nothing and
 *   decides nothing the sequencer decides.
 * Invariants:
 *   - INSTANCE_IS_THE_WORKLOAD_NAME: the workload `app` is instance `main`; any other workload is the
 *     instance of the same name (`canary`, later `pr-<n>`). `COGNI_INSTANCE` in the app env and the
 *     directory read this one function, so the two cannot disagree.
 *   - NO_SECOND_TABLE (CD4): rows come from `node_workload_desired` plus the proven active attempt and its
 *     release. Nothing is stored for the directory.
 *   - RUNNING_AND_PROVEN_ONLY: an instance is listed only when its desired row is `running` AND an attempt
 *     of the workload is in phase `active` (the sequencer's proof). A stopped, queued, deploying or parked
 *     workload with no active attempt is absent, which is how the worker learns it is closed.
 *   - HOST_IS_THE_NODES_OWN: the host is the serving release's declared public host and must pass
 *     `hostOwnedBy` for this node, env and workload, so a release can never put another node's host in the
 *     directory. A host that fails the check drops the instance.
 *   - MAIN_IS_THE_APP: only the `app` workload is `main`. A worker workload (a sibling service) is never an
 *     instance, and a non-app workload named `main` is dropped, never listed as `main`.
 * Side-effects: IO (read-only store port)
 * Links: contracts/deploy.instances.v1.contract.ts, features/node-deploy/edge.ts,
 *   app/api/v1/deploy/instances/route.ts, services/scheduler-worker/src/adapters/instance-directory.ts
 * @public
 */

import type { DeployInstance } from "@/contracts/deploy.instances.v1.contract";
import type { StorePort } from "@/ports";
import type { WorkloadZoneBinding } from "@/shared/node-registry/fleet-ownership";

import { hostOwnedBy, siblingLabel } from "./edge";
import { publicHostOf } from "./spec";

/** The workload every node ships its main copy as. */
export const APP_WORKLOAD = "app";
/** The instance name of the main copy. */
export const MAIN_INSTANCE = "main";

/** The instance a workload is: `app` is `main`, any other workload is its own name. */
export function instanceOfWorkload(workload?: string): string {
  return workload === undefined || workload === APP_WORKLOAD
    ? MAIN_INSTANCE
    : workload;
}

export interface InstanceDirectoryInput {
  readonly store: Pick<StorePort, "listDesired" | "attemptsFor" | "getRelease">;
  readonly nodeId: string;
  /** The node's slug: the host guard names the node by it. */
  readonly slug: string;
  readonly env: string;
  readonly binding: WorkloadZoneBinding;
}

/** The running, proven instances of one node in one env, by instance name. */
export async function buildInstanceDirectory(
  input: InstanceDirectoryInput
): Promise<DeployInstance[]> {
  const { store, nodeId, slug, env, binding } = input;
  const rows = (await store.listDesired(env)).filter(
    (d) => d.nodeId === nodeId && d.env === env && d.state === "running"
  );
  const out: DeployInstance[] = [];
  for (const desired of rows) {
    const instance = instanceOfWorkload(desired.workload);
    if (instance === MAIN_INSTANCE && desired.workload !== APP_WORKLOAD)
      continue;
    const active = (await store.attemptsFor(desired)).find(
      (a) => a.phase === "active"
    );
    if (!active) continue;
    const release = await store.getRelease(active.releaseId);
    if (!release || release.spec.runtimeProfile === "worker") continue;
    const host = publicHostOf(release.spec)?.toLowerCase();
    if (!host) continue;
    const label = siblingLabel({
      binding,
      host,
      env,
      slug,
      workload: desired.workload,
      worker: false,
    });
    if (!hostOwnedBy(binding, host, env, slug, label)) continue;
    out.push({
      instance,
      workload: desired.workload,
      host,
      releaseId: release.id,
      sourceSha: release.sourceSha,
    });
  }
  return out.sort((a, b) => a.instance.localeCompare(b.instance));
}
