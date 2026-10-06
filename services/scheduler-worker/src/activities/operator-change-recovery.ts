// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/activities/operator-change-recovery`
 * Purpose: Thin Temporal Activity for durable operator-generated change recovery.
 * Scope: Validates input and delegates through a port. Does not call GitHub or contain recovery policy.
 * Invariants:
 *   - The external-write Idempotency-Key derives only from owner/repo/losing head.
 *   - Permanent HTTP/input errors become non-retryable Temporal failures.
 *   - Retryable or ambiguous transport errors bubble for the workflow's maximum-three retry policy.
 * Side-effects: HTTP I/O through OperatorChangeRecoveryHttpClient
 * Links: task.5188, docs/spec/temporal-patterns.md
 * @internal
 */

import {
  type OperatorChangeRecoveryRequest,
  type OperatorChangeRecoveryResult,
  OperatorChangeRecoveryRequestSchema,
} from "@cogni/node-contracts";
import { operatorChangeRecoveryIdempotencyKey } from "@cogni/temporal-workflows";
import { ApplicationFailure } from "@temporalio/activity";
import {
  type OperatorChangeRecoveryHttpClient,
  RunHttpClientError,
} from "../ports/index.js";

export interface OperatorChangeRecoveryActivityDeps {
  recoveryClient: OperatorChangeRecoveryHttpClient;
}

export function createOperatorChangeRecoveryActivities(
  deps: OperatorChangeRecoveryActivityDeps
) {
  async function recoverOperatorChangeActivity(
    rawInput: OperatorChangeRecoveryRequest
  ): Promise<OperatorChangeRecoveryResult> {
    const parsed = OperatorChangeRecoveryRequestSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw ApplicationFailure.nonRetryable(
        "recoverOperatorChangeActivity: invalid strict recovery input",
        "InvalidRecoveryInput"
      );
    }

    const idempotencyKey = operatorChangeRecoveryIdempotencyKey(parsed.data);
    try {
      return await deps.recoveryClient.recover(parsed.data, idempotencyKey);
    } catch (error) {
      if (error instanceof RunHttpClientError && !error.retryable) {
        throw ApplicationFailure.nonRetryable(
          `recoverOperatorChangeActivity: ${error.message}`,
          "OperatorChangeRecoveryHttpClientError",
          { status: error.status }
        );
      }
      throw error;
    }
  }

  return { recoverOperatorChangeActivity };
}

export type OperatorChangeRecoveryActivities = ReturnType<
  typeof createOperatorChangeRecoveryActivities
>;
