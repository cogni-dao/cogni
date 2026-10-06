// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";

import type { VcsCapability } from "../src/capabilities/vcs";
import { createVcsMergePrImplementation } from "../src/tools/vcs-merge-pr";

describe("createVcsMergePrImplementation", () => {
  it("pins the merge to the head SHA read immediately beforehand", async () => {
    const getCiStatus = vi.fn().mockResolvedValue({ headSha: "verified-head" });
    const mergePr = vi.fn().mockResolvedValue({
      merged: true,
      sha: "merge-sha",
      message: "Merged",
    });
    const vcsCapability = {
      getCiStatus,
      mergePr,
    } as unknown as VcsCapability;

    const implementation = createVcsMergePrImplementation({ vcsCapability });
    const result = await implementation.execute({
      owner: "Cogni-DAO",
      repo: "cogni",
      prNumber: 42,
      method: "squash",
    });

    expect(getCiStatus).toHaveBeenCalledWith({
      owner: "Cogni-DAO",
      repo: "cogni",
      prNumber: 42,
    });
    expect(mergePr).toHaveBeenCalledWith({
      owner: "Cogni-DAO",
      repo: "cogni",
      prNumber: 42,
      method: "squash",
      expectedHeadSha: "verified-head",
    });
    expect(getCiStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mergePr.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
    expect(result).toEqual({
      merged: true,
      enqueued: false,
      sha: "merge-sha",
      message: "Merged",
    });
  });
});
