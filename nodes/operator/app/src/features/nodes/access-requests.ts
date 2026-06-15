// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/access-requests`
 * Purpose: Service-DB query helpers for node access requests. Used by the agent request route, the
 *   owner decision route, and the owner node page.
 * Scope: Pure data access over `node_access_requests` (+ a `users.name` join for display). Callers
 *   pass a service-role DB and gate ownership/identity at the route/page layer — this table is
 *   RLS-forced with no app_user policy.
 * Invariants: NOT_AUTHORITY (OpenFGA role tuples are the authority), ONE_ROW_PER_AGENT_NODE.
 * Side-effects: IO (Postgres read/write)
 * Links: docs/spec/rbac.md §6
 * @public
 */

import type { Database } from "@cogni/db-client";
import { users } from "@cogni/db-schema/refs";
import { and, desc, eq, sql } from "drizzle-orm";

import {
  type NodeAccessRequestStatus,
  type NodeAccessRole,
  nodeAccessRequests,
} from "@/shared/db/node-access-requests";

export interface NodeAccessRequestRow {
  readonly id: string;
  readonly nodeId: string;
  readonly agentUserId: string;
  readonly agentDisplayName: string | null;
  readonly role: NodeAccessRole;
  readonly status: NodeAccessRequestStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Idempotently open a pending access request for one (node, agent). Re-requesting reopens the
 * single row to `pending` rather than inserting a duplicate.
 */
export async function upsertAccessRequest(
  db: Database,
  input: {
    readonly nodeId: string;
    readonly agentUserId: string;
    readonly role: NodeAccessRole;
  }
): Promise<void> {
  await db
    .insert(nodeAccessRequests)
    .values({
      nodeId: input.nodeId,
      agentUserId: input.agentUserId,
      role: input.role,
      status: "pending",
    })
    .onConflictDoUpdate({
      target: [
        nodeAccessRequests.nodeId,
        nodeAccessRequests.agentUserId,
        nodeAccessRequests.role,
      ],
      set: { status: "pending", updatedAt: sql`now()` },
    });
}

/**
 * Reflect an owner decision into the tracking row when one exists. Approve → `approved`; reject →
 * `revoked` if currently approved else `denied`. No-op when the agent never filed a request row
 * (e.g. a legacy direct approval) — the role tuple write remains the authority either way.
 */
export async function transitionAccessRequestOnDecision(
  db: Database,
  input: {
    readonly nodeId: string;
    readonly agentUserId: string;
    readonly role: NodeAccessRole;
    readonly decision: "approve" | "reject";
  }
): Promise<void> {
  const nextStatus =
    input.decision === "approve"
      ? sql`'approved'`
      : sql`CASE WHEN ${nodeAccessRequests.status} = 'approved' THEN 'revoked' ELSE 'denied' END`;
  await db
    .update(nodeAccessRequests)
    .set({ status: nextStatus, updatedAt: sql`now()` })
    .where(
      and(
        eq(nodeAccessRequests.nodeId, input.nodeId),
        eq(nodeAccessRequests.agentUserId, input.agentUserId),
        eq(nodeAccessRequests.role, input.role)
      )
    );
}

/** All access-request rows for one node, newest activity first, with the agent's display name. */
export async function listAccessRequests(
  db: Database,
  nodeId: string
): Promise<NodeAccessRequestRow[]> {
  const rows = await db
    .select({
      id: nodeAccessRequests.id,
      nodeId: nodeAccessRequests.nodeId,
      agentUserId: nodeAccessRequests.agentUserId,
      agentDisplayName: users.name,
      role: nodeAccessRequests.role,
      status: nodeAccessRequests.status,
      createdAt: nodeAccessRequests.createdAt,
      updatedAt: nodeAccessRequests.updatedAt,
    })
    .from(nodeAccessRequests)
    .leftJoin(users, eq(users.id, nodeAccessRequests.agentUserId))
    .where(eq(nodeAccessRequests.nodeId, nodeId))
    .orderBy(desc(nodeAccessRequests.updatedAt));

  return rows.map((row) => ({
    ...row,
    role: row.role as NodeAccessRole,
    status: row.status as NodeAccessRequestStatus,
  }));
}
