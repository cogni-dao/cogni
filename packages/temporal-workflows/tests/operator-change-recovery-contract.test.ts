// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/tests/operator-change-recovery-contract.test`
 * Purpose: Prove strict operator-change recovery input and stable Temporal identities.
 * Scope: Pure contract tests only. Does not use Temporal runtime, HTTP, GitHub, or local infrastructure.
 * Invariants:
 *   - All five semantic intents validate while unknown fields fail closed.
 *   - Workflow and Activity identities remain stable across delivery retries.
 *   - Activity transport retry remains capped at three.
 * Side-effects: none
 * Links: task.5188, packages/temporal-workflows/src/workflows/operator-change-recovery.schema.ts
 * @internal
 */

import { OperatorChangeRecoveryResultSchema } from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";
import {
  OPERATOR_CHANGE_RECOVERY_ACTIVITY_OPTIONS,
  OperatorChangeRecoveryWorkflowInputSchema,
  operatorChangeRecoveryIdempotencyKey,
  operatorChangeRecoveryWorkflowId,
} from "../src/index.js";

const request = {
  owner: "cogni-test-org",
  repo: "cogni-monorepo",
  prNumber: 68,
  signedBaseSha: "a".repeat(40),
  losingHeadSha: "b".repeat(40),
  intent: {
    operation: "env.membership" as const,
    node: "red",
    recoveryRootSha: "b".repeat(40),
    recoveryDepth: 0,
    environment: "candidate-a" as const,
    action: "add" as const,
    leaseGeneration: 7,
  },
};

describe("operator-change recovery contract", () => {
  it("accepts the canonical strict SINGLE_INPUT request", () => {
    expect(OperatorChangeRecoveryWorkflowInputSchema.parse(request)).toEqual(
      request
    );
  });

  it("rejects unknown request and intent fields", () => {
    expect(
      OperatorChangeRecoveryWorkflowInputSchema.safeParse({
        ...request,
        expectedHeadSha: request.losingHeadSha,
      }).success
    ).toBe(false);
    expect(
      OperatorChangeRecoveryWorkflowInputSchema.safeParse({
        ...request,
        intent: { ...request.intent, attempt: 2 },
      }).success
    ).toBe(false);
  });

  it("rejects semantic depth above three", () => {
    expect(
      OperatorChangeRecoveryWorkflowInputSchema.safeParse({
        ...request,
        intent: { ...request.intent, recoveryDepth: 4 },
      }).success
    ).toBe(false);
  });

  it("binds a depth-zero recovery root to the exact losing head", () => {
    expect(
      OperatorChangeRecoveryWorkflowInputSchema.safeParse({
        ...request,
        intent: {
          ...request.intent,
          recoveryRootSha: "c".repeat(40),
        },
      }).success
    ).toBe(false);
  });

  it.each([
    {
      operation: "env.placement",
      node: "red",
      recoveryRootSha: "b".repeat(40),
      recoveryDepth: 0,
      environment: "preview",
      provider: "akash",
    },
    {
      operation: "env.region",
      node: "red",
      recoveryRootSha: "b".repeat(40),
      recoveryDepth: 1,
      environment: "production",
      countries: ["US", "CA"],
      leaseGeneration: 8,
    },
    {
      operation: "node.register",
      node: "red",
      recoveryRootSha: "b".repeat(40),
      recoveryDepth: 0,
      nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
      sourceRepo: "https://github.com/cogni-test-org/red.git",
      sourceSha: "c".repeat(40),
      ownerWallet: `0x${"d".repeat(40)}`,
    },
    {
      operation: "deployment.declare",
      node: "red",
      recoveryRootSha: "b".repeat(40),
      recoveryDepth: 3,
    },
  ])("accepts the $operation intent variant", (intent) => {
    expect(
      OperatorChangeRecoveryWorkflowInputSchema.safeParse({
        ...request,
        intent,
      }).success
    ).toBe(true);
  });

  it("builds case-normalized stable workflow and idempotency identities", () => {
    const identity = {
      owner: "Cogni-Test-Org",
      repo: "Cogni-Monorepo",
      losingHeadSha: request.losingHeadSha,
    };
    expect(operatorChangeRecoveryIdempotencyKey(identity)).toBe(
      `cogni-test-org/cogni-monorepo/${request.losingHeadSha}`
    );
    expect(operatorChangeRecoveryWorkflowId(identity)).toBe(
      `operator-change-recovery:cogni-test-org/cogni-monorepo:${request.losingHeadSha}`
    );
  });

  it("caps the one Activity's transport retry at three", () => {
    expect(
      OPERATOR_CHANGE_RECOVERY_ACTIVITY_OPTIONS.retry.maximumAttempts
    ).toBe(3);
  });

  it("accepts semantic 200 results and rejects extra result fields", () => {
    expect(
      OperatorChangeRecoveryResultSchema.parse({
        status: "satisfied",
        reason: "main_equals_losing_head",
        mainSha: request.losingHeadSha,
      })
    ).toEqual({
      status: "satisfied",
      reason: "main_equals_losing_head",
      mainSha: request.losingHeadSha,
    });
    expect(
      OperatorChangeRecoveryResultSchema.safeParse({
        status: "terminal",
        reason: "edited_head",
        retryable: true,
      }).success
    ).toBe(false);
  });
});
