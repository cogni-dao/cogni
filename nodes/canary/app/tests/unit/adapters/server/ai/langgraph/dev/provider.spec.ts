// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ai/langgraph/dev/provider.spec`
 * Purpose: Unit tests for LangGraphDevProvider stateKey requirements.
 * Scope: Tests stateKey validation, input filtering, error handling. Does NOT test real SDK calls.
 * Invariants:
 *   - THREAD_KEY_REQUIRED: Missing stateKey returns invalid_request error
 *   - STATEFUL_ONLY: Only last user message sent to server
 * Side-effects: none (mocked SDK)
 * Links: src/adapters/server/ai/langgraph/dev/provider.ts, LANGGRAPH_SERVER.md
 * @public
 */

import { createUserMessage } from "@tests/_fakes";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runInScope } from "@/adapters/server/ai/execution-scope";
import {
  LangGraphDevProvider,
  type LangGraphDevProviderConfig,
} from "@/adapters/server/ai/langgraph/dev/provider";
import type { GraphRunRequest } from "@/ports";

// Test constants
const TEST_BILLING_ACCOUNT_ID = "test-billing-account-123";
const TEST_VIRTUAL_KEY_ID = "vk-test-456";
const TEST_RUN_ID = "run-test-789";
const TEST_GRAPH_NAME = "poet";
const TEST_GRAPH_ID = `langgraph:${TEST_GRAPH_NAME}`;

/**
 * Create a mock LangGraph SDK Client.
 * Only mocks the methods used by LangGraphDevProvider.
 */
function createMockClient() {
  return {
    threads: {
      create: vi.fn().mockResolvedValue({ thread_id: "mock-thread-id" }),
    },
    runs: {
      stream: vi.fn().mockReturnValue(
        (async function* () {
          yield {
            event: "messages",
            data: { "0": { type: "ai", content: "Hello" } },
          };
        })()
      ),
    },
  };
}

/**
 * Create a base GraphRunRequest for testing.
 */
function createTestRequest(
  overrides: Partial<GraphRunRequest> = {}
): GraphRunRequest {
  return {
    runId: TEST_RUN_ID,
    graphId: TEST_GRAPH_ID,
    modelRef: { providerKey: "platform", modelId: "gpt-4o" },
    messages: [createUserMessage("Hello")],
    ...overrides,
  };
}

const TEST_SCOPE = {
  billing: {
    billingAccountId: TEST_BILLING_ACCOUNT_ID,
    virtualKeyId: TEST_VIRTUAL_KEY_ID,
  },
  llmService: {
    completion: vi.fn(),
    completionStream: vi.fn(),
  } as unknown as import("@/ports").LlmService,
  usageSource: "litellm" as const,
};

/** Run fn within execution scope (needed for getExecutionScope() calls in provider). */
function withScope<T>(fn: () => T): T {
  return runInScope(TEST_SCOPE, fn);
}

