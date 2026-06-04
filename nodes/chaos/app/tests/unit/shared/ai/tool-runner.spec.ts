// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/shared/ai/tool-runner`
 * Purpose: Unit tests for createToolRunner policy enforcement.
 * Scope: Tests DENY_BY_DEFAULT invariant - blocked tools emit error, impl not called. Does NOT test validation or redaction pipelines.
 * Invariants:
 *   - DENY_BY_DEFAULT: No policy = all tools blocked
 *   - policy_denied errorCode when denied
 *   - tool_call_result isError=true when denied
 *   - Implementation NOT called when denied
 * Side-effects: none
 * Links: tool-runner.ts, tool-policy.ts, TOOL_USE_SPEC.md
 * @internal
 */

import {
  createToolAllowlistPolicy,
  createToolRunner,
  DENY_ALL_POLICY,
} from "@cogni/ai-core";
import {
  createEventCollector,
  createTestBoundToolRuntime,
  createTestToolSource,
  TEST_TOOL_NAME,
} from "@tests/_fakes/ai/tool-builders";
import { describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("createToolRunner", () => {
  describe("DENY_BY_DEFAULT", () => {
    it("blocks all tools when no policy provided", async () => {
      const { boundTool, executeSpy } = createSpyableBoundTool();
      const collector = createEventCollector();

      // Create runner WITHOUT policy (defaults to DENY_ALL_POLICY)
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit);
      // No config = no policy = DENY_ALL_POLICY

      const result = await runner.exec(TEST_TOOL_NAME, { value: "test" });

      // Should be denied
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("policy_denied");

      // Implementation NOT called
      expect(executeSpy).not.toHaveBeenCalled();

      // Error event emitted
      const resultEvents = collector.getByType("tool_call_result");
      expect(resultEvents).toHaveLength(1);
      expect(resultEvents[0].isError).toBe(true);
    });

    it("blocks all tools with explicit DENY_ALL_POLICY", async () => {
      const { boundTool, executeSpy } = createSpyableBoundTool();
      const collector = createEventCollector();

      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: DENY_ALL_POLICY,
      });

      const result = await runner.exec(TEST_TOOL_NAME, { value: "test" });

      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("policy_denied");
      expect(executeSpy).not.toHaveBeenCalled();
    });
  });

  describe("allowlist policy", () => {
    it("allows tool in allowlist", async () => {
      const { boundTool, executeSpy } = createSpyableBoundTool();
      const collector = createEventCollector();

      const policy = createToolAllowlistPolicy([TEST_TOOL_NAME]);
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, { policy });

      const result = await runner.exec(TEST_TOOL_NAME, { value: "hello" });

      // Should succeed
      expect(result.ok).toBe(true);
      expect(result.value).toEqual({ result: "Processed: hello" });

      // Implementation called
      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(executeSpy).toHaveBeenCalledWith({ value: "hello" });

      // Events emitted: start then result
      const startEvents = collector.getByType("tool_call_start");
      const resultEvents = collector.getByType("tool_call_result");
      expect(startEvents).toHaveLength(1);
      expect(resultEvents).toHaveLength(1);
      expect(resultEvents[0].isError).toBeUndefined();
    });

    it("blocks tool NOT in allowlist", async () => {
      const { boundTool, executeSpy } = createSpyableBoundTool();
      const collector = createEventCollector();

      // Policy allows "other_tool" but NOT TEST_TOOL_NAME
      const policy = createToolAllowlistPolicy(["other_tool"]);
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, { policy });

      const result = await runner.exec(TEST_TOOL_NAME, { value: "test" });

      // Should be denied
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("policy_denied");

      // Implementation NOT called
      expect(executeSpy).not.toHaveBeenCalled();

      // Error event emitted (no start event when denied at policy check)
      const startEvents = collector.getByType("tool_call_start");
      const resultEvents = collector.getByType("tool_call_result");
      expect(startEvents).toHaveLength(0);
      expect(resultEvents).toHaveLength(1);
      expect(resultEvents[0].isError).toBe(true);
    });
  });

  describe("unavailable tool", () => {
    it("returns unavailable error for unknown tool", async () => {
      const collector = createEventCollector();

      // Create runner with empty source
      const source = createTestToolSource({});
      const runner = createToolRunner(source, collector.emit);

      const result = await runner.exec("nonexistent_tool", { value: "test" });

      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("unavailable");

      // Error event emitted
      const resultEvents = collector.getByType("tool_call_result");
      expect(resultEvents).toHaveLength(1);
      expect(resultEvents[0].isError).toBe(true);
    });

    it("does NOT emit tool_call_start when source.getBoundTool returns undefined", async () => {
      // Regression test: Ensures unknown toolId fails fast without emitting start event
      // Per TOOL_SOURCE_RETURNS_BOUND_TOOL: source.getBoundTool returns undefined for unknown tools
      const collector = createEventCollector();
      const source = createTestToolSource({});
      const runner = createToolRunner(source, collector.emit);

      await runner.exec("unknown_tool_id", { value: "test" });

      // tool_call_start should NOT be emitted for unknown tools
      const startEvents = collector.getByType("tool_call_start");
      expect(startEvents).toHaveLength(0);

      // Only tool_call_result (error) should be emitted
      const resultEvents = collector.getByType("tool_call_result");
      expect(resultEvents).toHaveLength(1);
      expect(resultEvents[0].isError).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a bound tool runtime with spyable exec method.
 */
function createSpyableBoundTool() {
  const executeSpy = vi
    .fn()
    .mockImplementation(async (input: { value: string }) => ({
      result: `Processed: ${input.value}`,
      secret: "hidden",
    }));

  const boundTool = createTestBoundToolRuntime();
  boundTool.exec = async (args) => executeSpy(args);

  return { boundTool, executeSpy };
}
