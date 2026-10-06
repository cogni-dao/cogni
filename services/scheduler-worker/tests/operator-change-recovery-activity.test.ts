// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker/tests/operator-change-recovery-activity.test`
 * Purpose: Prove the thin Activity uses a stable business key and preserves retry semantics.
 * Scope: Port-stubbed unit tests only. Does not perform HTTP, GitHub, or Temporal service I/O.
 * Invariants:
 *   - Same losing head always delegates with the same owner/repo/head key.
 *   - Retryable/ambiguous errors bubble; permanent errors fail non-retryably.
 *   - Invalid SINGLE_INPUT payloads never reach the port.
 * Side-effects: none
 * Links: task.5188, services/scheduler-worker/src/activities/operator-change-recovery.ts
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOperatorChangeRecoveryActivities } from "../src/activities/operator-change-recovery.js";
import { RunHttpClientError } from "../src/ports/index.js";

const { nonRetryable } = vi.hoisted(() => ({
  nonRetryable: vi.fn((message: string, type: string, details?: unknown) =>
    Object.assign(new Error(message), {
      type,
      details,
      nonRetryable: true,
    })
  ),
}));

vi.mock("@temporalio/activity", () => ({
  ApplicationFailure: { nonRetryable },
}));

const request = {
  owner: "Cogni-Test-Org",
  repo: "Cogni-Monorepo",
  prNumber: 68,
  signedBaseSha: "a".repeat(40),
  losingHeadSha: "b".repeat(40),
  intent: {
    operation: "deployment.declare" as const,
    node: "red",
    recoveryRootSha: "b".repeat(40),
    recoveryDepth: 0,
  },
};

beforeEach(() => {
  nonRetryable.mockClear();
});

describe("recoverOperatorChangeActivity", () => {
  it("delegates once with the stable case-normalized business key", async () => {
    const recoveryClient = {
      recover: vi.fn().mockResolvedValue({
        status: "landed" as const,
        mainSha: request.losingHeadSha,
      }),
    };
    const { recoverOperatorChangeActivity } =
      createOperatorChangeRecoveryActivities({ recoveryClient });

    await expect(recoverOperatorChangeActivity(request)).resolves.toEqual({
      status: "landed",
      mainSha: request.losingHeadSha,
    });
    expect(recoveryClient.recover).toHaveBeenCalledTimes(1);
    expect(recoveryClient.recover).toHaveBeenCalledWith(
      request,
      `cogni-test-org/cogni-monorepo/${request.losingHeadSha}`
    );
  });

  it("bubbles retryable or ambiguous transport errors", async () => {
    const retryable = new RunHttpClientError("timeout", 0, true);
    const recoveryClient = {
      recover: vi.fn().mockRejectedValue(retryable),
    };
    const { recoverOperatorChangeActivity } =
      createOperatorChangeRecoveryActivities({ recoveryClient });
    await expect(recoverOperatorChangeActivity(request)).rejects.toBe(
      retryable
    );
    expect(nonRetryable).not.toHaveBeenCalled();
  });

  it("maps permanent HTTP failures to non-retryable Temporal failures", async () => {
    const recoveryClient = {
      recover: vi
        .fn()
        .mockRejectedValue(new RunHttpClientError("forbidden", 403, false)),
    };
    const { recoverOperatorChangeActivity } =
      createOperatorChangeRecoveryActivities({ recoveryClient });
    const error = await recoverOperatorChangeActivity(request).catch(
      (caught: unknown) => caught
    );
    expect(error).toMatchObject({
      type: "OperatorChangeRecoveryHttpClientError",
      nonRetryable: true,
      details: { status: 403 },
    });
  });

  it("rejects unknown SINGLE_INPUT fields before delegation", async () => {
    const recoveryClient = { recover: vi.fn() };
    const { recoverOperatorChangeActivity } =
      createOperatorChangeRecoveryActivities({ recoveryClient });
    const error = await recoverOperatorChangeActivity({
      ...request,
      attempt: 2,
    } as typeof request).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      type: "InvalidRecoveryInput",
      nonRetryable: true,
    });
    expect(recoveryClient.recover).not.toHaveBeenCalled();
  });
});
