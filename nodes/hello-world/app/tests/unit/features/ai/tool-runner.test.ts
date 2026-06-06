// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/ai/tool-runner.test`
 * Purpose: Tests tool-runner execution pipeline with validation, redaction, policy enforcement, and event emission.
 * Scope: Unit tests for createToolRunner. Does NOT test LLM integration or graph orchestration.
 * Invariants:
 *   - TOOLRUNNER_PIPELINE_ORDER: policy check → validate → execute → validate → redact → emit → return
 *   - TOOLCALL_ID_STABLE: Same toolCallId across start→result events
 *   - DENY_BY_DEFAULT: Default policy rejects all tools
 *   - Event ordering: tool_call_start ALWAYS before tool_call_result
 * Side-effects: none
 * Notes: MVP tool use tests per TOOL_USE_SPEC.md
 * Links: tool-runner.ts, tool-policy.ts
 * @public
 */

import { createToolAllowlistPolicy, createToolRunner } from "@cogni/ai-core";
import {
  createEventCollector,
  createTestBoundToolRuntime,
  createTestToolSource,
  TEST_TOOL_CALL_ID,
  TEST_TOOL_NAME,
} from "@tests/_fakes";
import { describe, expect, it } from "vitest";
import type {
  ToolCallResultEvent,
  ToolCallStartEvent,
} from "@/features/ai/types";

/**
 * Test policy that allows TEST_TOOL_NAME.
 * Used by most tests to avoid DENY_BY_DEFAULT behavior.
 */
const TEST_POLICY = createToolAllowlistPolicy([TEST_TOOL_NAME]);
const TEST_CTX = { runId: "test-run-123" };

