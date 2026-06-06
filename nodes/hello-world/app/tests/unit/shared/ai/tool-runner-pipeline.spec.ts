// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/shared/ai/tool-runner-pipeline`
 * Purpose: Pipeline ordering tests for createToolRunner method-based interface.
 * Scope: Verifies TOOLRUNNER_PIPELINE_ORDER: validateInput → exec → validateOutput → redact. Does NOT test legacy contract/implementation interface.
 * Invariants:
 *   - METHOD_BASED_INTERFACE: toolRunner calls boundTool methods, not legacy contract/impl
 *   - POLICY_DENY_BEFORE_EXEC: exec() never called when policy denies
 *   - REDACTION_ALWAYS_HAPPENS: redact() always called on successful exec, no raw output leak
 *   - VALIDATION_BEFORE_EXEC: validateInput() called before exec()
 *   - OUTPUT_VALIDATION_BEFORE_REDACT: validateOutput() called before redact()
 * Side-effects: none
 * Notes: These tests drive the toolRunner refactor to use ToolSourcePort/BoundToolRuntime.
 * Links: tool-runner.ts, TOOL_USE_SPEC.md
 * @internal
 */

import {
  type BoundToolRuntime,
  createToolAllowlistPolicy,
  createToolRunner,
  type ToolInvocationContext,
  type ToolSpec,
} from "@cogni/ai-core";
import type { ToolCapabilities } from "@cogni/ai-tools";
import {
  createEventCollector,
  createTestToolSource,
} from "@tests/_fakes/ai/tool-builders";
import { describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────────
// Test Constants
// ─────────────────────────────────────────────────────────────────────────────

const TEST_TOOL_NAME = "test__pipeline_tool" as const;
const TEST_RUN_ID = "pipeline-test-run";

// ─────────────────────────────────────────────────────────────────────────────
// Spy-able BoundToolRuntime Factory
// ─────────────────────────────────────────────────────────────────────────────

interface SpyableBoundToolOptions {
  validateInputThrows?: boolean;
  execThrows?: boolean;
  validateOutputThrows?: boolean;
  redactThrows?: boolean;
  rawOutput?: Record<string, unknown>;
}

/**
 * Create a BoundToolRuntime with spied methods for verifying call order.
 */
function createSpyableBoundToolRuntime(options: SpyableBoundToolOptions = {}) {
  const callOrder: string[] = [];

  const validateInputSpy = vi.fn().mockImplementation((rawArgs: unknown) => {
    callOrder.push("validateInput");
    if (options.validateInputThrows) {
      throw new Error("Input validation failed");
    }
    return rawArgs; // Pass through
  });

  const execSpy = vi
    .fn()
    .mockImplementation(
      async (
        _validatedArgs: unknown,
        _ctx: ToolInvocationContext,
        _capabilities: ToolCapabilities
      ) => {
        callOrder.push("exec");
        if (options.execThrows) {
          throw new Error("Execution failed");
        }
        return options.rawOutput ?? { result: "processed", secret: "hidden" };
      }
    );

  const validateOutputSpy = vi.fn().mockImplementation((rawOutput: unknown) => {
    callOrder.push("validateOutput");
    if (options.validateOutputThrows) {
      throw new Error("Output validation failed");
    }
    return rawOutput;
  });

  const redactSpy = vi.fn().mockImplementation((validatedOutput: unknown) => {
    callOrder.push("redact");
    if (options.redactThrows) {
      throw new Error("Redaction failed");
    }
    // Redact: only keep 'result', strip 'secret'
    const output = validatedOutput as Record<string, unknown>;
    return { result: output.result };
  });

  const spec: ToolSpec = {
    name: TEST_TOOL_NAME,
    description: "Test tool for pipeline verification",
    inputSchema: { type: "object" },
    effect: "read_only",
    redaction: { mode: "top_level_only", allowlist: ["result"] },
  };

  const boundTool: BoundToolRuntime = {
    id: TEST_TOOL_NAME,
    spec,
    effect: "read_only",
    requiresConnection: false,
    capabilities: [],

    // Legacy fields (should NOT be used after refactor)
    contract: {
      name: TEST_TOOL_NAME,
      effect: "read_only",
      inputSchema: { parse: (x: unknown) => x },
      outputSchema: { parse: (x: unknown) => x },
      redact: (x: unknown) => x,
    },
    implementation: {
      execute: async () => ({ result: "legacy", secret: "legacy" }),
    },

    // Method-based interface (should be used after refactor)
    validateInput: validateInputSpy,
    exec: execSpy,
    validateOutput: validateOutputSpy,
    redact: redactSpy,
  };

  return {
    boundTool,
    spies: {
      validateInput: validateInputSpy,
      exec: execSpy,
      validateOutput: validateOutputSpy,
      redact: redactSpy,
    },
    callOrder,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("createToolRunner pipeline ordering (method-based interface)", () => {
  const TEST_POLICY = createToolAllowlistPolicy([TEST_TOOL_NAME]);
  const TEST_CTX = { runId: TEST_RUN_ID };

  describe("TOOLRUNNER_PIPELINE_ORDER", () => {
    it("calls methods in order: validateInput → exec → validateOutput → redact", async () => {
      // Arrange
      const { boundTool, callOrder } = createSpyableBoundToolRuntime();
      const collector = createEventCollector();
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: TEST_POLICY,
        ctx: TEST_CTX,
      });

      // Act
      await runner.exec(TEST_TOOL_NAME, { value: "test" });

      // Assert - Pipeline order enforced
      expect(callOrder).toEqual([
        "validateInput",
        "exec",
        "validateOutput",
        "redact",
      ]);
    });

    it("stops pipeline at validateInput on validation failure", async () => {
      // Arrange
      const { boundTool, callOrder, spies } = createSpyableBoundToolRuntime({
        validateInputThrows: true,
      });
      const collector = createEventCollector();
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: TEST_POLICY,
        ctx: TEST_CTX,
      });

      // Act
      const result = await runner.exec(TEST_TOOL_NAME, { value: "test" });

      // Assert - Pipeline stops after validateInput
      expect(callOrder).toEqual(["validateInput"]);
      expect(spies.exec).not.toHaveBeenCalled();
      expect(spies.validateOutput).not.toHaveBeenCalled();
      expect(spies.redact).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("validation");
      }
    });

    it("stops pipeline at exec on execution failure", async () => {
      // Arrange
      const { boundTool, callOrder, spies } = createSpyableBoundToolRuntime({
        execThrows: true,
      });
      const collector = createEventCollector();
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: TEST_POLICY,
        ctx: TEST_CTX,
      });

      // Act
      const result = await runner.exec(TEST_TOOL_NAME, { value: "test" });

      // Assert - Pipeline stops after exec
      expect(callOrder).toEqual(["validateInput", "exec"]);
      expect(spies.validateOutput).not.toHaveBeenCalled();
      expect(spies.redact).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("execution");
      }
    });

    it("stops pipeline at validateOutput on output validation failure", async () => {
      // Arrange
      const { boundTool, callOrder, spies } = createSpyableBoundToolRuntime({
        validateOutputThrows: true,
      });
      const collector = createEventCollector();
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: TEST_POLICY,
        ctx: TEST_CTX,
      });

      // Act
      const result = await runner.exec(TEST_TOOL_NAME, { value: "test" });

      // Assert - Pipeline stops after validateOutput
      expect(callOrder).toEqual(["validateInput", "exec", "validateOutput"]);
      expect(spies.redact).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("validation");
      }
    });
  });

  describe("POLICY_DENY_BEFORE_EXEC", () => {
    it("never calls exec when policy denies (DENY_ALL_POLICY)", async () => {
      // Arrange
      const { boundTool, spies } = createSpyableBoundToolRuntime();
      const collector = createEventCollector();
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit);
      // No config = DENY_ALL_POLICY

      // Act
      const result = await runner.exec(TEST_TOOL_NAME, { value: "test" });

      // Assert - exec() NEVER called when policy denies
      expect(spies.validateInput).not.toHaveBeenCalled();
      expect(spies.exec).not.toHaveBeenCalled();
      expect(spies.validateOutput).not.toHaveBeenCalled();
      expect(spies.redact).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("policy_denied");
      }
    });

    it("never calls exec when tool not in allowlist", async () => {
      // Arrange
      const { boundTool, spies } = createSpyableBoundToolRuntime();
      const collector = createEventCollector();
      const restrictivePolicy = createToolAllowlistPolicy(["other_tool_only"]);
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: restrictivePolicy,
        ctx: TEST_CTX,
      });

      // Act
      const result = await runner.exec(TEST_TOOL_NAME, { value: "test" });

      // Assert - exec() NEVER called when not in allowlist
      expect(spies.exec).not.toHaveBeenCalled();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("policy_denied");
      }
    });
  });

  describe("REDACTION_ALWAYS_HAPPENS", () => {
    it("always calls redact on successful exec (no raw output leak)", async () => {
      // Arrange
      const rawOutput = { result: "processed", secret: "SUPER_SECRET_VALUE" };
      const { boundTool, spies } = createSpyableBoundToolRuntime({ rawOutput });
      const collector = createEventCollector();
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: TEST_POLICY,
        ctx: TEST_CTX,
      });

      // Act
      const result = await runner.exec(TEST_TOOL_NAME, { value: "test" });

      // Assert - redact() called
      expect(spies.redact).toHaveBeenCalledTimes(1);
      expect(spies.redact).toHaveBeenCalledWith(rawOutput);

      // Assert - result does NOT contain secret (redacted)
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ result: "processed" });
        expect(result.value).not.toHaveProperty("secret");
      }
    });

    it("returns redaction_failed error when redact throws (no raw output leak)", async () => {
      // Arrange
      const rawOutput = { result: "processed", secret: "MUST_NOT_LEAK" };
      const { boundTool, spies } = createSpyableBoundToolRuntime({
        rawOutput,
        redactThrows: true,
      });
      const collector = createEventCollector();
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: TEST_POLICY,
        ctx: TEST_CTX,
      });

      // Act
      const result = await runner.exec(TEST_TOOL_NAME, { value: "test" });

      // Assert - redact was called and threw
      expect(spies.redact).toHaveBeenCalledTimes(1);

      // Assert - error returned, NOT raw output
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errorCode).toBe("redaction_failed");
        // safeMessage should NOT contain the secret
        expect(result.safeMessage).not.toContain("MUST_NOT_LEAK");
      }

      // Assert - event does NOT contain raw output
      const resultEvents = collector.getByType("tool_call_result");
      expect(resultEvents).toHaveLength(1);
      expect(resultEvents[0].isError).toBe(true);
      expect(JSON.stringify(resultEvents[0].result)).not.toContain(
        "MUST_NOT_LEAK"
      );
    });

    it("emitted result contains redacted output, not raw output", async () => {
      // Arrange
      const rawOutput = {
        result: "visible",
        secret: "HIDDEN_SECRET",
        anotherSecret: "ALSO_HIDDEN",
      };
      const { boundTool } = createSpyableBoundToolRuntime({ rawOutput });
      const collector = createEventCollector();
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: TEST_POLICY,
        ctx: TEST_CTX,
      });

      // Act
      await runner.exec(TEST_TOOL_NAME, { value: "test" });

      // Assert - emitted event has redacted output
      const resultEvents = collector.getByType("tool_call_result");
      expect(resultEvents).toHaveLength(1);
      expect(resultEvents[0].result).toEqual({ result: "visible" });
      expect(resultEvents[0].result).not.toHaveProperty("secret");
      expect(resultEvents[0].result).not.toHaveProperty("anotherSecret");
    });
  });

  describe("context and capabilities injection", () => {
    it("passes ToolInvocationContext to exec", async () => {
      // Arrange
      const { boundTool, spies } = createSpyableBoundToolRuntime();
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
        { modelToolCallId: "call_123" }
      );

      // Assert - exec receives context
      expect(spies.exec).toHaveBeenCalledTimes(1);
      const [_validatedArgs, ctx, _capabilities] = spies.exec.mock.calls[0];
      expect(ctx).toMatchObject({
        runId: TEST_RUN_ID,
        toolCallId: "call_123",
      });
    });

    it("passes ToolCapabilities to exec", async () => {
      // Arrange
      const { boundTool, spies } = createSpyableBoundToolRuntime();
      const collector = createEventCollector();
      const source = createTestToolSource({ [TEST_TOOL_NAME]: boundTool });
      const runner = createToolRunner(source, collector.emit, {
        policy: TEST_POLICY,
        ctx: TEST_CTX,
      });

      // Act
      await runner.exec(TEST_TOOL_NAME, { value: "test" });

      // Assert - exec receives capabilities (even if empty)
      expect(spies.exec).toHaveBeenCalledTimes(1);
      const [_validatedArgs, _ctx, capabilities] = spies.exec.mock.calls[0];
      expect(capabilities).toBeDefined();
      expect(typeof capabilities).toBe("object");
    });
  });
});
