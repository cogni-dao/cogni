// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fakes/ai/tool-builders`
 * Purpose: Builder functions for creating tool-related test data.
 * Scope: Tool fixtures for testing tool-runner, registry, and message serialization. Does NOT contain runtime logic.
 * Invariants: Deterministic output; stable IDs; OpenAI-compatible formats.
 * Side-effects: none
 * Notes: Use these builders in tool use MVP tests.
 * Links: tool-runner.ts, tool-registry.ts, litellm.adapter.ts
 * @public
 */

import type {
  BoundToolRuntime,
  ToolInvocationContext,
  ToolSourcePort,
} from "@cogni/ai-core";
import { createStaticToolSourceFromRecord } from "@cogni/ai-core";
import type { ToolCapabilities } from "@cogni/ai-tools";
import type { Message, MessageToolCall } from "@cogni/node-core";
import { z } from "zod";
import type {
  AiEvent,
  BoundTool,
  ToolContract,
  ToolImplementation,
} from "@/features/ai/types";
import type { LlmToolCall, LlmToolDefinition } from "@/ports";

// ─────────────────────────────────────────────────────────────────────────────
// Test Tool Constants
// ─────────────────────────────────────────────────────────────────────────────

export const TEST_TOOL_NAME = "test_tool" as const;
export const TEST_TOOL_CALL_ID = "call_test_123";

// ─────────────────────────────────────────────────────────────────────────────
// Bound Tool Builders
// ─────────────────────────────────────────────────────────────────────────────

export interface TestToolInput {
  value: string;
}

export interface TestToolOutput {
  result: string;
  secret: string;
}

export interface TestToolRedacted {
  result: string;
}

// Schemas for test tools
const TestToolInputSchema = z.object({
  value: z.string(),
});

const TestToolOutputSchema = z.object({
  result: z.string(),
  secret: z.string(),
});

// Throwing variants for error testing
const ThrowingInputSchema = z
  .object({
    value: z.string(),
  })
  .refine(() => false, { message: "Input validation failed" });

const ThrowingOutputSchema = z
  .object({
    result: z.string(),
    secret: z.string(),
  })
  .refine(() => false, { message: "Output validation failed" });

/**
 * Create a test tool contract with configurable behavior.
 */
export function createTestToolContract(
  options: {
    name?: string;
    validateInputThrows?: boolean;
    validateOutputThrows?: boolean;
    allowlist?: readonly string[];
    effect?: "read_only" | "state_change" | "external_side_effect";
  } = {}
): ToolContract<string, TestToolInput, TestToolOutput, TestToolRedacted> {
  const name = options.name ?? TEST_TOOL_NAME;
  return {
    name,
    description: "A test tool for testing",
    effect: options.effect ?? "read_only",
    inputSchema: options.validateInputThrows
      ? ThrowingInputSchema
      : TestToolInputSchema,
    outputSchema: options.validateOutputThrows
      ? ThrowingOutputSchema
      : TestToolOutputSchema,
    redact: (output: TestToolOutput): TestToolRedacted => {
      return { result: output.result };
    },
    allowlist: (options.allowlist ?? [
      "result",
    ]) as readonly (keyof TestToolOutput)[],
  };
}

/**
 * Create a test tool implementation with configurable behavior.
 */
export function createTestToolImplementation(
  options: {
    result?: string;
    secret?: string;
    throws?: boolean;
    errorMessage?: string;
  } = {}
): ToolImplementation<TestToolInput, TestToolOutput> {
  return {
    execute: async (input: TestToolInput): Promise<TestToolOutput> => {
      if (options.throws) {
        throw new Error(options.errorMessage ?? "Tool execution failed");
      }
      return {
        result: options.result ?? `Processed: ${input.value}`,
        secret: options.secret ?? "hidden_data",
      };
    },
  };
}

/**
 * Create a complete bound tool for testing (ai-tools BoundTool format).
 */
export function createTestBoundTool(
  options: {
    name?: string;
    result?: string;
    validateInputThrows?: boolean;
    validateOutputThrows?: boolean;
    executionThrows?: boolean;
    allowlist?: readonly string[];
    effect?: "read_only" | "state_change" | "external_side_effect";
  } = {}
): BoundTool<string, TestToolInput, TestToolOutput, TestToolRedacted> {
  return {
    contract: createTestToolContract({
      name: options.name,
      validateInputThrows: options.validateInputThrows,
      validateOutputThrows: options.validateOutputThrows,
      allowlist: options.allowlist,
      effect: options.effect,
    }),
    implementation: createTestToolImplementation({
      result: options.result,
      throws: options.executionThrows,
    }),
  };
}

