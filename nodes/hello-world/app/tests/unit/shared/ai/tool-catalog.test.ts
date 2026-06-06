// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/shared/ai/tool-catalog.test`
 * Purpose: Unit tests for ToolCatalog creation and policy-based filtering.
 * Scope: Verify catalog filters tools using policy.decide(), handles empty specs, and returns immutable catalogs. Does NOT test runtime tool execution or LLM integration.
 * Invariants:
 *   - CATALOG_IS_EXPLICIT: Model only sees tools that policy.decide() returns 'allow'
 *   - P0: Both 'deny' and 'require_approval' exclude tools from catalog
 * Side-effects: none
 * Notes: Tests double-enforcement visibility filtering per TOOL_USE_SPEC.md
 * Links: tool-catalog.ts, tool-policy.ts, TOOL_USE_SPEC.md
 * @internal
 */

import type { ToolSpec } from "@cogni/ai-core";
import { createToolAllowlistPolicy, DENY_ALL_POLICY } from "@cogni/ai-core";
import { createToolCatalog, EMPTY_CATALOG } from "@cogni/node-shared";
import { describe, expect, it } from "vitest";

// Test tool specs
const READ_ONLY_TOOL: ToolSpec = {
  name: "core__read_file",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  effect: "read_only",
  redaction: { mode: "top_level_only", allowlist: ["content"] },
};

const STATE_CHANGE_TOOL: ToolSpec = {
  name: "core__write_file",
  description: "Write a file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
  },
  effect: "state_change",
  redaction: { mode: "top_level_only", allowlist: ["success"] },
};

const EXTERNAL_TOOL: ToolSpec = {
  name: "core__send_email",
  description: "Send an email",
  inputSchema: { type: "object", properties: { to: { type: "string" } } },
  effect: "external_side_effect",
  redaction: { mode: "top_level_only", allowlist: ["sent"] },
};

const ALL_SPECS = [READ_ONLY_TOOL, STATE_CHANGE_TOOL, EXTERNAL_TOOL];

describe("shared/ai/tool-catalog", () => {
  describe("createToolCatalog()", () => {
    it("filters tools using policy.decide(), not just allowedTools", () => {
      // Policy allows read_file but requires approval for state_change effects
      const policy = createToolAllowlistPolicy(
        [READ_ONLY_TOOL.name, STATE_CHANGE_TOOL.name],
        { requireApprovalForEffects: ["state_change"] }
      );

      const catalog = createToolCatalog(ALL_SPECS, policy);

      // read_file should be in catalog (allowed, read_only effect)
      expect(catalog.get(READ_ONLY_TOOL.name)).toBeDefined();
      // write_file should NOT be in catalog (require_approval -> excluded in P0)
      expect(catalog.get(STATE_CHANGE_TOOL.name)).toBeUndefined();
      // send_email should NOT be in catalog (not in allowedTools -> deny)
      expect(catalog.get(EXTERNAL_TOOL.name)).toBeUndefined();
    });

    it("returns EMPTY_CATALOG when no tools pass policy", () => {
      const catalog = createToolCatalog(ALL_SPECS, DENY_ALL_POLICY);

      expect(catalog).toBe(EMPTY_CATALOG);
      expect(catalog.list()).toHaveLength(0);
    });

    it("returns EMPTY_CATALOG for empty specs array", () => {
      const policy = createToolAllowlistPolicy(["any_tool"]);
      const catalog = createToolCatalog([], policy);

      expect(catalog).toBe(EMPTY_CATALOG);
    });

    it("includes all allowed tools with matching effects", () => {
      const policy = createToolAllowlistPolicy([
        READ_ONLY_TOOL.name,
        STATE_CHANGE_TOOL.name,
        EXTERNAL_TOOL.name,
      ]);

      const catalog = createToolCatalog(ALL_SPECS, policy);

      expect(catalog.list()).toHaveLength(3);
      expect(catalog.get(READ_ONLY_TOOL.name)).toBe(READ_ONLY_TOOL);
      expect(catalog.get(STATE_CHANGE_TOOL.name)).toBe(STATE_CHANGE_TOOL);
      expect(catalog.get(EXTERNAL_TOOL.name)).toBe(EXTERNAL_TOOL);
    });

    it("returns frozen catalog for immutability", () => {
      const policy = createToolAllowlistPolicy([READ_ONLY_TOOL.name]);
      const catalog = createToolCatalog([READ_ONLY_TOOL], policy);

      expect(Object.isFrozen(catalog)).toBe(true);
    });
  });

  describe("EMPTY_CATALOG", () => {
    it("has frozen empty tools map", () => {
      expect(EMPTY_CATALOG.tools.size).toBe(0);
      expect(Object.isFrozen(EMPTY_CATALOG)).toBe(true);
    });

    it("get() always returns undefined", () => {
      expect(EMPTY_CATALOG.get("any_tool")).toBeUndefined();
    });

    it("list() returns frozen empty array", () => {
      const list = EMPTY_CATALOG.list();
      expect(list).toHaveLength(0);
      expect(Object.isFrozen(list)).toBe(true);
    });
  });

  describe("require_approval treatment in P0", () => {
    it("excludes tools that would require approval", () => {
      // All three tools in allowlist, but state_change and external require approval
      const policy = createToolAllowlistPolicy(
        [READ_ONLY_TOOL.name, STATE_CHANGE_TOOL.name, EXTERNAL_TOOL.name],
        { requireApprovalForEffects: ["state_change", "external_side_effect"] }
      );

      const catalog = createToolCatalog(ALL_SPECS, policy);

      // Only read_only tool should be visible
      expect(catalog.list()).toHaveLength(1);
      expect(catalog.get(READ_ONLY_TOOL.name)).toBeDefined();
      expect(catalog.get(STATE_CHANGE_TOOL.name)).toBeUndefined();
      expect(catalog.get(EXTERNAL_TOOL.name)).toBeUndefined();
    });
  });
});
