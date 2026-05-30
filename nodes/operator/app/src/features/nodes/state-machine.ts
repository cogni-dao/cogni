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
  | { type: "wallet_provisioned" }
  | { type: "split_deployed" }
  | { type: "spec_published" }
  | { type: "fail"; reason: string };

export type TransitionResult =
  | { ok: true; nextStatus: NodeStatus }
  | { ok: false; reason: string };

const TRANSITIONS: Record<
  NodeStatus,
  Partial<Record<NodeEvent["type"], NodeStatus>>
> = {
  dao_pending: { dao_verified: "dao_formed", fail: "failed" },
  dao_formed: { wallet_provisioned: "wallet_ready", fail: "failed" },
  wallet_ready: { split_deployed: "payments_ready", fail: "failed" },
  payments_ready: { spec_published: "active", fail: "failed" },
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
 * Returns the canonical wizard URL for a node at its current status — used by
 * page-level `redirect()` calls so reload always lands at the right step.
 */
export function wizardUrlForStatus(nodeId: string, status: NodeStatus): string {
  switch (status) {
    case "dao_pending":
      return `/setup/dao?nodeId=${nodeId}`;
    case "dao_formed":
      return `/setup/nodes/${nodeId}/wallet`;
    case "wallet_ready":
      return `/setup/dao/payments?nodeId=${nodeId}`;
    case "payments_ready":
      return `/setup/nodes/${nodeId}/publish`;
    case "active":
    case "failed":
      return `/setup/nodes/${nodeId}`;
  }
}
