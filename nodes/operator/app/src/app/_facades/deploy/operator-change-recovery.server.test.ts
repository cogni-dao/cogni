// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { OperatorChangeRecoveryRequest } from "@cogni/node-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  type OperatorChangeRecoveryCapability,
  recoverOperatorChange,
} from "./operator-change-recovery.server";

const request: OperatorChangeRecoveryRequest = {
  owner: "cogni-test-org",
  repo: "cogni-monorepo",
  prNumber: 68,
  signedBaseSha: "b".repeat(40),
  losingHeadSha: "a".repeat(40),
  intent: {
    operation: "env.membership",
    node: "spawny-boi",
    environment: "candidate-a",
    action: "add",
    leaseGeneration: 0,
    recoveryRootSha: "a".repeat(40),
    recoveryDepth: 0,
  },
};

const registerRequest: OperatorChangeRecoveryRequest = {
  owner: "cogni-test-org",
  repo: "cogni-monorepo",
  prNumber: 70,
  signedBaseSha: "b".repeat(40),
  losingHeadSha: "a".repeat(40),
  intent: {
    operation: "node.register",
    node: "spawny-boi",
    nodeId: "11111111-1111-4111-8111-111111111111",
    sourceRepo: "https://github.com/cogni-test-org/spawny-boi.git",
    sourceSha: "d".repeat(40),
    ownerWallet: `0x${"1".repeat(40)}`,
    recoveryRootSha: "a".repeat(40),
    recoveryDepth: 0,
  },
};

const nonRegisterRequests: readonly OperatorChangeRecoveryRequest[] = [
  request,
  {
    ...request,
    intent: {
      operation: "env.placement",
      node: "spawny-boi",
      environment: "candidate-a",
      provider: "akash",
      recoveryRootSha: "a".repeat(40),
      recoveryDepth: 0,
    },
  },
  {
    ...request,
    intent: {
      operation: "env.region",
      node: "spawny-boi",
      environment: "candidate-a",
      countries: ["US"],
      leaseGeneration: 0,
      recoveryRootSha: "a".repeat(40),
      recoveryDepth: 0,
    },
  },
  {
    ...request,
    intent: {
      operation: "deployment.declare",
      node: "spawny-boi",
      recoveryRootSha: "a".repeat(40),
      recoveryDepth: 0,
    },
  },
];

function deployPlane() {
  return {
    prepareNodeRefCandidateFlight: vi.fn().mockResolvedValue({
      nodeId: "11111111-1111-4111-8111-111111111111",
      slug: "spawny-boi",
      sourceSha: "d".repeat(40),
      sourceRepo: "https://github.com/COGNI-TEST-ORG/spawny-boi",
      image: `ghcr.io/cogni-test-org/spawny-boi:sha-${"d".repeat(40)}`,
    }),
    dispatchNodeRefCandidateFlight: vi.fn().mockResolvedValue({
      dispatched: true,
      workflowUrl:
        "https://github.com/cogni-test-org/cogni-monorepo/actions/workflows/candidate-flight.yml",
      message: "dispatched",
    }),
  };
}

