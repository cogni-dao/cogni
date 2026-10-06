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
    await expect(recoverOperatorChange(request, vcs)).resolves.toMatchObject({
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
    await expect(recoverOperatorChange(request, vcs)).rejects.toThrow();
  });
});
