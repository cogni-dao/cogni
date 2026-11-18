// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/graph-transport-recovery.test`
 * Purpose: Verifies bounded graph retries, isolated node-task policy, and definitive terminal failure classification.
 * Scope: Covers pure Temporal configuration and failure policy; does not start a Worker or server.
 * Invariants: TRANSPORT_UNCERTAINTY_IS_INCOMPLETE, ACTIVITY_IDEMPOTENCY.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/scheduled-run-grant-contract, https://cognidao.org/knowledge/temporal-workflow-rules, bug.5447.
 * @internal
 */

import { ActivityFailure, ApplicationFailure } from "@temporalio/workflow";
import { describe, expect, it } from "vitest";

import {
  GRAPH_EXECUTION_ACTIVITY_OPTIONS,
  NODE_TASK_DISPATCH_ACTIVITY_OPTIONS,
} from "../src/activity-profiles.js";
import {
  graphActivityFailureStatus,
  isDefinitiveGraphActivityFailure,
  isUnknownInstanceFailure,
} from "../src/workflows/graph-run.workflow.js";

type ActivityRetryState = ConstructorParameters<typeof ActivityFailure>[3];

function activityFailure(
  cause: Error,
  retryState: ActivityRetryState
): ActivityFailure {
  return new ActivityFailure(
    "Graph Activity failed",
    "executeGraphActivity",
    "activity-id",
    retryState,
    "worker-id",
    cause
  );
}

describe("graph execution transport policy", () => {
  it("bounds graph transport attempts inside one durable retry budget", () => {
    expect(GRAPH_EXECUTION_ACTIVITY_OPTIONS).toMatchObject({
      startToCloseTimeout: "2 minutes",
      scheduleToCloseTimeout: "20 minutes",
      retry: {
        initialInterval: "2 seconds",
        maximumInterval: "30 seconds",
        backoffCoefficient: 2,
      },
    });
  });

  it("does not enable retries for generic node-task receivers", () => {
    expect(NODE_TASK_DISPATCH_ACTIVITY_OPTIONS).toEqual({
      startToCloseTimeout: "15 minutes",
      retry: { maximumAttempts: 1 },
    });
  });

  it("allows a permanent request rejection to finalize the graph", () => {
    const failure = activityFailure(
      ApplicationFailure.nonRetryable(
        "Graph request rejected",
        "GRAPH_REQUEST_REJECTED"
      ),
      "NON_RETRYABLE_FAILURE"
    );

    expect(isDefinitiveGraphActivityFailure(failure)).toBe(true);
    expect(graphActivityFailureStatus(true, failure)).toBe("error");
  });

  it("classifies exhausted transport failure as non-definitive", () => {
    const failure = activityFailure(
      ApplicationFailure.retryable(
        "Origin disconnected",
        "GRAPH_TRANSPORT_HTTP"
      ),
      "MAXIMUM_ATTEMPTS_REACHED"
    );

    expect(isDefinitiveGraphActivityFailure(failure)).toBe(false);
    expect(graphActivityFailureStatus(true, failure)).toBe("timeout");
  });

  it("classifies schedule-to-close timeout as non-definitive", () => {
    const failure = activityFailure(
      new Error("Activity schedule-to-close timeout"),
      "TIMEOUT"
    );

    expect(isDefinitiveGraphActivityFailure(failure)).toBe(false);
    expect(graphActivityFailureStatus(true, failure)).toBe("timeout");
  });

  it("recognizes an unresolvable instance so it is not recorded as an invalid grant (story.5159)", () => {
    const unknownInstance = activityFailure(
      ApplicationFailure.nonRetryable("no such instance", "UNKNOWN_INSTANCE"),
      "NON_RETRYABLE_FAILURE"
    );
    const invalidGrant = activityFailure(
      ApplicationFailure.nonRetryable("grant expired", "grant_expired"),
      "NON_RETRYABLE_FAILURE"
    );
    expect(isUnknownInstanceFailure(unknownInstance)).toBe(true);
    expect(isUnknownInstanceFailure(invalidGrant)).toBe(false);
    expect(isUnknownInstanceFailure(new Error("network"))).toBe(false);
  });

  it("preserves legacy workflow failure behavior for replay", () => {
    expect(graphActivityFailureStatus(false, new Error("network"))).toBe(
      "error"
    );
  });
});
