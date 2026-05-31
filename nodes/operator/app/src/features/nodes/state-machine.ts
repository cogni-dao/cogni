// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/state-machine`
 * Purpose: Pure state-machine transitions for the operator node-registry wizard.
 * Scope: Total function `(currentStatus, event) → nextStatus | InvalidTransition`. No IO, no env.
 * Invariants: STATE_MACHINE_TOTAL — every (status, event) pair returns a defined result; transitions are linear with a single `fail` escape hatch.
 * Side-effects: none
 * Links: docs/spec/node-formation.md, task.5083
 * @public
 */

import type { NodeStatus } from "@/shared/db/nodes";

export type NodeEvent =
  | { type: "dao_verified" }
  | { type: "spec_published" }
  | { type: "wallet_provisioned" }
  | { type: "payments_configured" }
  | { type: "activation_published" }
  | { type: "fail"; reason: string };

export type TransitionResult =
  | { ok: true; nextStatus: NodeStatus }
  | { ok: false; reason: string };

const TRANSITIONS: Record<
  NodeStatus,
  Partial<Record<NodeEvent["type"], NodeStatus>>
> = {
  dao_pending: { dao_verified: "dao_formed", fail: "failed" },
  dao_formed: { spec_published: "published", fail: "failed" },
  published: { wallet_provisioned: "wallet_ready", fail: "failed" },
  wallet_ready: { payments_configured: "payments_ready", fail: "failed" },
  payments_ready: { activation_published: "active", fail: "failed" },
  active: {},
  failed: {},
};

export function transition(
  current: NodeStatus,
  event: NodeEvent
): TransitionResult {
  const next = TRANSITIONS[current]?.[event.type];
  if (!next) {
    return {
      ok: false,
      reason: `Invalid transition: ${current} cannot handle event ${event.type}`,
    };
  }
  return { ok: true, nextStatus: next };
}

/**
 * Ordered milestones for the visual wizard. `active` is terminal completion of
 * the Payments step, not an extra visible milestone.
 */
export const NODE_PROGRESS_STEPS: ReadonlyArray<{
  label: string;
}> = [
  { label: "Register" },
  { label: "DAO" },
  { label: "Publish" },
  { label: "Wallet" },
  { label: "Payments" },
];

/**
 * Current visual milestone index. A registry row means registration is complete.
 */
export function progressIndexForStatus(status: NodeStatus): number {
  switch (status) {
    case "dao_pending":
      return 1;
    case "dao_formed":
      return 2;
    case "published":
      return 3;
    case "wallet_ready":
      return 4;
    case "payments_ready":
      return 4;
    case "active":
      return 5;
    case "failed":
      return 0;
  }
}

/**
 * Returns the canonical wizard URL for a node at its current status — used by
 * page-level `redirect()` calls so reload always lands at the right step.
 */
export function wizardUrlForStatus(nodeId: string, status: NodeStatus): string {
  switch (status) {
    case "dao_pending":
    case "dao_formed":
    case "published":
    case "wallet_ready":
    case "payments_ready":
    case "active":
    case "failed":
      return `/setup/nodes/${nodeId}`;
  }
}
