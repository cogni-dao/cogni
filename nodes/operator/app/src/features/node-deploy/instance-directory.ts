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
 *   - INSTANCE_HOST_IS_ITS_OWN: a non-main instance must hold its OWN sibling host (`siblingLabel` names its
 *     workload), never the node's main host and never a host another instance holds. A non-app workload that
 *     declares the main host would otherwise send its callbacks to main (bug.0050 again), so it is dropped.
 *     The operator's own canary (the `operator` slug) serves the node's own host by design, so only the
 *     host-collision rule guards it.
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
/** The operator node's slug; its canary is its own host (`edge.ts` CANARY_LABEL). */
const OPERATOR_SLUG = "operator";
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
  const found: DeployInstance[] = [];
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
    // INSTANCE_HOST_IS_ITS_OWN: a non-main instance must hold the sibling host named for its workload.
    if (
      instance !== MAIN_INSTANCE &&
      slug !== OPERATOR_SLUG &&
      label !== desired.workload
    )
      continue;
    found.push({
      instance,
      workload: desired.workload,
      host,
      releaseId: release.id,
      sourceSha: release.sourceSha,
    });
  }
  // No two instances may share a host: a collision is ambiguous, so every non-main holder is dropped
  // (the main instance keeps its host; a copy that declares it never reaches main through another name).
  const mainHost = found.find((i) => i.instance === MAIN_INSTANCE)?.host;
  const hostCount = new Map<string, number>();
  for (const i of found)
    hostCount.set(i.host, (hostCount.get(i.host) ?? 0) + 1);
  const out = found.filter(
    (i) =>
      i.instance === MAIN_INSTANCE ||
      (i.host !== mainHost && hostCount.get(i.host) === 1)
  );
  return out.sort((a, b) => a.instance.localeCompare(b.instance));
}
