// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/workflows/operator-change-recovery.schema`
 * Purpose: Single input contract and stable identity helpers for durable operator-change recovery.
 * Scope: Pure schema alias and deterministic string helpers only. Does not perform I/O.
 * Invariants:
 *   - SINGLE_INPUT_CONTRACT: the strict node-contract request schema is the one wire definition.
 *   - WORKFLOW_ID_STABILITY: one workflow exists per owner/repo/losing head.
 *   - ACTIVITY_IDEMPOTENCY: retries use the same external-write business key; no attempt number.
 * Side-effects: none
 * Links: task.5188, docs/spec/temporal-patterns.md
 * @public
 */

import {
  type OperatorChangeRecoveryRequest,
  OperatorChangeRecoveryRequestSchema,
} from "@cogni/node-contracts";

/** Exact strict schema shared with the operator-internal HTTP route. */
export const OperatorChangeRecoveryWorkflowInputSchema =
  OperatorChangeRecoveryRequestSchema;

export type OperatorChangeRecoveryWorkflowInput = OperatorChangeRecoveryRequest;

type RecoveryIdentity = Pick<
  OperatorChangeRecoveryRequest,
  "owner" | "repo" | "losingHeadSha"
>;

/** Stable external-write key. GitHub owner/repository identity is case-insensitive. */
export function operatorChangeRecoveryIdempotencyKey(
  input: RecoveryIdentity
): string {
  return `${input.owner.toLowerCase()}/${input.repo.toLowerCase()}/${input.losingHeadSha}`;
}

/** Stable workflow ID: duplicate webhook wakes converge on one execution. */
export function operatorChangeRecoveryWorkflowId(
  input: RecoveryIdentity
): string {
  return `operator-change-recovery:${operatorChangeRecoveryIdempotencyKey(input)}`;
}
