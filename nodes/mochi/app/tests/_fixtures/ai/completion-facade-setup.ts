// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fixtures/ai/completion-facade-setup`
 * Purpose: Reusable test fixture for completion facade tests with proper dependency mocking.
 * Scope: Provides consistent mock setup for testing completion.server.ts facade. Does NOT test real dependencies.
 * Invariants: All mocks configured; dependencies properly injected; serverEnv mocked
 * Side-effects: none
 * Notes: Use this to ensure consistent test setup and prevent ad-hoc mocks in test files
 * Links: completion.server.ts, FakeLlmService, FakeClock, AiAdapterDeps
 * @public
 */

import { FakeClock } from "@tests/_fakes";
import { createMockAccountServiceWithDefaults } from "@tests/_fakes/accounts/mock-account.service";
import { FakeLlmService } from "@tests/_fakes/ai/fakes";
import { vi } from "vitest";

import type { AiAdapterDeps } from "@/bootstrap/container";

/**
 * Setup completion facade test environment with mocked dependencies
 * Call this before importing the facade module to ensure mocks are in place
 */
export function setupCompletionFacadeTest() {
  const llmService = new FakeLlmService({ responseContent: "Test response" });
  const accountService = createMockAccountServiceWithDefaults();
  const clock = new FakeClock("2025-01-01T00:00:00.000Z");

  return {
    llmService,
    accountService,
    clock,
    mockBillingAccount: {
      id: "test-billing-account",
      defaultVirtualKeyId: "test-vk-id",
    },
  };
}

/**
 * Create a mock AiAdapterDeps object matching the container export shape.
 * Use this with vi.doMock("@/bootstrap/container", ...) to mock resolveAiAdapterDeps.
 *
 * @param overrides - Optional partial overrides for specific deps
 * @returns Complete AiAdapterDeps mock
 */
export function createMockAiAdapterDeps(
  overrides?: Partial<AiAdapterDeps>
): AiAdapterDeps {
  const base = setupCompletionFacadeTest();

  return {
    llmService: base.llmService,
    accountService: base.accountService,
    clock: base.clock,
    aiTelemetry: {
      recordInvocation: vi.fn().mockResolvedValue(undefined),
    },
    langfuse: undefined,
    ...overrides,
  };
}

/** Options for configuring the mock Redis run stream. */
export interface RunStreamMockOptions {
  responseContent?: string;
  toolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }>;
  statusEvents?: Array<{
    phase: "thinking" | "tool_use" | "compacting";
    label?: string;
  }>;
  usageReport?: {
    inputTokens: number;
    outputTokens: number;
    model: string;
  };
  /** If true, emit an error event instead of done. */
  emitError?: string;
}

/**
 * Create a mock RunStreamPort.subscribe generator with configurable events.
 * Order: status → tool_calls → text_delta + assistant_final → usage_report → done/error.
 */
export function createRunStreamMock(options: RunStreamMockOptions = {}) {
  const { responseContent = "Test response" } = options;
  return {
    subscribe: async function* () {
      if (options.statusEvents) {
        for (const se of options.statusEvents) {
          yield {
            id: "s-1",
            event: {
              type: "status" as const,
              phase: se.phase,
              ...(se.label ? { label: se.label } : {}),
            },
          };
        }
      }
      if (options.toolCalls) {
        for (const tc of options.toolCalls) {
          yield {
            id: "t-1",
            event: {
              type: "tool_call_start" as const,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              args: tc.args,
            },
          };
        }
      }
      if (responseContent) {
        yield {
          id: "m-1",
          event: { type: "text_delta" as const, delta: responseContent },
        };
        yield {
          id: "a-1",
          event: {
            type: "assistant_final" as const,
            content: responseContent,
          },
        };
      }
      if (options.usageReport) {
        yield {
          id: "u-1",
          event: {
            type: "usage_report" as const,
            fact: {
              inputTokens: options.usageReport.inputTokens,
              outputTokens: options.usageReport.outputTokens,
              usageUnitId: "unit-1",
              occurredAt: new Date().toISOString(),
              runId: "run-1",
              billingAccountId: "acct-1",
              virtualKeyId: "vk-1",
              model: options.usageReport.model,
              provider: "test",
              source: "litellm",
            },
          },
        };
      }
      if (options.emitError) {
        yield {
          id: "e-1",
          event: { type: "error" as const, error: options.emitError },
        };
      } else {
        yield {
          id: "d-1",
          event: {
            type: "done" as const,
            ...(options.usageReport
              ? {
                  usage: {
                    promptTokens: options.usageReport.inputTokens,
                    completionTokens: options.usageReport.outputTokens,
                  },
                  finishReason: options.toolCalls?.length
                    ? "tool_calls"
                    : "stop",
                }
              : {}),
          },
        };
      }
    },
  };
}

/**
 * Create a mock getTemporalWorkflowClient return value.
 * Single source of truth for the { client, taskQueue } shape.
 */
export function createTemporalClientMock(overrides?: {
  start?: ReturnType<typeof vi.fn>;
}) {
  return {
    client: { start: overrides?.start ?? vi.fn().mockResolvedValue({}) },
    taskQueue: "scheduler-tasks",
  };
}

/**
 * Create the mock object for vi.doMock("@/bootstrap/container", ...).
 * Returns an object with resolveAiAdapterDeps that returns the provided deps.
 *
 * @param deps - AiAdapterDeps to return from resolveAiAdapterDeps
 * @param streamOptions - Optional RunStreamMockOptions for configurable stream
 * @returns Mock module shape for @/bootstrap/container
 */
export function createContainerMock(
  deps: AiAdapterDeps,
  streamOptions?: RunStreamMockOptions
) {
  return {
    resolveAiAdapterDeps: () => deps,
    getTemporalWorkflowClient: async () => createTemporalClientMock(),
    getContainer: () => ({
      runStream: createRunStreamMock(streamOptions),
    }),
  };
}

/**
 * Create the mock object for vi.doMock("@/bootstrap/graph-executor.factory", ...).
 * Returns a factory that creates a mock GraphExecutorPort.
 *
 * Per ASSISTANT_FINAL_REQUIRED: success mocks MUST emit exactly one
 * assistant_final event before done. Violating this masks contract bugs.
 *
 * @returns Mock module shape for @/bootstrap/graph-executor.factory
 */
export function createGraphExecutorFactoryMock() {
  return {
    createScopedGraphExecutor: (params: {
      executor: { runGraph: (req: unknown, ctx?: unknown) => unknown };
    }) => params.executor,
    createGraphExecutor: () => ({
      runGraph: () => {
        const stream = (async function* () {
          yield { type: "text_delta" as const, delta: "Test response" };
          // ASSISTANT_FINAL_REQUIRED: exactly one before done on success
          yield { type: "assistant_final" as const, content: "Test response" };
          yield { type: "done" as const };
        })();

        const final = Promise.resolve({
          ok: true as const,
          runId: "test-run-id",
          requestId: "test-req-id",
          finishReason: "stop" as const,
        });

        return { stream, final };
      },
      listGraphs: () => [],
    }),
  };
}