describe("recoverOperatorChange", () => {
  it("delegates the strict request and returns a semantic result", async () => {
    const vcs = {
      recoverOperatorChange: vi.fn().mockResolvedValue({
        status: "regenerated",
        baseSha: "c".repeat(40),
        headSha: "d".repeat(40),
        prNumber: 69,
        prUrl: "https://github.com/cogni-test-org/cogni-monorepo/pull/69",
        recoveryDepth: 1,
      }),
    } as OperatorChangeRecoveryCapability;
    await expect(
      recoverOperatorChange(request, vcs, deployPlane())
    ).resolves.toMatchObject({
      status: "regenerated",
      recoveryDepth: 1,
    });
    expect(vcs.recoverOperatorChange).toHaveBeenCalledWith(request);
  });

  it("fails closed on an invalid capability result", async () => {
    const vcs = {
      recoverOperatorChange: vi.fn().mockResolvedValue({
        status: "regenerated",
        recoveryDepth: 99,
      }),
    } as OperatorChangeRecoveryCapability;
    await expect(
      recoverOperatorChange(request, vcs, deployPlane())
    ).rejects.toThrow();
  });

  it.each([
    { status: "landed", mainSha: "a".repeat(40) },
    {
      status: "satisfied",
      reason: "main_equals_losing_head",
      mainSha: "a".repeat(40),
    },
    {
      status: "satisfied",
      reason: "exact_pr_merged",
      mainSha: "c".repeat(40),
    },
  ])("dispatches exact landed node birth outcome $status", async (result) => {
    const vcs = {
      recoverOperatorChange: vi.fn().mockResolvedValue(result),
    } as OperatorChangeRecoveryCapability;
    const deploy = deployPlane();
    await recoverOperatorChange(registerRequest, vcs, deploy);
    expect(deploy.prepareNodeRefCandidateFlight).toHaveBeenCalledWith({
      parentOwner: "cogni-test-org",
      parentRepo: "cogni-monorepo",
      nodeId: "11111111-1111-4111-8111-111111111111",
      slug: "spawny-boi",
      sourceSha: "d".repeat(40),
    });
    expect(deploy.dispatchNodeRefCandidateFlight).toHaveBeenCalledWith({
      owner: "cogni-test-org",
      repo: "cogni-monorepo",
      slug: "spawny-boi",
      sourceSha: "d".repeat(40),
    });
  });

  it("retries the same exact dispatch after the CAS already landed", async () => {
    const vcs = {
      recoverOperatorChange: vi
        .fn()
        .mockResolvedValueOnce({
          status: "landed",
          mainSha: "a".repeat(40),
        })
        .mockResolvedValueOnce({
          status: "satisfied",
          reason: "main_equals_losing_head",
          mainSha: "a".repeat(40),
        }),
    } as OperatorChangeRecoveryCapability;
    const deploy = deployPlane();
    deploy.dispatchNodeRefCandidateFlight.mockRejectedValueOnce(
      new Error("ambiguous dispatch")
    );
    await expect(
      recoverOperatorChange(registerRequest, vcs, deploy)
    ).rejects.toThrow("ambiguous dispatch");
    await expect(
      recoverOperatorChange(registerRequest, vcs, deploy)
    ).resolves.toMatchObject({
      status: "satisfied",
      reason: "main_equals_losing_head",
    });
    expect(deploy.dispatchNodeRefCandidateFlight).toHaveBeenCalledTimes(2);
    expect(deploy.dispatchNodeRefCandidateFlight).toHaveBeenNthCalledWith(1, {
      owner: "cogni-test-org",
      repo: "cogni-monorepo",
      slug: "spawny-boi",
      sourceSha: "d".repeat(40),
    });
    expect(deploy.dispatchNodeRefCandidateFlight).toHaveBeenNthCalledWith(2, {
      owner: "cogni-test-org",
      repo: "cogni-monorepo",
      slug: "spawny-boi",
      sourceSha: "d".repeat(40),
    });
  });

  it("refuses a floating-main catalog retarget after the register CAS", async () => {
    const vcs = {
      recoverOperatorChange: vi.fn().mockResolvedValue({
        status: "landed",
        mainSha: "a".repeat(40),
      }),
    } as OperatorChangeRecoveryCapability;
    const deploy = deployPlane();
    deploy.prepareNodeRefCandidateFlight.mockResolvedValueOnce({
      nodeId: "11111111-1111-4111-8111-111111111111",
      slug: "spawny-boi",
      sourceSha: "d".repeat(40),
      sourceRepo: "https://github.com/attacker/spawny-boi.git",
      image: `ghcr.io/attacker/spawny-boi:sha-${"d".repeat(40)}`,
    });
    await expect(
      recoverOperatorChange(registerRequest, vcs, deploy)
    ).rejects.toMatchObject({
      message: "prepared node flight does not match verified register intent",
      status: 409,
    });
    expect(deploy.dispatchNodeRefCandidateFlight).not.toHaveBeenCalled();
  });

  it.each([
    {
      request: registerRequest,
      result: {
        status: "satisfied",
        reason: "intent_already_satisfied",
        mainSha: "c".repeat(40),
      },
    },
    {
      request: registerRequest,
      result: {
        status: "regenerated",
        baseSha: "c".repeat(40),
        headSha: "d".repeat(40),
        prNumber: 71,
        prUrl: "https://github.com/cogni-test-org/cogni-monorepo/pull/71",
        recoveryDepth: 1,
      },
    },
    {
      request: registerRequest,
      result: { status: "terminal", reason: "checks-not-green" },
    },
  ])("does not dispatch for non-exact register outcomes", async (fixture) => {
    const vcs = {
      recoverOperatorChange: vi.fn().mockResolvedValue(fixture.result),
    } as OperatorChangeRecoveryCapability;
    const deploy = deployPlane();
    await recoverOperatorChange(fixture.request, vcs, deploy);
    expect(deploy.prepareNodeRefCandidateFlight).not.toHaveBeenCalled();
    expect(deploy.dispatchNodeRefCandidateFlight).not.toHaveBeenCalled();
  });

  it.each(
    nonRegisterRequests
  )("never dispatches landed non-register operation $intent.operation", async (nonRegisterRequest) => {
    const vcs = {
      recoverOperatorChange: vi.fn().mockResolvedValue({
        status: "landed",
        mainSha: "a".repeat(40),
      }),
    } as OperatorChangeRecoveryCapability;
    const deploy = deployPlane();
    await recoverOperatorChange(nonRegisterRequest, vcs, deploy);
    expect(deploy.prepareNodeRefCandidateFlight).not.toHaveBeenCalled();
    expect(deploy.dispatchNodeRefCandidateFlight).not.toHaveBeenCalled();
  });
});
