// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { VcsCapability } from "@cogni/ai-tools";
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
} from "@temporalio/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const temporal = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("@/bootstrap/container", () => ({
  getTemporalWorkflowClient: async () => ({
    client: { start: temporal.start },
    taskQueue: "scheduler-node",
  }),
}));

import { dispatchOperatorChangeAutoMerge } from "./operator-change-auto-merge.server";

const headSha = "a".repeat(40);
const policyHeadSha = "b".repeat(40);
const payload = {
  action: "completed",
  repository: { full_name: "cogni-test-org/cogni-monorepo" },
  check_run: { head_sha: headSha, pull_requests: [{ number: 42 }] },
};
const log = { info: vi.fn() } as never;

const membershipIntent = {
  operation: "env.membership" as const,
  node: "spawny-boi",
  environment: "candidate-a" as const,
  action: "add" as const,
  leaseGeneration: 0,
  recoveryRootSha: headSha,
  recoveryDepth: 0,
};

const registerIntent = {
  operation: "node.register" as const,
  node: "spawny-boi",
  nodeId: "11111111-1111-4111-8111-111111111111",
  sourceRepo: "https://github.com/cogni-test-org/spawny-boi.git",
  sourceSha: "d".repeat(40),
  ownerWallet: `0x${"1".repeat(40)}`,
  recoveryRootSha: headSha,
  recoveryDepth: 0,
};

function vcs(
  eligible: boolean,
  intent: typeof membershipIntent | typeof registerIntent = membershipIntent
) {
  return {
    verifyOperatorChange: vi.fn().mockResolvedValue({
      eligible,
      reason: eligible ? "eligible" : "untrusted-repository",
      headSha,
      baseSha: "b".repeat(40),
      policyHeadSha,
      operation: intent.operation,
      node: intent.node,
      intent,
    }),
    getCiStatus: vi.fn().mockResolvedValue({
      headSha,
      baseSha: "b".repeat(40),
      headParentSha: "b".repeat(40),
      headCommitMessage: `generated\n\nCogni-Base-SHA: ${"b".repeat(40)}`,
      pending: false,
      allGreen: true,
      reviewDecision: null,
      draft: false,
      checks: [
        {
          name: "operator-change-automerge-ready",
          status: "completed",
          conclusion: "success",
        },
      ],
    }),
    fastForwardOperatorChange: vi.fn().mockResolvedValue({
      outcome: "landed",
      sha: headSha,
      message: "Fast-forwarded",
    }),
  } as unknown as VcsCapability;
}