describe("adapters/server/ai/langgraph/dev/provider", () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let provider: LangGraphDevProvider;
  const config: LangGraphDevProviderConfig = {
    availableGraphs: [TEST_GRAPH_NAME],
  };

  beforeEach(() => {
    mockClient = createMockClient();
    // Cast to unknown then to Client type to satisfy TypeScript
    provider = new LangGraphDevProvider(
      mockClient as unknown as import("@langchain/langgraph-sdk").Client,
      config
    );
    vi.clearAllMocks();
  });

  describe("THREAD_KEY_REQUIRED invariant", () => {
    it("returns invalid_request error when stateKey is missing", async () => {
      const request = createTestRequest({ stateKey: undefined });

      const result = withScope(() => provider.runGraph(request));

      // Consume stream to get events
      const events: unknown[] = [];
      for await (const event of result.stream) {
        events.push(event);
      }

      // Should emit error + done
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ type: "error", error: "invalid_request" });
      expect(events[1]).toEqual({ type: "done" });

      // Final should resolve with error
      const final = await result.final;
      expect(final.ok).toBe(false);
      expect(final.error).toBe("invalid_request");
    });

    it("returns invalid_request error when stateKey is empty string", async () => {
      const request = createTestRequest({ stateKey: "" });

      const result = withScope(() => provider.runGraph(request));

      const events: unknown[] = [];
      for await (const event of result.stream) {
        events.push(event);
      }

      expect(events[0]).toEqual({ type: "error", error: "invalid_request" });

      const final = await result.final;
      expect(final.ok).toBe(false);
    });

    it("proceeds when stateKey is provided", async () => {
      const request = createTestRequest({ stateKey: "valid-thread-key" });

      const result = withScope(() => provider.runGraph(request));

      // Consume stream
      const events: unknown[] = [];
      for await (const event of result.stream) {
        events.push(event);
      }

      // Should have called SDK (not returned early with error)
      expect(mockClient.threads.create).toHaveBeenCalled();
      expect(mockClient.runs.stream).toHaveBeenCalled();
    });
  });

  describe("STATEFUL_ONLY invariant", () => {
    it("sends only the last user message to SDK", async () => {
      const messages = [
        createUserMessage("First message"),
        { role: "assistant" as const, content: "First response" },
        createUserMessage("Second message"),
        { role: "assistant" as const, content: "Second response" },
        createUserMessage("Latest message"),
      ];

      const request = createTestRequest({
        messages,
        stateKey: "test-thread",
      });

      withScope(() => provider.runGraph(request));

      // Drain the stream to trigger execution
      const result = withScope(() => provider.runGraph(request));
      for await (const _ of result.stream) {
        // consume
      }

      // Verify SDK was called with only the last user message
      expect(mockClient.runs.stream).toHaveBeenCalledWith(
        expect.any(String), // threadId (UUIDv5)
        TEST_GRAPH_NAME,
        expect.objectContaining({
          input: {
            messages: [
              expect.objectContaining({
                role: "user",
                content: "Latest message",
              }),
            ],
          },
        })
      );
    });

    it("handles conversation with only one user message", async () => {
      const request = createTestRequest({
        messages: [createUserMessage("Only message")],
        stateKey: "test-thread",
      });

      const result = withScope(() => provider.runGraph(request));
      for await (const _ of result.stream) {
        // consume
      }

      expect(mockClient.runs.stream).toHaveBeenCalledWith(
        expect.any(String),
        TEST_GRAPH_NAME,
        expect.objectContaining({
          input: {
            messages: [
              expect.objectContaining({
                role: "user",
                content: "Only message",
              }),
            ],
          },
        })
      );
    });

    it("returns error when no user message exists", async () => {
      const request = createTestRequest({
        messages: [
          { role: "assistant" as const, content: "Assistant only" },
          { role: "system" as const, content: "System message" },
        ],
        stateKey: "test-thread",
      });

      const result = withScope(() => provider.runGraph(request));

      const events: unknown[] = [];
      for await (const event of result.stream) {
        events.push(event);
      }

      // Should emit error for missing user message
      expect(events.some((e) => (e as { type: string }).type === "error")).toBe(
        true
      );
    });
  });

  describe("thread derivation", () => {
    it("creates thread with tenant-scoped ID", async () => {
      const request = createTestRequest({ stateKey: "my-thread" });

      const result = withScope(() => provider.runGraph(request));
      for await (const _ of result.stream) {
        // consume
      }

      // Thread create should be called with UUIDv5 format
      expect(mockClient.threads.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
          ),
          ifExists: "do_nothing",
          metadata: {
            billingAccountId: TEST_BILLING_ACCOUNT_ID,
            stateKey: "my-thread",
          },
        })
      );
    });

    it("uses same threadId for same billingAccountId + stateKey", async () => {
      const request1 = createTestRequest({ stateKey: "same-thread" });
      const request2 = createTestRequest({ stateKey: "same-thread" });

      // Run twice
      const result1 = withScope(() => provider.runGraph(request1));
      for await (const _ of result1.stream) {
        // consume
      }

      const result2 = withScope(() => provider.runGraph(request2));
      for await (const _ of result2.stream) {
        // consume
      }

      // Both calls should use the same threadId
      const call1ThreadId = mockClient.threads.create.mock.calls[0][0].threadId;
      const call2ThreadId = mockClient.threads.create.mock.calls[1][0].threadId;
      expect(call1ThreadId).toBe(call2ThreadId);
    });

    it("uses different threadId for different billingAccountId", async () => {
      const request = createTestRequest({ stateKey: "same-thread" });

      const scopeA = {
        billing: {
          billingAccountId: "tenant-a",
          virtualKeyId: TEST_VIRTUAL_KEY_ID,
        },
        usageSource: "litellm" as const,
      };
      const scopeB = {
        billing: {
          billingAccountId: "tenant-b",
          virtualKeyId: TEST_VIRTUAL_KEY_ID,
        },
        usageSource: "litellm" as const,
      };

      // Run both with different billing scopes
      const result1 = runInScope(scopeA, () => provider.runGraph(request));
      for await (const _ of result1.stream) {
        // consume
      }

      const result2 = runInScope(scopeB, () => provider.runGraph(request));
      for await (const _ of result2.stream) {
        // consume
      }

      // ThreadIds should differ (tenant isolation)
      const call1ThreadId = mockClient.threads.create.mock.calls[0][0].threadId;
      const call2ThreadId = mockClient.threads.create.mock.calls[1][0].threadId;
      expect(call1ThreadId).not.toBe(call2ThreadId);
    });
  });

  describe("error handling", () => {
    it("returns not_found for unknown graph", async () => {
      const request = createTestRequest({
        graphId: "langgraph:unknown-graph",
        stateKey: "test-thread",
      });

      const result = withScope(() => provider.runGraph(request));

      const events: unknown[] = [];
      for await (const event of result.stream) {
        events.push(event);
      }

      expect(events[0]).toEqual({ type: "error", error: "not_found" });

      const final = await result.final;
      expect(final.ok).toBe(false);
      expect(final.error).toBe("not_found");
    });

    it("returns invalid_request for malformed graphId", async () => {
      const request = createTestRequest({
        graphId: "invalid-format", // Missing "langgraph:" prefix
        stateKey: "test-thread",
      });

      const result = withScope(() => provider.runGraph(request));

      const events: unknown[] = [];
      for await (const event of result.stream) {
        events.push(event);
      }

      expect(events[0]).toEqual({ type: "error", error: "invalid_request" });
    });
  });
});
