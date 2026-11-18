// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/jobs/nodeAdminSync`
 * Purpose: Sync each node's OpenFGA `node:<id>#admin` holders to its repo-spec approvers.
 * Scope: Per-node orchestration over injected ports: read approvers, read current tuples, plan the diff,
 *   apply it only in write mode, log one event. No database, no GitHub, no env, no timers: the job wrapper
 *   (`syncNodeAdmins.job.ts`) owns the lock and the node rows, `node-admin-sync.ts` owns the tick.
 * Invariants:
 *   - ONE_ADMIN_WRITER: in write mode this is the only writer of `node:<id>#admin`; the legacy catalog
 *     owner writer is skipped (see `reconcileCatalogNodeRegistry.job.ts`).
 *   - REPORT_ONLY_WRITES_NOTHING: with `write: false` no `writeRelation` or `deleteRelation` is ever called.
 *   - NEVER_LOCK_OUT: nothing is written for `unavailable`, `empty` or `refused`; adds are applied before
 *     deletes, and a failed add skips every delete, so a partial apply never shrinks the admin set.
 *   - NEVER_THROWS: a node's failure is its own `unavailable` outcome and never stops the other nodes.
 *   - ONE_EVENT_PER_NODE_PER_TICK: `identity.node_admin_sync` with nodeId, outcome, mode, adds, deletes.
 *   - USER_IDS_ONLY_IN_LOGS: the event carries user ids and counts, never wallet addresses.
 *   - BOUNDED_CONCURRENCY: at most `NODE_ADMIN_SYNC_CONCURRENCY` nodes are in flight.
 * Side-effects: IO (OpenFGA reads and, in write mode, writes), logging.
 * Links: src/shared/node-registry/node-admin-sync.ts, https://cognidao.org/knowledge/operator-identity-model, task.5494
 * @public
 */

import type { AuthorizationPort } from "@cogni/authorization-core";

import type { NodeApproverReader, NodeApproverTarget } from "@/ports";
import {
  type NodeAdminPlan,
  type NodeAdminSyncOutcome,
  type NodeApproverRead,
  planNodeAdminSync,
  userIdFromSubject,
} from "@/shared/node-registry/node-admin-sync";
import { EVENT_NAMES } from "@/shared/observability";

export const NODE_ADMIN_SYNC_CONCURRENCY = 3;

/** User ids listed in the event, per direction. A diff is a handful of admins; this is a log-size guard. */
const MAX_LOGGED_USER_IDS = 20;

export interface NodeAdminSyncLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface NodeAdminSyncDeps {
  readonly reader: NodeApproverReader;
  readonly authorization: Pick<
    AuthorizationPort,
    "listRelationsByObject" | "writeRelation" | "deleteRelation"
  >;
  /** `NODE_ADMIN_SYNC_WRITE`. False = report-only. */
  readonly write: boolean;
  readonly log: NodeAdminSyncLog;
}

export interface NodeAdminSyncResult {
  readonly nodeId: string;
  readonly outcome: NodeAdminSyncOutcome;
  readonly mode: "report" | "write";
  readonly adds: number;
  readonly deletes: number;
}

export async function syncNodeAdmin(
  deps: NodeAdminSyncDeps,
  node: NodeApproverTarget
): Promise<NodeAdminSyncResult> {
  const mode = deps.write ? "write" : "report";
  let approvers: NodeApproverRead = { status: "unavailable" };
  let plan: NodeAdminPlan = { outcome: "unavailable", adds: [], deletes: [] };
  let writeFailed = false;

  try {
    approvers = await deps.reader.approvers(node);
    const current = await deps.authorization.listRelationsByObject(
      `node:${node.nodeId}`,
      "admin"
    );
    const currentUserIds =
      current.decision === "success"
        ? current.tuples
            .map((tuple) => userIdFromSubject(tuple.user))
            .filter((id): id is string => id !== null)
        : null;

    plan = planNodeAdminSync({ approvers, currentUserIds });

    if (deps.write && plan.outcome === "ok") {
      writeFailed = !(await applyPlan(deps.authorization, node.nodeId, plan));
    }
  } catch {
    // The reader and the authorization port report failure as values. Anything thrown here is
    // unexpected; it is this node's `unavailable`, never a stop for the other nodes.
    plan = { outcome: "unavailable", adds: [], deletes: [] };
  }

  const outcome: NodeAdminSyncOutcome = writeFailed
    ? "unavailable"
    : plan.outcome;
  const fields: Record<string, unknown> = {
    event: EVENT_NAMES.IDENTITY_NODE_ADMIN_SYNC,
    nodeId: node.nodeId,
    outcome,
    mode,
    adds: plan.adds.length,
    deletes: plan.deletes.length,
    ...(approvers.status === "read"
      ? {
          approverCount: approvers.approverCount,
          mappedCount: approvers.userIds.length,
        }
      : {}),
    ...(writeFailed ? { writeFailed: true } : {}),
    ...(plan.adds.length > 0
      ? { addUserIds: plan.adds.slice(0, MAX_LOGGED_USER_IDS) }
      : {}),
    ...(plan.deletes.length > 0
      ? { deleteUserIds: plan.deletes.slice(0, MAX_LOGGED_USER_IDS) }
      : {}),
  };
  if (outcome === "ok" || outcome === "empty") {
    deps.log.info(fields, EVENT_NAMES.IDENTITY_NODE_ADMIN_SYNC);
  } else {
    deps.log.warn(fields, EVENT_NAMES.IDENTITY_NODE_ADMIN_SYNC);
  }

  return {
    nodeId: node.nodeId,
    outcome,
    mode,
    adds: plan.adds.length,
    deletes: plan.deletes.length,
  };
}

/** Adds first, then deletes. Returns false on the first failed write, leaving the rest unwritten. */
async function applyPlan(
  authorization: NodeAdminSyncDeps["authorization"],
  nodeId: string,
  plan: NodeAdminPlan
): Promise<boolean> {
  const object = `node:${nodeId}`;
  for (const userId of plan.adds) {
    const result = await authorization.writeRelation({
      user: `user:${userId}`,
      relation: "admin",
      object,
    });
    if (result.decision !== "success") return false;
  }
  for (const userId of plan.deletes) {
    const result = await authorization.deleteRelation({
      user: `user:${userId}`,
      relation: "admin",
      object,
    });
    if (result.decision !== "success") return false;
  }
  return true;
}

/** Sync every node with at most `concurrency` in flight. Never rejects. */
export async function syncNodeAdmins(
  deps: NodeAdminSyncDeps,
  nodes: readonly NodeApproverTarget[],
  concurrency: number = NODE_ADMIN_SYNC_CONCURRENCY
): Promise<readonly NodeAdminSyncResult[]> {
  const results: NodeAdminSyncResult[] = new Array(nodes.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < nodes.length) {
      const index = next;
      next += 1;
      const node = nodes[index];
      if (node) results[index] = await syncNodeAdmin(deps, node);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, nodes.length) }, worker)
  );
  return results;
}
