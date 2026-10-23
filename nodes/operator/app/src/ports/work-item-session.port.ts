// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/work-item-session`
 * Purpose: Port for operator-local work-item execution session persistence.
 * Scope: Interface and DTO types only. Does not contain policy or I/O.
 * Invariants: PORTS_DEFINE_NEEDS — adapters implement persistence, features
 *   derive next-action policy, routes own HTTP translation.
 *   EXACTLY_ONE_CLAIMANT — a session is claimed by a human `users.id` or by a
 *   durable agent principal id, never both; agents are never projected into users.
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

/** Exactly one claimant: a human user id or a durable agent principal id. */
export type WorkItemSessionClaimant =
  | {
      readonly claimedByUserId: string;
      readonly claimedByPrincipalId?: never;
    }
  | {
      readonly claimedByPrincipalId: string;
      readonly claimedByUserId?: never;
    };

export type WorkItemSessionRecord = {
  readonly id: string;
  readonly workItemId: string;
  readonly claimedByUserId: string | null;
  readonly claimedByPrincipalId: string | null;
  readonly claimedByDisplayName: string | null;
  readonly status: WorkItemSessionStatus;
  readonly claimedAt: Date;
  readonly lastHeartbeatAt: Date | null;
  readonly deadlineAt: Date;
  readonly closedAt: Date | null;
  readonly lastCommand: string | null;
  readonly branch: string | null;
  readonly prNumber: number | null;
};

export type ClaimWorkItemSessionResult =
  | { readonly kind: "claimed"; readonly session: WorkItemSessionRecord }
  | { readonly kind: "conflict"; readonly session: WorkItemSessionRecord };

export interface WorkItemSessionPort {
  claim(
    input: WorkItemSessionClaimant & {
      readonly workItemId: string;
      readonly claimedByDisplayName: string | null;
      readonly deadlineAt: Date;
      readonly lastCommand?: string;
    }
  ): Promise<ClaimWorkItemSessionResult>;

  heartbeat(
    input: WorkItemSessionClaimant & {
      readonly workItemId: string;
      readonly deadlineAt: Date;
      readonly lastCommand?: string;
    }
  ): Promise<WorkItemSessionRecord | null>;

  linkPr(
    input: WorkItemSessionClaimant & {
      readonly workItemId: string;
      readonly branch?: string;
      readonly prNumber?: number;
    }
  ): Promise<WorkItemSessionRecord | null>;

  getCurrent(workItemId: string): Promise<WorkItemSessionRecord | null>;
}
