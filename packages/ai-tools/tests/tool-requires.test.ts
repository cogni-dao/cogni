// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/tool-requires`
 * Purpose: Lock the authz v0 node-policy declarations and prove the runtime adapter forwards `requires`.
 * Scope: Contract metadata only; does not execute tools or evaluate policy.
 * Invariants:
 *   - SEAM_INERT (story.5096 split a): no catalog tool declares `requires` yet — every tool stays on the
 *     legacy `tool.execute` path; declarations land with their consumers in later PRs.
 *   - UNDECLARED_IS_LEGACY — an undeclared tool's runtime omits `requires`; a declared one forwards it.
 * Side-effects: none
 * Links: src/runtime-adapter.ts, packages/ai-core/src/tooling/tool-runner.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import { CORE_TOOL_BUNDLE, VCS_TOOL_BUNDLE } from "../src/catalog";
import { toBoundToolRuntime } from "../src/runtime-adapter";

const ALL = [...CORE_TOOL_BUNDLE, ...VCS_TOOL_BUNDLE];

describe("tool node-policy declarations (authz v0)", () => {
  it("no catalog tool declares a node policy yet (legacy path for all)", () => {
    const declared = ALL.filter((t) => t.contract.requires !== undefined).map(
      (t) => t.contract.name
    );
    expect(declared).toEqual([]);
  });

  it("omits requires on the runtime for undeclared tools", () => {
    for (const tool of ALL) {
      const runtime = toBoundToolRuntime(tool as never);
      expect(runtime).not.toHaveProperty("requires");
    }
  });

  it("forwards a declared requires to the runtime", () => {
    const [first] = CORE_TOOL_BUNDLE;
    if (!first) throw new Error("CORE_TOOL_BUNDLE is empty");
    const declared = {
      ...first,
      contract: {
        ...first.contract,
        requires: "node.collaborate" as const,
      },
    };
    const runtime = toBoundToolRuntime(declared as never);
    expect(runtime.requires).toBe("node.collaborate");
  });
});
