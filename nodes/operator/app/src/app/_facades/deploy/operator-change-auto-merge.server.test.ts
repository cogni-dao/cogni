// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { VcsCapability } from "@cogni/ai-tools";
import { describe, expect, it, vi } from "vitest";
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
    }),
    getCiStatus: vi.fn().mockResolvedValue({
      headSha,
      baseSha: "b".repeat(40),
      headParentSha: "b".repeat(40),
      headCommitMessage: `generated\n\nCogni-Base-SHA: ${"b".repeat(40)}`,
      pending: false,
      allGreen: true,
      checks: [
        {
          name: "operator-change-automerge-ready",
          status: "completed",
          conclusion: "success",
        },
      ],
    }),
    mergePr: vi.fn().mockResolvedValue({ merged: true, message: "Merged" }),
  } as unknown as VcsCapability;
}

describe("dispatchOperatorChangeAutoMerge", () => {
  it("rejects a forged ready check when operator reclassification fails", async () => {
    const capability = vcs(false);
    await dispatchOperatorChangeAutoMerge(payload, capability, log);
    expect(capability.verifyOperatorChange).toHaveBeenCalledWith({
      owner: "cogni-test-org",
      repo: "cogni-monorepo",
      prNumber: 42,
      expectedHeadSha: headSha,
    });
    expect(capability.mergePr).not.toHaveBeenCalled();
  });

  it("binds a reverified internal bypass merge to the current expected head", async () => {
    const capability = vcs(true);
    await dispatchOperatorChangeAutoMerge(payload, capability, log);
    expect(capability.mergePr).toHaveBeenCalledWith({
      owner: "cogni-test-org",
      repo: "cogni-monorepo",
      prNumber: 42,
      method: "squash",
      bypassQueue: true,
      expectedHeadSha: headSha,
    });
  });
});
