// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/tests/catalog`
 * Purpose: Unit tests for TOOL_CATALOG and createToolCatalog.
 * Scope: Tests catalog construction, collision detection, and lookup functions. Does not test tool execution.
 * Invariants: TOOL_ID_STABILITY - duplicate IDs throw at construction.
 * Side-effects: none
 * Links: src/catalog.ts, TOOL_USE_SPEC.md
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  type CatalogBoundTool,
  CORE_TOOL_BUNDLE,
  createToolCatalog,
  getToolById,
  getToolIds,
  hasToolId,
  TOOL_CATALOG,
  VCS_TOOL_BUNDLE,
} from "../src/catalog";
import { getCurrentTimeBoundTool } from "../src/tools/get-current-time";
import { VCS_CREATE_BRANCH_NAME } from "../src/tools/vcs-create-branch";
import { VCS_FLIGHT_CANDIDATE_NAME } from "../src/tools/vcs-flight-candidate";
import { VCS_GET_CI_STATUS_NAME } from "../src/tools/vcs-get-ci-status";
import { VCS_LIST_PRS_NAME } from "../src/tools/vcs-list-prs";
import { VCS_MERGE_PR_NAME } from "../src/tools/vcs-merge-pr";

const VCS_TOOL_IDS = [
  VCS_CREATE_BRANCH_NAME,
  VCS_FLIGHT_CANDIDATE_NAME,
  VCS_GET_CI_STATUS_NAME,
  VCS_LIST_PRS_NAME,
  VCS_MERGE_PR_NAME,
] as const;

describe("TOOL_CATALOG", () => {
  it("contains core__get_current_time", () => {
    expect(hasToolId("core__get_current_time")).toBe(true);
    expect(getToolById("core__get_current_time")).toBeDefined();
  });

  it("returns undefined for unknown tool ID", () => {
    expect(getToolById("unknown__tool")).toBeUndefined();
  });

  it("hasToolId returns false for unknown tool", () => {
    expect(hasToolId("unknown__tool")).toBe(false);
  });

  it("getToolIds returns all registered tool IDs", () => {
    const ids = getToolIds();
    expect(ids).toContain("core__get_current_time");
    expect(Array.isArray(ids)).toBe(true);
  });

  it("catalog is frozen (immutable)", () => {
    expect(Object.isFrozen(TOOL_CATALOG)).toBe(true);
  });

  it("keeps VCS tools out of the shared core bundle", () => {
    const coreIds = CORE_TOOL_BUNDLE.map((tool) => tool.contract.name);
    const vcsIds = VCS_TOOL_BUNDLE.map((tool) => tool.contract.name);

    for (const toolId of VCS_TOOL_IDS) {
      expect(coreIds).not.toContain(toolId);
      expect(vcsIds).toContain(toolId);
      expect(hasToolId(toolId)).toBe(true);
    }
  });
});

describe("createToolCatalog", () => {
  it("creates catalog from array of tools", () => {
    const catalog = createToolCatalog([
      getCurrentTimeBoundTool as CatalogBoundTool,
    ]);

    expect("core__get_current_time" in catalog).toBe(true);
    expect(Object.isFrozen(catalog)).toBe(true);
  });

  it("creates empty catalog from empty array", () => {
    const catalog = createToolCatalog([]);
    expect(Object.keys(catalog)).toHaveLength(0);
  });

  /**
   * TOOL_ID_STABILITY: Duplicate tool IDs throw at construction time.
   * This is the critical invariant test.
   */
  it("throws on duplicate tool ID (TOOL_ID_STABILITY)", () => {
    const duplicateTool: CatalogBoundTool = {
      contract: {
        name: "core__get_current_time", // Duplicate ID
        description: "Duplicate tool",
        effect: "read_only",
        inputSchema: { parse: (x: unknown) => x } as never,
        outputSchema: { parse: (x: unknown) => x } as never,
        redact: (x: unknown) => x as Record<string, unknown>,
        allowlist: [],
      },
      implementation: {
        execute: async () => ({}),
      },
    };

    expect(() =>
      createToolCatalog([
        getCurrentTimeBoundTool as CatalogBoundTool,
        duplicateTool,
      ])
    ).toThrow(/TOOL_ID_STABILITY.*Duplicate tool ID.*core__get_current_time/);
  });

  it("error message includes tool ID on collision", () => {
    const tool1: CatalogBoundTool = {
      contract: {
        name: "test__duplicate",
        description: "First tool",
        effect: "read_only",
        inputSchema: { parse: (x: unknown) => x } as never,
        outputSchema: { parse: (x: unknown) => x } as never,
        redact: (x: unknown) => x as Record<string, unknown>,
        allowlist: [],
      },
      implementation: { execute: async () => ({}) },
    };

    const tool2: CatalogBoundTool = {
      contract: {
        name: "test__duplicate", // Same ID
        description: "Second tool",
        effect: "read_only",
        inputSchema: { parse: (x: unknown) => x } as never,
        outputSchema: { parse: (x: unknown) => x } as never,
        redact: (x: unknown) => x as Record<string, unknown>,
        allowlist: [],
      },
      implementation: { execute: async () => ({}) },
    };

    expect(() => createToolCatalog([tool1, tool2])).toThrow("test__duplicate");
  });
});
