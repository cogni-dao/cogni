// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-registry/node-admin-sync`
 * Purpose: Pure decision core of the node-admin sync: from one node's repo-spec approvers and its current
 *   OpenFGA `node:<id>#admin` holders, decide the outcome and the add/delete diff.
 * Scope: Pure functions over user-id sets. No IO, no env, no logging, no wallet handling.
 * Invariants:
 *   - NEVER_DELETE_ON_DOUBT: an unreadable repo-spec, an unreadable current-tuple list, an empty or
 *     malformed approver list, and an approver list that maps to zero users all plan NO writes.
 *   - NEVER_ZERO_ADMINS: a diff whose result leaves zero admins is `refused`, never applied.
 *   - DIFF_ONLY: only the difference between the target set and the current set is planned.
 *   - SUBJECTS_ARE_USERS: only `user:<id>` holders are managed; any other subject form is left alone.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/operator-identity-model (One admin answer per node), task.5494
 * @public
 */

export type NodeAdminSyncOutcome = "ok" | "unavailable" | "empty" | "refused";

/**
 * Closed enum of why a node's sync is not `ok`. Carried on every non-ok `identity.node_admin_sync`
 * event so an operator can tell a missing App install from a timeout from an OpenFGA outage.
 */
export const NODE_ADMIN_SYNC_REASONS = [
  "no_app_installation",
  "timeout",
  "not_found",
  "user_lookup_failed",
  "openfga_read_failed",
  "openfga_write_failed",
  "no_approvers",
  "malformed_spec",
  "unmapped_approvers",
  "zero_admins",
  "unexpected",
] as const;

export type NodeAdminSyncReason = (typeof NODE_ADMIN_SYNC_REASONS)[number];

/** What the approver reader learned about one node, already mapped from wallets to env-local user ids. */
export type NodeApproverRead =
  | { readonly status: "unavailable"; readonly reason: NodeAdminSyncReason }
  | {
      readonly status: "read";
      /** Approver wallets listed in the repo-spec (0 when the list is empty or malformed). */
      readonly approverCount: number;
      /** Env-local user ids the approver wallets map to (may be fewer than `approverCount`). */
      readonly userIds: readonly string[];
      /** True when the YAML did not parse or `approvers` is not a list of addresses. */
      readonly malformed?: boolean;
    };

export interface NodeAdminPlan {
  readonly outcome: NodeAdminSyncOutcome;
  /** Why the outcome is not `ok`. Absent when `outcome` is `ok`. */
  readonly reason?: NodeAdminSyncReason;
  /** User ids to grant `admin`. Empty unless `outcome` is `ok`. */
  readonly adds: readonly string[];
  /** User ids to revoke `admin`. Empty unless `outcome` is `ok`. */
  readonly deletes: readonly string[];
}

const NO_WRITES = { adds: [], deletes: [] } as const;

/**
 * Extract the user id from a stored `user:<id>` OpenFGA subject. Returns null for any other subject
 * form (wildcard, userset, agent): the sync neither counts nor deletes those.
 */
export function userIdFromSubject(subject: string): string | null {
  if (!subject.startsWith("user:")) return null;
  const id = subject.slice("user:".length);
  return id.length > 0 && !id.includes("*") && !id.includes("#") ? id : null;
}

/**
 * Diff the target admin set against the current one. The zero-admin guard is evaluated on the
 * RESULT of applying the diff: an apply that would leave nobody holding `admin` is `refused`.
 */
export function planAdminDiff(
  currentUserIds: readonly string[],
  targetUserIds: readonly string[]
): NodeAdminPlan {
  const current = new Set(currentUserIds);
  const target = new Set(targetUserIds);
  const adds = [...target].filter((id) => !current.has(id)).sort();
  const deletes = [...current].filter((id) => !target.has(id)).sort();

  const resulting = new Set([...current, ...adds]);
  for (const id of deletes) resulting.delete(id);
  if (resulting.size === 0) {
    return { outcome: "refused", reason: "zero_admins", ...NO_WRITES };
  }

  return { outcome: "ok", adds, deletes };
}

/**
 * Plan one node's sync.
 * `currentUserIds` is null when the current tuples could not be read (fail closed: plan nothing).
 */
export function planNodeAdminSync(input: {
  readonly approvers: NodeApproverRead;
  readonly currentUserIds: readonly string[] | null;
}): NodeAdminPlan {
  const { approvers, currentUserIds } = input;
  if (approvers.status === "unavailable") {
    return { outcome: "unavailable", reason: approvers.reason, ...NO_WRITES };
  }
  if (currentUserIds === null) {
    return {
      outcome: "unavailable",
      reason: "openfga_read_failed",
      ...NO_WRITES,
    };
  }
  const target = [...new Set(approvers.userIds.filter((id) => id.length > 0))];
  if (approvers.malformed) {
    return { outcome: "empty", reason: "malformed_spec", ...NO_WRITES };
  }
  if (approvers.approverCount === 0) {
    return { outcome: "empty", reason: "no_approvers", ...NO_WRITES };
  }
  if (target.length === 0) {
    return { outcome: "empty", reason: "unmapped_approvers", ...NO_WRITES };
  }
  return planAdminDiff(currentUserIds, target);
}