describe("dispatchOperatorChangeAutoMerge", () => {
  beforeEach(() => temporal.start.mockReset());
  it("rejects a forged ready check when operator reclassification fails", async () => {
    const capability = vcs(false);
    await dispatchOperatorChangeAutoMerge(payload, capability, log);
    expect(capability.verifyOperatorChange).toHaveBeenCalledWith({
      owner: "cogni-test-org",
      repo: "cogni-monorepo",
      prNumber: 42,
      expectedHeadSha: headSha,
    });
    expect(capability.fastForwardOperatorChange).not.toHaveBeenCalled();
    expect(temporal.start).not.toHaveBeenCalled();
  });

  it("binds a reverified internal bypass merge to the current expected head", async () => {
    const capability = vcs(true);
    await dispatchOperatorChangeAutoMerge(payload, capability, log);
    expect(capability.fastForwardOperatorChange).toHaveBeenCalledWith({
      owner: "cogni-test-org",
      repo: "cogni-monorepo",
      prNumber: 42,
      expectedBaseSha: "b".repeat(40),
      expectedHeadSha: headSha,
      expectedPolicyHeadSha: policyHeadSha,
    });
    expect(temporal.start).not.toHaveBeenCalled();
  });

  it("durably hands off node.register before any main write", async () => {
    const capability = vcs(true, registerIntent);
    await dispatchOperatorChangeAutoMerge(payload, capability, log);
    expect(capability.fastForwardOperatorChange).not.toHaveBeenCalled();
    expect(temporal.start).toHaveBeenCalledWith(
      "OperatorChangeRecoveryWorkflow",
      expect.objectContaining({
        workflowId: `operator-change-recovery:cogni-test-org/cogni-monorepo:${headSha}`,
        workflowIdReusePolicy:
          WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
        args: [
          expect.objectContaining({
            losingHeadSha: headSha,
            intent: registerIntent,
          }),
        ],
      })
    );
  });

  it("leaves node.register main untouched when durable handoff fails", async () => {
    const capability = vcs(true, registerIntent);
    temporal.start.mockRejectedValueOnce(new Error("temporal unavailable"));
    await expect(
      dispatchOperatorChangeAutoMerge(payload, capability, log)
    ).rejects.toThrow("temporal unavailable");
    expect(capability.fastForwardOperatorChange).not.toHaveBeenCalled();
  });

  it("treats a running or successfully completed handoff as a duplicate no-op", async () => {
    const capability = vcs(true, registerIntent);
    const alreadyStarted = new Error("already started");
    Object.setPrototypeOf(
      alreadyStarted,
      WorkflowExecutionAlreadyStartedError.prototype
    );
    temporal.start.mockRejectedValueOnce(alreadyStarted);
    await expect(
      dispatchOperatorChangeAutoMerge(payload, capability, log)
    ).resolves.toBeUndefined();
    expect(capability.fastForwardOperatorChange).not.toHaveBeenCalled();
  });

  it("allows redelivery to restart a failed terminal execution", async () => {
    const capability = vcs(true, registerIntent);
    await dispatchOperatorChangeAutoMerge(payload, capability, log);
    await dispatchOperatorChangeAutoMerge(payload, capability, log);
    expect(temporal.start).toHaveBeenCalledTimes(2);
    expect(temporal.start).toHaveBeenNthCalledWith(
      2,
      "OperatorChangeRecoveryWorkflow",
      expect.objectContaining({
        workflowId: `operator-change-recovery:cogni-test-org/cogni-monorepo:${headSha}`,
        workflowIdReusePolicy:
          WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
      })
    );
    expect(capability.fastForwardOperatorChange).not.toHaveBeenCalled();
  });

  it("lets the capability classify a base race instead of dropping the wake", async () => {
    const capability = vcs(true);
    vi.mocked(capability.getCiStatus).mockResolvedValueOnce({
      headSha,
      baseSha: "c".repeat(40),
      pending: false,
      allGreen: true,
    } as never);
    await dispatchOperatorChangeAutoMerge(payload, capability, log);
    expect(capability.fastForwardOperatorChange).toHaveBeenCalledWith({
      owner: "cogni-test-org",
      repo: "cogni-monorepo",
      prNumber: 42,
      expectedBaseSha: "b".repeat(40),
      expectedHeadSha: headSha,
      expectedPolicyHeadSha: policyHeadSha,
    });
  });

  it("honors a human changes-requested hold before fast-forwarding", async () => {
    const capability = vcs(true);
    vi.mocked(capability.getCiStatus).mockResolvedValueOnce({
      headSha,
      baseSha: "b".repeat(40),
      pending: false,
      allGreen: true,
      reviewDecision: "CHANGES_REQUESTED",
    } as never);
    await dispatchOperatorChangeAutoMerge(payload, capability, log);
    expect(capability.fastForwardOperatorChange).not.toHaveBeenCalled();
  });

  it("starts one stable recovery workflow when the base advanced", async () => {
    const capability = vcs(true);
    vi.mocked(capability.fastForwardOperatorChange).mockResolvedValueOnce({
      outcome: "base_advanced",
      currentBaseSha: "c".repeat(40),
      message: "lost CAS",
    });
    await dispatchOperatorChangeAutoMerge(payload, capability, log);
    expect(temporal.start).toHaveBeenCalledWith(
      "OperatorChangeRecoveryWorkflow",
      expect.objectContaining({
        workflowId: `operator-change-recovery:cogni-test-org/cogni-monorepo:${headSha}`,
        workflowIdReusePolicy:
          WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
      })
    );
  });

  it("starts exactly one stable recovery workflow when protected policy moved", async () => {
    const capability = vcs(true);
    vi.mocked(capability.fastForwardOperatorChange).mockResolvedValueOnce({
      outcome: "retryable_or_ambiguous",
      status: 409,
      message:
        "Trusted operator-change policy snapshot changed before compare-and-swap",
    });
    await dispatchOperatorChangeAutoMerge(payload, capability, log);
    expect(temporal.start).toHaveBeenCalledOnce();
    expect(temporal.start).toHaveBeenCalledWith(
      "OperatorChangeRecoveryWorkflow",
      expect.objectContaining({
        workflowId: `operator-change-recovery:cogni-test-org/cogni-monorepo:${headSha}`,
        workflowIdReusePolicy:
          WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
      })
    );
  });

  it("dispatches a fully reverified stale head without exposing stale merge authority", async () => {
    const capability = vcs(false);
    vi.mocked(capability.verifyOperatorChange).mockResolvedValueOnce({
      eligible: false,
      reason: "base-advanced",
      headSha,
      baseSha: "b".repeat(40),
      policyHeadSha,
      operation: "env.membership",
      node: "spawny-boi",
      intent: {
        operation: "env.membership",
        node: "spawny-boi",
        environment: "candidate-a",
        action: "add",
        leaseGeneration: 0,
        recoveryRootSha: headSha,
        recoveryDepth: 0,
      },
    });
    await dispatchOperatorChangeAutoMerge(payload, capability, log);
    expect(capability.fastForwardOperatorChange).not.toHaveBeenCalled();
    expect(temporal.start).toHaveBeenCalledOnce();
  });

  it("rethrows a Temporal start failure so the webhook is not falsely acknowledged", async () => {
    const capability = vcs(true);
    vi.mocked(capability.fastForwardOperatorChange).mockResolvedValueOnce({
      outcome: "retryable_or_ambiguous",
      status: 504,
      message: "ambiguous",
    });
    temporal.start.mockRejectedValueOnce(new Error("temporal unavailable"));
    await expect(
      dispatchOperatorChangeAutoMerge(payload, capability, log)
    ).rejects.toThrow("temporal unavailable");
  });

  it("treats a duplicate stable workflow start as an idempotent no-op", async () => {
    const capability = vcs(true);
    vi.mocked(capability.fastForwardOperatorChange).mockResolvedValueOnce({
      outcome: "base_advanced",
      currentBaseSha: "c".repeat(40),
      message: "lost CAS",
    });
    const alreadyStarted = new Error("already started");
    Object.setPrototypeOf(
      alreadyStarted,
      WorkflowExecutionAlreadyStartedError.prototype
    );
    temporal.start.mockRejectedValueOnce(alreadyStarted);
    await expect(
      dispatchOperatorChangeAutoMerge(payload, capability, log)
    ).resolves.toBeUndefined();
    expect(temporal.start).toHaveBeenCalledOnce();
  });
});