describe("features/ai/tool-runner", () => {
  describe("exec()", () => {
    it("returns ok:true with redacted value on success", async () => {
      // Arrange
      const boundTool = createTestBoundToolRuntime(); // Uses default: "Processed: ${input.value}"
      const collector = createEventCollector();
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: TEST_POLICY,
        ctx: TEST_CTX,
      });

      // Act
      const result = await runner.exec(TEST_TOOL_NAME, { value: "test_input" });

      // Assert
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Redacted: should have 'result' but not 'secret'
        expect(result.value).toEqual({ result: "Processed: test_input" });
        expect(result.value).not.toHaveProperty("secret");
      }
    });

    it("returns ok:false with errorCode 'unavailable' for unknown tool", async () => {
      // Arrange
      const collector = createEventCollector();
      const source = createTestToolSource({});
      const runner = createToolRunner(source, collector.emit, {
        policy: TEST_POLICY,
        ctx: TEST_CTX,
      });

      // Act
      const result = await runner.exec("unknown_tool", { value: "test" });

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("unavailable");
        expect(result.safeMessage).toContain("not available");
      }
    });

    it("returns ok:false with errorCode 'validation' on input validation failure", async () => {
      // Arrange
      const boundTool = createTestBoundToolRuntime({
        validateInputThrows: true,
      });
      const collector = createEventCollector();
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: TEST_POLICY,
        ctx: TEST_CTX,
      });

      // Act
      const result = await runner.exec(TEST_TOOL_NAME, { invalid: "args" });

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("validation");
      }
    });

    it("returns ok:false with errorCode 'execution' on execution error", async () => {
      // Arrange
      const boundTool = createTestBoundToolRuntime({ executionThrows: true });
      const collector = createEventCollector();
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: TEST_POLICY,
        ctx: TEST_CTX,
      });

      // Act
      const result = await runner.exec(TEST_TOOL_NAME, { value: "test" });

      // Assert
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("execution");
      }
    });

    // NOTE: Empty allowlist check removed from tool-runner.
    // Allowlist enforcement is now in contract.redact() or ToolPolicy.

    it("returns ok:false with errorCode 'policy_denied' when tool not in policy allowlist", async () => {
      // Arrange - policy allows only TEST_TOOL_NAME, but tool is different
      const boundTool = createTestBoundToolRuntime();
      const collector = createEventCollector();
      const restrictivePolicy = createToolAllowlistPolicy(["other_tool_only"]);
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: restrictivePolicy,
        ctx: TEST_CTX,
      });

      // Act
      const result = await runner.exec(TEST_TOOL_NAME, { value: "test" });

      // Assert - DENY_BY_DEFAULT invariant
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("policy_denied");
        expect(result.safeMessage).toContain("not allowed by current policy");
      }
    });

    it("returns ok:false with errorCode 'policy_denied' when using default DENY_ALL_POLICY", async () => {
      // Arrange - no policy provided, defaults to DENY_ALL_POLICY
      const boundTool = createTestBoundToolRuntime();
      const collector = createEventCollector();
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit);
      // No config - uses DENY_ALL_POLICY

      // Act
      const result = await runner.exec(TEST_TOOL_NAME, { value: "test" });

      // Assert - DENY_BY_DEFAULT invariant
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("policy_denied");
      }
    });

    it("returns ok:false with errorCode 'policy_denied' when effect requires approval (P0 behavior)", async () => {
      // Arrange - tool is in allowlist but effect requires approval
      const boundTool = createTestBoundToolRuntime({ effect: "state_change" });
      const collector = createEventCollector();
      const approvalPolicy = createToolAllowlistPolicy([TEST_TOOL_NAME], {
        requireApprovalForEffects: ["state_change"],
      });
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: approvalPolicy,
        ctx: TEST_CTX,
      });

      // Act
      const result = await runner.exec(TEST_TOOL_NAME, { value: "test" });

      // Assert - P0: require_approval treated as deny
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("policy_denied");
        expect(result.safeMessage).toContain("not allowed by current policy");
      }
    });
  });

  describe("event emission", () => {
    it("emits tool_call_start before execution", async () => {
      // Arrange
      const boundTool = createTestBoundToolRuntime();
      const collector = createEventCollector();
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: TEST_POLICY,
        ctx: TEST_CTX,
      });

      // Act
      await runner.exec(
        TEST_TOOL_NAME,
        { value: "test" },
        { modelToolCallId: TEST_TOOL_CALL_ID }
      );

      // Assert
      const startEvents = collector.getByType("tool_call_start");
      expect(startEvents).toHaveLength(1);
      expect(startEvents[0]).toMatchObject({
        type: "tool_call_start",
        toolCallId: TEST_TOOL_CALL_ID,
        toolName: TEST_TOOL_NAME,
        args: { value: "test" },
      });
    });

    it("emits tool_call_result after execution", async () => {
      // Arrange
      const boundTool = createTestBoundToolRuntime(); // Uses default: "Processed: ${input.value}"
      const collector = createEventCollector();
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: TEST_POLICY,
        ctx: TEST_CTX,
      });

      // Act
      await runner.exec(
        TEST_TOOL_NAME,
        { value: "test" },
        { modelToolCallId: TEST_TOOL_CALL_ID }
      );

      // Assert
      const resultEvents = collector.getByType("tool_call_result");
      expect(resultEvents).toHaveLength(1);
      expect(resultEvents[0]).toMatchObject({
        type: "tool_call_result",
        toolCallId: TEST_TOOL_CALL_ID,
        result: { result: "Processed: test" },
      });
      expect(resultEvents[0].isError).toBeUndefined();
    });

    it("emits events in correct order: start then result", async () => {
      // Arrange
      const boundTool = createTestBoundToolRuntime();
      const collector = createEventCollector();
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: TEST_POLICY,
        ctx: TEST_CTX,
      });

      // Act
      await runner.exec(
        TEST_TOOL_NAME,
        { value: "test" },
        { modelToolCallId: TEST_TOOL_CALL_ID }
      );

      // Assert - Event ordering contract
      expect(collector.events).toHaveLength(2);
      expect(collector.events[0].type).toBe("tool_call_start");
      expect(collector.events[1].type).toBe("tool_call_result");
    });

    it("maintains stable toolCallId across start and result events", async () => {
      // Arrange
      const boundTool = createTestBoundToolRuntime();
      const collector = createEventCollector();
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: TEST_POLICY,
        ctx: TEST_CTX,
      });
      const customToolCallId = "call_stable_id_789";

      // Act
      await runner.exec(
        TEST_TOOL_NAME,
        { value: "test" },
        { modelToolCallId: customToolCallId }
      );

      // Assert - TOOLCALL_ID_STABLE invariant
      const startEvent = collector.events[0] as ToolCallStartEvent;
      const resultEvent = collector.events[1] as ToolCallResultEvent;

      expect(startEvent.toolCallId).toBe(customToolCallId);
      expect(resultEvent.toolCallId).toBe(customToolCallId);
      expect(startEvent.toolCallId).toBe(resultEvent.toolCallId);
    });

    it("emits error result with isError:true on execution failure", async () => {
      // Arrange
      const boundTool = createTestBoundToolRuntime({ executionThrows: true });
      const collector = createEventCollector();
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: TEST_POLICY,
        ctx: TEST_CTX,
      });

      // Act
      await runner.exec(
        TEST_TOOL_NAME,
        { value: "test" },
        { modelToolCallId: TEST_TOOL_CALL_ID }
      );

      // Assert
      const resultEvents = collector.getByType("tool_call_result");
      expect(resultEvents).toHaveLength(1);
      expect(resultEvents[0].isError).toBe(true);
      expect(resultEvents[0].result).toHaveProperty("error");
    });

    it("generates UUID toolCallId when not provided by model", async () => {
      // Arrange
      const boundTool = createTestBoundToolRuntime();
      const collector = createEventCollector();
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: TEST_POLICY,
        ctx: TEST_CTX,
      });

      // Act - no modelToolCallId provided
      await runner.exec(TEST_TOOL_NAME, { value: "test" });

      // Assert
      const startEvent = collector.events[0] as ToolCallStartEvent;
      const resultEvent = collector.events[1] as ToolCallResultEvent;

      // Should have a valid UUID-like ID
      expect(startEvent.toolCallId).toBeDefined();
      expect(startEvent.toolCallId.length).toBeGreaterThan(0);
      // Both events should have same ID
      expect(startEvent.toolCallId).toBe(resultEvent.toolCallId);
    });

    it("emits tool_call_result with isError:true when policy denies tool", async () => {
      // Arrange
      const boundTool = createTestBoundToolRuntime();
      const collector = createEventCollector();
      const restrictivePolicy = createToolAllowlistPolicy(["other_tool"]);
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: restrictivePolicy,
        ctx: TEST_CTX,
      });

      // Act
      await runner.exec(
        TEST_TOOL_NAME,
        { value: "test" },
        { modelToolCallId: TEST_TOOL_CALL_ID }
      );

      // Assert - Policy denial emits error event
      const resultEvents = collector.getByType("tool_call_result");
      expect(resultEvents).toHaveLength(1);
      expect(resultEvents[0].isError).toBe(true);
      expect(resultEvents[0].result).toHaveProperty("error");
      // No start event should be emitted for policy-denied tools
      const startEvents = collector.getByType("tool_call_start");
      expect(startEvents).toHaveLength(0);
    });
  });
});
