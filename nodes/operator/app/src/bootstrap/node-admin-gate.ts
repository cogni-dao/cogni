// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/node-admin-gate`
 * Purpose: The ONE node-admin check for the DAO-goal privileges (task.5286, dao-goals-design):
 *   starting a goal, merging a `goal-*` hub change, and setting work-item priority 0/1. Each is an
 *   OpenFGA `node.administer` check on THIS node, run before the side effect.
 * Scope: Pure helper over an injected AuthorizationPort. Returns a typed decision; callers own the
 *   HTTP body, logging and error mapping. No second authority, no new role, no model change.
 * Invariants:
 *   - GOAL_CHANGE_IS_NODE_ADMIN / P0P1_IS_NODE_ADMIN: the relation is the existing `admin`
 *     (`relationForAuthzAction("node.administer")`) on `node:<nodeId>`.
 *   - CHECK_BEFORE_SIDE_EFFECT: callers run this before any write.
 *   - FAIL_CLOSED_WITH_DISTINCTION: deny → 403 `authz_denied`; no adapter, a missing actor, an
 *     adapter-reported outage or a thrown check → 503 `authz_unavailable`. Never conflated.
 * Side-effects: IO (one OpenFGA check via the injected port)
 * Links: docs/spec/rbac.md, src/app/_lib/node-rbac.ts, task.5286
 * @public
 */

import {
  type AuthorizationPort,
  authzNodeResource,
} from "@cogni/authorization-core";

export type NodeAdminDenied = {
  readonly ok: false;
  readonly status: 403;
  readonly errorCode: "authz_denied";
};

export type NodeAdminUnavailable = {
  readonly ok: false;
  readonly status: 503;
  readonly errorCode: "authz_unavailable";
  readonly reason: string;
};

export type NodeAdminGate =
  | { readonly ok: true }
  | NodeAdminDenied
  | NodeAdminUnavailable;

const DENIED: NodeAdminDenied = {
  ok: false,
  status: 403,
  errorCode: "authz_denied",
};

export function nodeAdminUnavailable(reason: string): NodeAdminUnavailable {
  return { ok: false, status: 503, errorCode: "authz_unavailable", reason };
}

/** Priority 0 and 1 are the node-admin tier (P0P1_IS_NODE_ADMIN); 2+ stays open. */
export function isPrivilegedPriority(priority: number | null | undefined) {
  return priority === 0 || priority === 1;
}

/** A hub row id in the goal namespace (GOAL_CHANGE_IS_NODE_ADMIN). */
export function isGoalRowId(rowId: unknown): boolean {
  return typeof rowId === "string" && rowId.startsWith("goal-");
}

/**
 * Check that `userId` holds `node.administer` on `nodeId`.
 * `userId` is the bare user id (agents register as users); the actor is `user:<userId>`.
 */
export async function checkNodeAdmin(
  authorization: AuthorizationPort | undefined,
  input: { readonly userId: string | undefined; readonly nodeId: string }
): Promise<NodeAdminGate> {
  if (!authorization) return nodeAdminUnavailable("no_authz_adapter");
  if (!input.userId) return nodeAdminUnavailable("missing_actor");

  let decision: Awaited<ReturnType<AuthorizationPort["check"]>>;
  try {
    decision = await authorization.check({
      actorId: `user:${input.userId}`,
      action: "node.administer",
      resource: authzNodeResource(input.nodeId),
      context: { tenantId: input.nodeId, nodeId: input.nodeId },
    });
  } catch {
    return nodeAdminUnavailable("check_threw");
  }

  if (decision.decision === "allow") return { ok: true };
  return decision.code === "authz_unavailable"
    ? nodeAdminUnavailable(decision.reason ?? "authz_unavailable")
    : DENIED;
}

/** JSON body for a failed gate — the same vocabulary as the other node-scoped routes. */
export function nodeAdminFailureBody(
  gate: NodeAdminDenied | NodeAdminUnavailable,
  action: string
): { error: string; errorCode: string; action: string } {
  return gate.errorCode === "authz_denied"
    ? { error: "not authorized", errorCode: gate.errorCode, action }
    : {
        error: "authorization unavailable",
        errorCode: gate.errorCode,
        action,
      };
}
