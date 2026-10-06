// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/workflows/operator-change-recovery`
 * Purpose: Durable single-activity orchestration for one operator-generated change recovery.
 * Scope: Deterministic orchestration only. Does not perform I/O; GitHub and HTTP work is delegated to one Activity.
 * Invariants:
 *   - TEMPORAL_DETERMINISM: no I/O, clock, randomness, or GitHub code in the workflow.
 *   - NO_POLLING_LOOP: one Activity call; the regenerated PR wakes the normal webhook path.
 *   - TRANSPORT_RETRY_BOUND: Temporal retries the Activity at most three times.
 * Side-effects: none
 * Links: task.5188, docs/spec/temporal-patterns.md
 * @public
 */

import type { OperatorChangeRecoveryResult } from "@cogni/node-contracts";
import { proxyActivities } from "@temporalio/workflow";
import { OPERATOR_CHANGE_RECOVERY_ACTIVITY_OPTIONS } from "../activity-profiles.js";
import type { OperatorChangeRecoveryActivities } from "../activity-types.js";
import type { OperatorChangeRecoveryWorkflowInput } from "./operator-change-recovery.schema.js";

const { recoverOperatorChangeActivity } =
  proxyActivities<OperatorChangeRecoveryActivities>(
    OPERATOR_CHANGE_RECOVERY_ACTIVITY_OPTIONS
  );

/**
 * Run one idempotent recovery attempt under Temporal's bounded Activity retry.
 * There is deliberately no workflow loop and no stale-byte manipulation here.
 */
export async function OperatorChangeRecoveryWorkflow(
  input: OperatorChangeRecoveryWorkflowInput
): Promise<OperatorChangeRecoveryResult> {
  return recoverOperatorChangeActivity(input);
}
