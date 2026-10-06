// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { VcsCapability } from "@cogni/ai-tools";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
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
const payload = {
  action: "completed",
  repository: { full_name: "cogni-test-org/cogni-monorepo" },
  check_run: { head_sha: headSha, pull_requests: [{ number: 42 }] },
};
const log = { info: vi.fn() } as never;

function vcs(eligible: boolean) {
  return {
    verifyOperatorChange: vi.fn().mockResolvedValue({
      eligible,
      reason: eligible ? "eligible" : "untrusted-repository",
      headSha,
      baseSha: "b".repeat(40),
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
    });
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
        workflowIdReusePolicy: 3,
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
