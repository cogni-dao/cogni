// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/evaluation-baseline`
 * Purpose: Prove shared evaluation tools retain operator policy before any capability executes.
 * Scope: Published contracts + real operator runtime adapter/tool runner; capabilities are spies.
 * Invariants: HOST_POLICY_PRESERVED; AUTHZ_BEFORE_EXEC; RELEASE_OWNS_SCORE_SCHEMA.
 * Side-effects: none
 * Links: src/bootstrap/ai/evaluation-baseline.ts, hub adopt-node-package-release
 * @internal
 */
import {
  createStaticToolSource,
  createToolAllowlistPolicy,
  createToolRunner,
} from "@cogni/ai-core";
import { CORE_TOOL_BUNDLE, contractToRuntime } from "@cogni/ai-tools";
import { describe, expect, it, vi } from "vitest";
import { OPERATOR_CORE_TOOL_BUNDLE } from "@/bootstrap/ai/evaluation-baseline";

const queryId = "core__work_item_query";
const query = OPERATOR_CORE_TOOL_BUNDLE.find(
  (tool) => tool.contract.name === queryId
);
if (!query) throw new Error("Missing shared query binding");

describe("operator shared evaluation binding", () => {
  it("preserves every existing operator tool authorization requirement", () => {
    expect(OPERATOR_CORE_TOOL_BUNDLE).toHaveLength(CORE_TOOL_BUNDLE.length);
    for (const original of CORE_TOOL_BUNDLE) {
      const bound = OPERATOR_CORE_TOOL_BUNDLE.find(
        (tool) => tool.contract.name === original.contract.name
      );
      expect(bound?.contract.requires).toBe(original.contract.requires);
    }
    expect(query.contract.requires).toBe("node.collaborate");
  });

  it("refuses an unidentified run before executing a shared read implementation", async () => {
    const execute = vi.fn();
    const runtime = contractToRuntime(query.contract, { execute });
    const runner = createToolRunner(
      createStaticToolSource([runtime]),
      () => {},
      {
        policy: createToolAllowlistPolicy([queryId]),
        ctx: { runId: "evaluation-adoption-policy" },
        nodeId: "operator",
      }
    );
    const result = await runner.exec(queryId, {});
    expect(result).toMatchObject({ ok: false, errorCode: "authz_unavailable" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("accepts the released six-axis patch contract without adding a priority", () => {
    const update = OPERATOR_CORE_TOOL_BUNDLE.find(
      (tool) => tool.contract.name === "core__work_item_update"
    );
    if (!update) throw new Error("Missing shared score patch binding");
    const scores = Object.fromEntries(
      ["goal", "time", "unblocks", "ease", "confidence", "agent"].map(
        (axis) => [axis, { v: 2 }]
      )
    );
    const parsed = update.contract.inputSchema.parse({
      id: "task.5111",
      expectedRevision: 4,
      reason: "score the six axes",
      set: { scores },
    });
    expect(parsed).toMatchObject({ expectedRevision: 4, set: { scores } });
    expect((parsed as { set: object }).set).not.toHaveProperty("priority");
  });

  it("keeps the operator gate on the released update tool and drops the retired transition tool", () => {
    const names = OPERATOR_CORE_TOOL_BUNDLE.map((tool) => tool.contract.name);
    expect(names).toContain("core__work_item_update");
    expect(names).not.toContain("core__work_item_transition");
    const update = OPERATOR_CORE_TOOL_BUNDLE.find(
      (tool) => tool.contract.name === "core__work_item_update"
    );
    expect(update?.contract.requires).toBe("node.collaborate");
  });

  describe("core__work_item_update surface is narrowed to the retired transition tool's", () => {
    const update = OPERATOR_CORE_TOOL_BUNDLE.find(
      (tool) => tool.contract.name === "core__work_item_update"
    );
    const base = { id: "task.5111", reason: "triage the item" };
    const parse = (set: Record<string, unknown>) =>
      update?.contract.inputSchema.safeParse({ ...base, set }).success;

    it.each([
      ["priority", { priority: 2 }],
      ["rank", { rank: 3 }],
      ["labels", { labels: ["a"] }],
      ["summary", { summary: "s" }],
      ["status needs_research", { status: "needs_research" }],
      ["status needs_design", { status: "needs_design" }],
    ])("accepts set.%s", (_name, set) => {
      expect(parse(set)).toBe(true);
    });

    it.each([
      ["title", { title: "t" }],
      ["outcome", { outcome: "o" }],
      ["pr", { pr: "https://example.test/pr/1" }],
      ["deployVerified", { deployVerified: true }],
      ["projectId", { projectId: "story.1" }],
      ["parentId", { parentId: "story.1" }],
      ["status needs_implement", { status: "needs_implement" }],
      ["status done", { status: "done" }],
      ["status cancelled", { status: "cancelled" }],
      ["status needs_triage", { status: "needs_triage" }],
      ["a field alongside an allowed one", { priority: 2, title: "t" }],
      ["an empty set", {}],
    ])("rejects set.%s", (_name, set) => {
      expect(parse(set)).toBe(false);
    });
  });
});
