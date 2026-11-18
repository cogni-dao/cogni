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

/** What the approver reader learned about one node, already mapped from wallets to env-local user ids. */
export type NodeApproverRead =
  | { readonly status: "unavailable" }
  | {
      readonly status: "read";
      /** Approver wallets listed in the repo-spec (0 when the list is empty or malformed). */
      readonly approverCount: number;
      /** Env-local user ids the approver wallets map to (may be fewer than `approverCount`). */
      readonly userIds: readonly string[];
    };

export interface NodeAdminPlan {
  readonly outcome: NodeAdminSyncOutcome;
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
  if (resulting.size === 0) return { outcome: "refused", ...NO_WRITES };

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
  if (approvers.status === "unavailable" || currentUserIds === null) {
    return { outcome: "unavailable", ...NO_WRITES };
  }
  const target = [...new Set(approvers.userIds.filter((id) => id.length > 0))];
  if (approvers.approverCount === 0 || target.length === 0) {
    return { outcome: "empty", ...NO_WRITES };
  }
  return planAdminDiff(currentUserIds, target);
}
