// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/tool-requires`
 * Purpose: Lock the authz v0 node-policy declarations: exactly eight tools declare node.collaborate (incl. the work prioritizer's four and core__knowledge_index).
 * Scope: Contract metadata only; does not execute tools or evaluate policy.
 * Invariants:
 *   - PRIORITIZER_TOOLS_DECLARED (story.5096): the prioritizer's reads + its EDO decide declare `requires:
 *     "node.collaborate"`, so its grant-backed scheduled run passes without an OpenFGA tuple.
 *   - UNDECLARED_IS_LEGACY: every other tool omits `requires` (legacy `tool.execute` path); the runtime
 *     adapter forwards a declared one.
 * Side-effects: none
 * Links: src/runtime-adapter.ts, packages/ai-core/src/tooling/tool-runner.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import { CORE_TOOL_BUNDLE, VCS_TOOL_BUNDLE } from "../src/catalog";
import { toBoundToolRuntime } from "../src/runtime-adapter";

const ALL = [...CORE_TOOL_BUNDLE, ...VCS_TOOL_BUNDLE];

describe("tool node-policy declarations (authz v0)", () => {
  it("declares node.collaborate on exactly eight tools", () => {
    const declared = ALL.filter((t) => t.contract.requires !== undefined)
      .map((t) => [t.contract.name, t.contract.requires])
      .sort();
    expect(declared).toEqual(
      [
        ["core__edo_decide", "node.collaborate"],
        ["core__get_current_time", "node.collaborate"],
        ["core__goal_list", "node.collaborate"],
        ["core__knowledge_index", "node.collaborate"],
        ["core__knowledge_read", "node.collaborate"],
        ["core__knowledge_search", "node.collaborate"],
        ["core__work_item_query", "node.collaborate"],
        ["core__work_item_transition", "node.collaborate"],
      ].sort()
    );
  });

  it("forwards requires to the runtime and omits it for undeclared tools", () => {
    for (const tool of ALL) {
      const runtime = toBoundToolRuntime(tool as never);
      if (tool.contract.requires === undefined) {
        expect(runtime).not.toHaveProperty("requires");
      } else {
        expect(runtime.requires).toBe(tool.contract.requires);
      }
    }
  });
});
