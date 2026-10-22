// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/node-admin-gate`
 * Purpose: The ONE node-admin check for the DAO-goal privileges (task.5286, dao-goals-design):
 *   starting a goal, merging a `goal-*` hub change, and setting work-item priority 1 or higher
 *   (any value <= 1). Each is an OpenFGA `node.administer` check on THIS node, run before the
 *   side effect.
 * Scope: Pure helper over an injected AuthorizationPort. Returns a typed decision; callers own the
 *   HTTP body, logging and error mapping. No second authority, no new role, no model change.
 * Invariants:
 *   - GOAL_CHANGE_IS_NODE_ADMIN / P0P1_IS_NODE_ADMIN: the relation is the existing `admin`
 *     (`relationForAuthzAction("node.administer")`) on `node:<nodeId>`.
 *   - CHECK_BEFORE_SIDE_EFFECT: callers run this before any write.
 *   - FAIL_CLOSED_WITH_DISTINCTION: deny → 403 `authz_denied`; no adapter, a missing actor, an
 *     adapter-reported outage or a thrown check → 503 `authz_unavailable`. Never conflated. A
 *     thrown check keeps its message in `reason`.
 *   - P0P1_IS_NODE_ADMIN covers every priority <= 1, so a negative value cannot outrank p0
 *     without the same check (task.5294). The HTTP contracts also bound priority to 0..99.
 *   - MERGE_AUTHORIZED_ON_RAW_ROWS: `createGoalMergeAuthorizer` is the ContributionService
 *     `authorizeMerge` hook; it gates on the RAW changed row ids (`touchedGoalIds`) and logs
 *     every deny with errorCode, reason and actor.
 * Side-effects: IO (one OpenFGA check via the injected port)
 * Links: docs/spec/rbac.md, src/app/_lib/node-rbac.ts, task.5286
 * @public
 */

import {
  type AuthorizationPort,
  authzNodeResource,
} from "@cogni/authorization-core";
import {
  type AuthorizeMerge,
  ContributionMergeDeniedError,
  touchedGoalIds,
} from "@cogni/knowledge-store";

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

/**
 * Any priority <= 1 is the node-admin tier (P0P1_IS_NODE_ADMIN). A value below 0 would sort
 * above every p0, so it is privileged too; 2+ stays open.
 */
export function isPrivilegedPriority(
  priority: number | null | undefined
): boolean {
  return typeof priority === "number" && !(priority > 1);
}

/** PRIORITY_RANGE: an integer 0..99 (0 = highest) — the same bound as the HTTP contracts. */
export function isPriorityInRange(priority: number): boolean {
  return Number.isInteger(priority) && priority >= 0 && priority <= 99;
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return nodeAdminUnavailable(`check_threw: ${message}`);
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

/** The action name a goal-merge refusal reports. */
export const GOAL_MERGE_ACTION = "knowledge.contributions.merge.goal";

/**
 * GOAL_CHANGE_IS_NODE_ADMIN as the ContributionService `authorizeMerge` hook. A merge whose RAW
 * changed rows touch a `goal-*` row (or a citation leaving one) needs `node.administer` on this
 * node; every other merge passes without consulting authorization. Denies are logged, then thrown
 * as `ContributionMergeDeniedError`, so no merge write runs.
 * `authorization` is a getter because the container builds the knowledge service first.
 */
export function createGoalMergeAuthorizer(deps: {
  readonly authorization: () => AuthorizationPort | undefined;
  readonly nodeId: string;
  readonly log: { warn(obj: object, msg: string): void };
}): AuthorizeMerge {
  return async ({ principal, contributionId, changes }) => {
    const goalIds = touchedGoalIds(changes);
    if (goalIds.length === 0) return;
    const gate = await checkNodeAdmin(deps.authorization(), {
      userId: principal.id,
      nodeId: deps.nodeId,
    });
    if (gate.ok) return;
    const reason =
      gate.errorCode === "authz_unavailable" ? gate.reason : "not_node_admin";
    deps.log.warn(
      {
        event: "knowledge.contributions.merge.goal_denied",
        errorCode: gate.errorCode,
        reason,
        actor: principal.id,
        actorKind: principal.kind,
        contributionId,
        goalIds,
        headCommit: changes.headCommit,
      },
      "knowledge.contributions.merge.goal_denied"
    );
    throw new ContributionMergeDeniedError(
      gate.errorCode,
      GOAL_MERGE_ACTION,
      gate.errorCode === "authz_unavailable" ? gate.reason : undefined
    );
  };
}
