// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/work-item-session`
 * Purpose: Port for operator-local work-item execution session persistence.
 * Scope: Interface and DTO types only. Does not contain policy or I/O.
 * Invariants: PORTS_DEFINE_NEEDS — adapters implement persistence, features
 *   derive next-action policy, routes own HTTP translation.
 * Side-effects: none
 * Links: docs/design/operator-dev-lifecycle-coordinator.md, task.5007
 * @public
 */

export type WorkItemSessionStatus =
  | "active"
  | "idle"
  | "stale"
  | "closed"
  | "superseded";

export type WorkItemSessionRecord = {
  readonly id: string;
  readonly workItemId: string;
  readonly claimedByUserId: string;
  readonly claimedByDisplayName: string | null;
  readonly status: WorkItemSessionStatus;
  readonly claimedAt: Date;
  readonly lastHeartbeatAt: Date | null;
  readonly deadlineAt: Date;
  readonly closedAt: Date | null;
  readonly lastCommand: string | null;
  readonly branch: string | null;
  readonly prNumber: number | null;
  readonly repoFullName: string | null;
};

export type ClaimWorkItemSessionResult =
  | { readonly kind: "claimed"; readonly session: WorkItemSessionRecord }
  | { readonly kind: "conflict"; readonly session: WorkItemSessionRecord };

export interface WorkItemSessionPort {
  claim(input: {
    readonly workItemId: string;
    readonly claimedByUserId: string;
    readonly claimedByDisplayName: string | null;
    readonly deadlineAt: Date;
    readonly lastCommand?: string;
  }): Promise<ClaimWorkItemSessionResult>;

  heartbeat(input: {
    readonly workItemId: string;
    readonly claimedByUserId: string;
    readonly deadlineAt: Date;
    readonly lastCommand?: string;
  }): Promise<WorkItemSessionRecord | null>;

  linkPr(input: {
    readonly workItemId: string;
    readonly claimedByUserId: string;
    readonly branch?: string;
    readonly prNumber?: number;
    readonly repoFullName?: string;
  }): Promise<WorkItemSessionRecord | null>;

  getCurrent(workItemId: string): Promise<WorkItemSessionRecord | null>;

  /**
   * Look up the single open (`active` or `idle`) session bound to a given
   * `(repoFullName, prNumber)`. Returns null when no open session matches.
   * Backed by the partial unique index `work_item_sessions_one_session_per_pr_idx`.
   */
  lookupActiveByPr(input: {
    readonly repoFullName: string;
    readonly prNumber: number;
  }): Promise<WorkItemSessionRecord | null>;
}
