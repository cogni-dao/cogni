// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/knowledge-contribution-read`
 * Purpose: Verify node-local read scope, moving-head rejection and honest completeness.
 * Scope: Real execution ALS + capability; fake underlying contribution store only.
 * Invariants: Missing actor/foreign node never reach the store; no writes are available.
 * Side-effects: none.
 * Links: https://cognidao.org/work/items/task.5367
 * @internal
 */
import type { ContributionRecord } from "@cogni/knowledge-store";
import { describe, expect, it, vi } from "vitest";
import {
  type ExecutionScope,
  runInScope,
} from "@/adapters/server/ai/execution-scope";
import { createKnowledgeContributionReadCapability } from "@/bootstrap/capabilities/knowledge-contribution-read";

const record: ContributionRecord = {
  contributionId: "contrib-other",
  branch: "other-branch",
  baseCommit: "base",
  headCommit: "head-1",
  commitCount: 1,
  state: "open",
  principalKind: "user",
  principalId: "actual-other-author",
  message: "Relevant proposed refinement",
  mergedCommit: null,
  closedReason: null,
  idempotencyKey: null,
  createdAt: "2026-10-27",
  resolvedAt: null,
  resolvedBy: null,
};
const scope = (
  actorUserId: string | undefined = "reader-a",
  nodeId = "node-a"
): ExecutionScope => ({
  billing: { billingAccountId: "payer", virtualKeyId: "key" },
  llmService: {} as ExecutionScope["llmService"],
  usageSource: "litellm",
  nodeId,
  ...(actorUserId ? { actorUserId } : {}),
});
const fixture = () => {
  const service = {
    list: vi.fn().mockResolvedValue([record]),
    getById: vi.fn().mockResolvedValue(record),
    diff: vi.fn().mockResolvedValue([
      {
        changeType: "modified",
        rowId: "guide-one",
        before: { content: "old" },
        after: { content: "new" },
      },
    ]),
  };
  return {
    service,
    capability: createKnowledgeContributionReadCapability({
      nodeId: "node-a",
      service,
    }),
  };
};
describe("node-local contribution reads", () => {
  it("requires authenticated matching-node execution before any store call", async () => {
    const { capability, service } = fixture();
    await expect(capability.read({ mode: "list_open" })).rejects.toThrow(
      "outside runInScope"
    );
    await expect(
      runInScope(scope(""), () => capability.read({ mode: "list_open" }))
    ).rejects.toThrow("scope_unavailable");
    await expect(
      runInScope(scope("reader-a", "node-b"), () =>
        capability.read({ mode: "list_open" })
      )
    ).rejects.toThrow("scope_unavailable");
    expect(service.list).not.toHaveBeenCalled();
  });
  it("allows existing node-wide read scope without inventing ownership or principal kind", async () => {
    const { capability, service } = fixture();
    const results = await Promise.all(
      ["reader-a", "reader-b"].map((actor) =>
        runInScope(scope(actor), () => capability.read({ mode: "list_open" }))
      )
    );
    for (const result of results) {
      expect(result.complete).toBe(true);
      expect(result.contributions?.[0]).toMatchObject({
        principalKind: "user",
        principalId: "actual-other-author",
      });
    }
    expect(service.list).toHaveBeenCalledWith({
      query: { state: "open", limit: 100 },
    });
  });
  it("marks a capped open list incomplete", async () => {
    const { capability, service } = fixture();
    service.list.mockResolvedValue(Array.from({ length: 100 }, () => record));
    const result = await runInScope(scope(), () =>
      capability.read({ mode: "list_open" })
    );
    expect(result.complete).toBe(false);
  });
  it("rejects a selected diff whose head moved during the read", async () => {
    const { capability, service } = fixture();
    service.getById
      .mockResolvedValueOnce(record)
      .mockResolvedValueOnce({ ...record, headCommit: "head-2" });
    await expect(
      runInScope(scope(), () =>
        capability.read({
          mode: "read_diff",
          contributionId: record.contributionId,
        })
      )
    ).rejects.toThrow("head_moved");
  });
  it("returns coherent full selected diff with actual author metadata", async () => {
    const { capability } = fixture();
    const result = await runInScope(scope(), () =>
      capability.read({
        mode: "read_diff",
        contributionId: record.contributionId,
      })
    );
    expect(result).toMatchObject({
      nodeId: "node-a",
      complete: true,
      contribution: {
        headCommit: "head-1",
        principalId: "actual-other-author",
      },
      entries: [{ before: { content: "old" }, after: { content: "new" } }],
    });
  });
  it("fails explicitly instead of truncating an oversized selected diff", async () => {
    const { capability, service } = fixture();
    service.diff.mockResolvedValue([
      {
        changeType: "modified",
        rowId: "guide-one",
        before: null,
        after: { content: "x".repeat(66000) },
      },
    ]);
    await expect(
      runInScope(scope(), () =>
        capability.read({
          mode: "read_diff",
          contributionId: record.contributionId,
        })
      )
    ).rejects.toThrow("diff_incomplete");
  });
});
