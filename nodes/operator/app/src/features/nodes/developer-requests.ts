// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/developer-requests`
 * Purpose: Service-DB query helpers for the node developer-access request table. Used by the agent
 *   request route, the owner decision route, and the owner node page.
 * Scope: Pure data access over `node_developer_requests` (+ a `users.name` join for display). All
 *   callers must pass a service-role DB and gate ownership/identity at the route/page layer — this
 *   table is RLS-forced with no app_user policy.
 * Invariants: NOT_AUTHORITY (OpenFGA is the flight authority), ONE_ROW_PER_AGENT_NODE.
 * Side-effects: IO (Postgres read/write)
 * Links: docs/spec/rbac.md §6
 * @public
 */

import type { Database } from "@cogni/db-client";
import { users } from "@cogni/db-schema/refs";
import { and, desc, eq, sql } from "drizzle-orm";

import {
  type NodeDeveloperRequestScope,
  type NodeDeveloperRequestStatus,
  nodeDeveloperRequests,
} from "@/shared/db/node-developer-requests";

export interface DeveloperRequestRow {
  readonly id: string;
  readonly nodeId: string;
  readonly agentUserId: string;
  readonly agentDisplayName: string | null;
  readonly scope: NodeDeveloperRequestScope;
  readonly status: NodeDeveloperRequestStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Idempotently open a pending request for one (node, agent). Re-requesting reopens the single row
 * to `pending` rather than inserting a duplicate.
 */
export async function upsertDeveloperRequest(
  db: Database,
  input: {
    readonly nodeId: string;
    readonly agentUserId: string;
    readonly scope: NodeDeveloperRequestScope;
  }
): Promise<void> {
  await db
    .insert(nodeDeveloperRequests)
    .values({
      nodeId: input.nodeId,
      agentUserId: input.agentUserId,
      scope: input.scope,
      status: "pending",
    })
    .onConflictDoUpdate({
      target: [nodeDeveloperRequests.nodeId, nodeDeveloperRequests.agentUserId],
      set: { status: "pending", scope: input.scope, updatedAt: sql`now()` },
    });
}

/**
 * Reflect an owner decision into the tracking row when one exists. Approve → `approved`; reject →
 * `revoked` if currently approved else `denied`. No-op when the agent never filed a request row
 * (e.g. a legacy direct approval) — the tuple write remains the authority either way.
 */
export async function transitionDeveloperRequestOnDecision(
  db: Database,
  input: {
    readonly nodeId: string;
    readonly agentUserId: string;
    readonly decision: "approve" | "reject";
  }
): Promise<void> {
  const nextStatus =
    input.decision === "approve"
      ? sql`'approved'`
      : sql`CASE WHEN ${nodeDeveloperRequests.status} = 'approved' THEN 'revoked' ELSE 'denied' END`;
  await db
    .update(nodeDeveloperRequests)
    .set({ status: nextStatus, updatedAt: sql`now()` })
    .where(
      and(
        eq(nodeDeveloperRequests.nodeId, input.nodeId),
        eq(nodeDeveloperRequests.agentUserId, input.agentUserId)
      )
    );
}

/** All request rows for one node, newest activity first, with the agent's display name. */
export async function listDeveloperRequests(
  db: Database,
  nodeId: string
): Promise<DeveloperRequestRow[]> {
  const rows = await db
    .select({
      id: nodeDeveloperRequests.id,
      nodeId: nodeDeveloperRequests.nodeId,
      agentUserId: nodeDeveloperRequests.agentUserId,
      agentDisplayName: users.name,
      scope: nodeDeveloperRequests.scope,
      status: nodeDeveloperRequests.status,
      createdAt: nodeDeveloperRequests.createdAt,
      updatedAt: nodeDeveloperRequests.updatedAt,
    })
    .from(nodeDeveloperRequests)
    .leftJoin(users, eq(users.id, nodeDeveloperRequests.agentUserId))
    .where(eq(nodeDeveloperRequests.nodeId, nodeId))
    .orderBy(desc(nodeDeveloperRequests.updatedAt));

  return rows.map((row) => ({
    ...row,
    scope: row.scope as NodeDeveloperRequestScope,
    status: row.status as NodeDeveloperRequestStatus,
  }));
}