/**
 * Create a BoundToolRuntime for testing (ai-core BoundToolRuntime format).
 * This is the format expected by createToolRunner.
 */
export function createTestBoundToolRuntime(
  options: {
    name?: string;
    result?: string;
    validateInputThrows?: boolean;
    validateOutputThrows?: boolean;
    executionThrows?: boolean;
    allowlist?: readonly string[];
    effect?: "read_only" | "state_change" | "external_side_effect";
  } = {}
): BoundToolRuntime {
  const boundTool = createTestBoundTool(options);
  const contract = boundTool.contract;
  const implementation = boundTool.implementation;
  const name = options.name ?? TEST_TOOL_NAME;
  const effect = options.effect ?? "read_only";

  return {
    id: name,
    spec: {
      name,
      description: contract.description,
      inputSchema: { type: "object" },
      effect,
      redaction: {
        mode: "top_level_only",
        allowlist: (options.allowlist ?? ["result"]) as readonly string[],
      },
    },
    effect,
    requiresConnection: false,
    capabilities: [],

    // Method-based interface
    validateInput(rawArgs: unknown): unknown {
      return contract.inputSchema.parse(rawArgs);
    },
    async exec(
      validatedArgs: unknown,
      _ctx: ToolInvocationContext,
      _capabilities: ToolCapabilities
    ): Promise<unknown> {
      return implementation.execute(validatedArgs as TestToolInput);
    },
    validateOutput(rawOutput: unknown): unknown {
      return contract.outputSchema.parse(rawOutput);
    },
    redact(validatedOutput: unknown): unknown {
      return contract.redact(validatedOutput as TestToolOutput);
    },
  };
}

/**
 * Create a ToolSourcePort from a record of tools (test-only convenience).
 * Production code must use ToolSourcePort directly - this helper is for tests only.
 */
export function createTestToolSource(
  tools: Record<string, BoundToolRuntime>
): ToolSourcePort {
  return createStaticToolSourceFromRecord(tools);
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM Tool Call Builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an LLM tool call (as returned by LLM response).
 */
export function createLlmToolCall(
  options: {
    id?: string;
    name?: string;
    arguments?: string | Record<string, unknown>;
  } = {}
): LlmToolCall {
  const args =
    typeof options.arguments === "string"
      ? options.arguments
      : JSON.stringify(options.arguments ?? { value: "test" });
  return {
    id: options.id ?? TEST_TOOL_CALL_ID,
    type: "function",
    function: {
      name: options.name ?? TEST_TOOL_NAME,
      arguments: args,
    },
  };
}

/**
 * Create an LLM tool definition (for sending to LLM).
 */
export function createLlmToolDefinition(
  options: { name?: string; description?: string } = {}
): LlmToolDefinition {
  return {
    type: "function",
    function: {
      name: options.name ?? TEST_TOOL_NAME,
      description: options.description ?? "A test tool for testing",
      parameters: {
        type: "object",
        properties: {
          value: { type: "string", description: "Test value" },
        },
        required: ["value"],
        additionalProperties: false,
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Message Builders for Tool Use
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an assistant message with tool calls.
 */
export function createAssistantMessageWithToolCalls(
  toolCalls: MessageToolCall[],
  content = ""
): Message {
  return {
    role: "assistant",
    content,
    toolCalls,
  };
}

/**
 * Create a tool result message.
 */
export function createToolResultMessage(
  toolCallId: string,
  result: Record<string, unknown>
): Message {
  return {
    role: "tool",
    content: JSON.stringify(result),
    toolCallId,
  };
}

/**
 * Create a MessageToolCall (embedded in assistant message).
 */
export function createMessageToolCall(
  options: {
    id?: string;
    name?: string;
    arguments?: string | Record<string, unknown>;
  } = {}
): MessageToolCall {
  const args =
    typeof options.arguments === "string"
      ? options.arguments
      : JSON.stringify(options.arguments ?? { value: "test" });
  return {
    id: options.id ?? TEST_TOOL_CALL_ID,
    name: options.name ?? TEST_TOOL_NAME,
    arguments: args,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Collection Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an event collector for testing tool-runner emissions.
 */
export function createEventCollector(): {
  emit: (event: AiEvent) => void;
  events: AiEvent[];
  getByType: <T extends AiEvent["type"]>(
    type: T
  ) => Extract<AiEvent, { type: T }>[];
} {
  const events: AiEvent[] = [];
  return {
    emit: (event: AiEvent) => events.push(event),
    events,
    getByType: <T extends AiEvent["type"]>(type: T) =>
      events.filter((e): e is Extract<AiEvent, { type: T }> => e.type === type),
  };
}
