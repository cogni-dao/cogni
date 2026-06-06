// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/ai.completions.endpoint-parity`
 * Purpose: Verify POST /v1/chat/completions route handler produces OpenAI-compatible responses.
 * Scope: Tests the actual route handler with mocked deps to ensure responses match what an OpenAI SDK client expects. Does not test real LLM calls.
 * Invariants:
 *   - Non-streaming response matches OpenAI ChatCompletion shape (id, object, choices, usage)
 *   - Streaming response uses SSE with data: {json}\n\n format and data: [DONE]\n\n terminator
 *   - Error responses use OpenAI error format: { error: { message, type, param, code } }
 *   - All responses parseable by chatCompletionsContract schemas
 * Side-effects: none
 * Links: ai.completions.v1.contract, route.ts, OpenAI API reference
 * @public
 */

import { chatCompletionsContract } from "@cogni/node-contracts";
import { ChatErrorCode, ChatValidationError } from "@cogni/node-shared";
import {
  createCompletionRequest,
  createMockAccountServiceWithDefaults,
  FakeAiTelemetryAdapter,
  FakeClock,
  TEST_SESSION_USER_1,
} from "@tests/_fakes";
import { TEST_MODEL_ID } from "@tests/_fakes/ai/fakes";
import {
  createRunStreamMock,
  createTemporalClientMock,
} from "@tests/_fixtures/ai/completion-facade-setup";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LlmError } from "@/ports";

// Mock auth
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

// Mock bootstrap container (getContainer needed by wrapRouteHandlerWithLogging)
vi.mock("@/bootstrap/container", () => ({
  resolveAiAdapterDeps: vi.fn(),
  getTemporalWorkflowClient: vi.fn(),
  getContainer: vi.fn().mockReturnValue({
    config: { unhandledErrorPolicy: "throw" },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    },
    clock: { now: () => new Date("2025-01-15T12:00:00.000Z") },
    runStream: {
      subscribe: async function* () {
        yield {
          id: "1-0",
          event: { type: "text_delta" as const, delta: "hello" },
        };
        yield {
          id: "2-0",
          event: {
            type: "done" as const,
            usage: { promptTokens: 5, completionTokens: 10 },
            finishReason: "stop",
          },
        };
      },
    },
  }),
}));

// Mock preflight credit check
vi.mock("@/features/ai/public.server", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/features/ai/public.server")>();
  return {
    ...original,
    preflightCreditCheck: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/shared/config", () => ({
  getNodeId: () => "node_template",
}));

import { getSessionUser } from "@/app/_lib/auth/session";
import {
  getContainer,
  getTemporalWorkflowClient,
  resolveAiAdapterDeps,
} from "@/bootstrap/container";

const mockGetSessionUser = vi.mocked(getSessionUser);
const mockGetContainer = vi.mocked(getContainer);
const mockGetTemporalWorkflowClient = vi.mocked(getTemporalWorkflowClient);
const mockResolveAiAdapterDeps = vi.mocked(resolveAiAdapterDeps);

function setupMocks(
  options: {
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
    finishReason?: string;
  } = {}
) {
  const { responseContent = "Hello! How can I help you?" } = options;

  const fakeClock = new FakeClock("2025-01-15T12:00:00.000Z");
  const mockAccountService = createMockAccountServiceWithDefaults();

  // Restore getContainer mock (reset by vi.resetAllMocks in beforeEach)
  mockGetContainer.mockReturnValue({
    config: { unhandledErrorPolicy: "throw" },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    },
    clock: fakeClock,
    runStream: createRunStreamMock({
      responseContent,
      toolCalls: options.toolCalls,
      statusEvents: options.statusEvents,
      usageReport: {
        inputTokens: 15,
        outputTokens: 25,
        model: TEST_MODEL_ID,
      },
    }),
  } as never);
  mockGetTemporalWorkflowClient.mockResolvedValue(
    createTemporalClientMock() as never
  );

  mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_1);

  mockResolveAiAdapterDeps.mockReturnValue({
    llmService: {} as never,
    accountService: mockAccountService,
    clock: fakeClock,
    aiTelemetry: new FakeAiTelemetryAdapter(),
    langfuse: undefined,
  });
}

/**
 * Set up mocks where the workflow start throws a specific error.
 */
function setupMocksWithError(error: Error) {
  const fakeClock = new FakeClock("2025-01-15T12:00:00.000Z");
  const mockAccountService = createMockAccountServiceWithDefaults();

  mockGetContainer.mockReturnValue({
    config: { unhandledErrorPolicy: "throw" },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    },
    clock: fakeClock,
    runStream: createRunStreamMock({ responseContent: "" }),
  } as never);

  mockGetSessionUser.mockResolvedValue(TEST_SESSION_USER_1);

  mockResolveAiAdapterDeps.mockReturnValue({
    llmService: {} as never,
    accountService: mockAccountService,
    clock: fakeClock,
    aiTelemetry: new FakeAiTelemetryAdapter(),
    langfuse: undefined,
  });

  mockGetTemporalWorkflowClient.mockResolvedValue(
    createTemporalClientMock({
      start: vi.fn().mockRejectedValue(error),
    }) as never
  );
}

/**
 * Parse SSE stream into individual data payloads.
 */
async function parseSSE(
  response: Response
): Promise<{ chunks: unknown[]; rawLines: string[] }> {
  const text = await response.text();
  const rawLines = text.split("\n\n").filter((l) => l.startsWith("data: "));
  const chunks: unknown[] = [];

  for (const line of rawLines) {
    const data = line.replace("data: ", "");
    if (data === "[DONE]") continue;
    chunks.push(JSON.parse(data));
  }

  return { chunks, rawLines };
}

describe("OpenAI Endpoint Parity (POST /v1/chat/completions)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("non-streaming response parity", () => {
    it("should return response matching OpenAI ChatCompletion shape exactly", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(
            createCompletionRequest({
              messages: [{ role: "user", content: "Hello" }],
            })
          ),
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(200);

      const json = await response.json();

      // Verify against OpenAI contract schema
      expect(() => chatCompletionsContract.output.parse(json)).not.toThrow();

      // Verify exact OpenAI field presence
      expect(json).toHaveProperty("id");
      expect(json).toHaveProperty("object", "chat.completion");
      expect(json).toHaveProperty("created");
      expect(json).toHaveProperty("model");
      expect(json).toHaveProperty("choices");
      expect(json).toHaveProperty("usage");

      // Verify id format: chatcmpl-{id}
      expect(json.id).toMatch(/^chatcmpl-/);

      // Verify created is Unix timestamp (seconds)
      expect(typeof json.created).toBe("number");
      expect(json.created).toBeGreaterThan(1_000_000_000); // After year 2001
      expect(json.created).toBeLessThan(10_000_000_000); // Before year 2286 (seconds, not ms)

      // Verify choices structure
      expect(json.choices).toHaveLength(1);
      expect(json.choices[0]).toHaveProperty("index", 0);
      expect(json.choices[0]).toHaveProperty("message");
      expect(json.choices[0].message).toHaveProperty("role", "assistant");
      expect(json.choices[0].message).toHaveProperty("content");
      expect(typeof json.choices[0].message.content).toBe("string");
      expect(json.choices[0]).toHaveProperty("finish_reason", "stop");

      // Verify usage structure
      expect(json.usage).toHaveProperty("prompt_tokens");
      expect(json.usage).toHaveProperty("completion_tokens");
      expect(json.usage).toHaveProperty("total_tokens");
      expect(json.usage.total_tokens).toBe(
        json.usage.prompt_tokens + json.usage.completion_tokens
      );
    });

    it("should return Content-Type: application/json", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest()),
        }
      );

      const response = await POST(req);
      expect(response.headers.get("content-type")).toContain(
        "application/json"
      );
    });

    it("should include tool_calls in response when model uses tools", async () => {
      setupMocks({
        responseContent: "",
        toolCalls: [
          {
            toolCallId: "call_abc123",
            toolName: "get_weather",
            args: { location: "NYC" },
          },
        ],
        finishReason: "tool_calls",
      });

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(
            createCompletionRequest({
              messages: [{ role: "user", content: "What's the weather?" }],
            })
          ),
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(200);

      const json = await response.json();
      expect(() => chatCompletionsContract.output.parse(json)).not.toThrow();
      expect(json.choices[0]?.finish_reason).toBe("tool_calls");
    });
  });

  describe("streaming response parity", () => {
    it("should return SSE with correct Content-Type and headers", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(
            createCompletionRequest({
              stream: true,
            })
          ),
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.headers.get("cache-control")).toBe("no-cache");
    });

    it("should emit SSE chunks in data: {json}\\n\\n format ending with data: [DONE]", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(
            createCompletionRequest({
              stream: true,
            })
          ),
        }
      );

      const response = await POST(req);
      const text = await response.text();

      // Every data line must be "data: " prefixed
      const lines = text.split("\n\n").filter(Boolean);
      for (const line of lines) {
        expect(line).toMatch(/^data: /);
      }

      // Must end with [DONE] (OpenAI spec)
      expect(text).toContain("data: [DONE]");
    });

    it("should emit role announcement as first chunk (OpenAI convention)", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest({ stream: true })),
        }
      );

      const response = await POST(req);
      const { chunks } = await parseSSE(response);

      // First chunk must announce role
      const firstChunk = chunks[0] as Record<string, unknown>;
      expect(firstChunk.object).toBe("chat.completion.chunk");
      expect(() =>
        chatCompletionsContract.chunk.parse(firstChunk)
      ).not.toThrow();

      const choices = firstChunk.choices as Array<{
        delta: { role?: string };
      }>;
      expect(choices[0]?.delta.role).toBe("assistant");
    });

    it("should emit finish_reason in final content chunk", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest({ stream: true })),
        }
      );

      const response = await POST(req);
      const { chunks } = await parseSSE(response);

      // All chunks should pass schema validation
      for (const chunk of chunks) {
        expect(() => chatCompletionsContract.chunk.parse(chunk)).not.toThrow();
      }

      // Find chunk with finish_reason
      const finishChunks = chunks.filter((c) => {
        const choices = (c as Record<string, unknown>).choices as Array<{
          finish_reason: string | null;
        }>;
        return choices?.[0]?.finish_reason !== null;
      });
      expect(finishChunks.length).toBeGreaterThan(0);

      const finishChunk = finishChunks[0] as Record<string, unknown>;
      const choices = finishChunk.choices as Array<{
        finish_reason: string;
      }>;
      expect(choices[0]?.finish_reason).toBe("stop");
    });

    it("should include usage chunk when stream_options.include_usage is true", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(
            createCompletionRequest({
              stream: true,
              stream_options: { include_usage: true },
            })
          ),
        }
      );

      const response = await POST(req);
      const { chunks } = await parseSSE(response);

      // Find usage chunk (empty choices, usage present)
      const usageChunks = chunks.filter((c) => {
        const obj = c as Record<string, unknown>;
        return obj.usage !== undefined && obj.usage !== null;
      });
      expect(usageChunks.length).toBe(1);

      const usageChunk = usageChunks[0] as Record<string, unknown>;
      expect(() =>
        chatCompletionsContract.chunk.parse(usageChunk)
      ).not.toThrow();

      const usage = usageChunk.usage as {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
      expect(usage.prompt_tokens).toBe(15);
      expect(usage.completion_tokens).toBe(25);
      expect(usage.total_tokens).toBe(40);
    });

    it("should stream tool_call_start events as OpenAI tool_calls delta", async () => {
      setupMocks({
        responseContent: "",
        toolCalls: [
          {
            toolCallId: "call_xyz789",
            toolName: "search",
            args: { query: "hello world" },
          },
        ],
        finishReason: "tool_calls",
      });

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest({ stream: true })),
        }
      );

      const response = await POST(req);
      const { chunks } = await parseSSE(response);

      // Find chunk with tool_calls delta
      const toolCallChunks = chunks.filter((c) => {
        const choices = (c as Record<string, unknown>).choices as Array<{
          delta: { tool_calls?: unknown[] };
        }>;
        return choices?.[0]?.delta?.tool_calls !== undefined;
      });
      expect(toolCallChunks.length).toBeGreaterThan(0);

      // Validate tool call chunk structure matches OpenAI spec
      const tcChunk = toolCallChunks[0] as Record<string, unknown>;
      expect(() => chatCompletionsContract.chunk.parse(tcChunk)).not.toThrow();

      const choices = tcChunk.choices as Array<{
        delta: {
          tool_calls: Array<{
            index: number;
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      const tc = choices[0]?.delta.tool_calls[0];
      expect(tc).toBeDefined();
      expect(tc?.index).toBe(0);
      expect(tc?.id).toBe("call_xyz789");
      expect(tc?.type).toBe("function");
      expect(tc?.function.name).toBe("search");
      expect(tc?.function.arguments).toBe('{"query":"hello world"}');
    });
  });

  describe("error response parity", () => {
    it("should return OpenAI error format for invalid JSON body", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: "not json",
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(400);

      const json = await response.json();
      expect(() => chatCompletionsContract.error.parse(json)).not.toThrow();
      expect(json.error.type).toBe("invalid_request_error");
    });

    it("should return OpenAI error format for missing required fields", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify({ messages: [] }), // Missing model
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(400);

      const json = await response.json();
      expect(() => chatCompletionsContract.error.parse(json)).not.toThrow();
      expect(json.error.type).toBe("invalid_request_error");
    });

    it("should return 429 for LlmError with rate_limited kind", async () => {
      setupMocksWithError(
        new LlmError("Rate limit exceeded", "rate_limited", 429)
      );

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest()),
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(429);

      const json = await response.json();
      expect(() => chatCompletionsContract.error.parse(json)).not.toThrow();
      expect(json.error.type).toBe("rate_limit_error");
      expect(json.error.code).toBe("rate_limit_exceeded");
    });

    it("should return 408 for LlmError with timeout kind", async () => {
      setupMocksWithError(new LlmError("Request timed out", "timeout", 408));

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest()),
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(408);

      const json = await response.json();
      expect(() => chatCompletionsContract.error.parse(json)).not.toThrow();
      expect(json.error.type).toBe("timeout_error");
    });

    it("should return 404 for LlmError with status 404", async () => {
      setupMocksWithError(new LlmError("Model not found", "provider_4xx", 404));

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest()),
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(404);

      const json = await response.json();
      expect(() => chatCompletionsContract.error.parse(json)).not.toThrow();
      expect(json.error.code).toBe("model_not_found");
      expect(json.error.param).toBe("model");
    });

    it("should return 503 for LlmError with unknown kind", async () => {
      setupMocksWithError(new LlmError("Something went wrong", "unknown"));

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest()),
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(503);

      const json = await response.json();
      expect(() => chatCompletionsContract.error.parse(json)).not.toThrow();
      expect(json.error.type).toBe("server_error");
    });

    it("should return 400 for ChatValidationError", async () => {
      setupMocksWithError(
        new ChatValidationError(
          ChatErrorCode.MESSAGE_TOO_LONG,
          "Message exceeds maximum length"
        )
      );

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest()),
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(400);

      const json = await response.json();
      expect(() => chatCompletionsContract.error.parse(json)).not.toThrow();
      expect(json.error.type).toBe("invalid_request_error");
      expect(json.error.message).toContain("Message exceeds maximum length");
    });

    it("should return 401 for unauthenticated requests", async () => {
      vi.resetAllMocks();
      // Re-setup getContainer after reset
      mockGetContainer.mockReturnValue({
        config: { unhandledErrorPolicy: "throw" },
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
          child: vi.fn().mockReturnThis(),
        },
        clock: { now: () => new Date() },
      } as never);
      mockGetSessionUser.mockResolvedValue(null);

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest()),
        }
      );

      const response = await POST(req);
      expect(response.status).toBe(401);
    });
  });

  describe("cogni_status streaming", () => {
    it("emits cogni_status chunks for StatusEvents during streaming", async () => {
      setupMocks({
        statusEvents: [
          { phase: "thinking" },
          { phase: "tool_use", label: "search" },
        ],
      });

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest({ stream: true })),
        }
      );

      const response = await POST(req);
      const { chunks } = await parseSSE(response);

      const statusChunks = chunks.filter(
        (c) => (c as Record<string, unknown>).cogni_status !== undefined
      );
      expect(statusChunks).toHaveLength(2);

      const s0 = (statusChunks[0] as Record<string, unknown>).cogni_status as {
        phase: string;
        label?: string;
      };
      expect(s0.phase).toBe("thinking");
      expect(s0.label).toBeUndefined();

      const s1 = (statusChunks[1] as Record<string, unknown>).cogni_status as {
        phase: string;
        label?: string;
      };
      expect(s1.phase).toBe("tool_use");
      expect(s1.label).toBe("search");
    });

    it("preserves standard OpenAI fields on status chunks", async () => {
      setupMocks({ statusEvents: [{ phase: "compacting" }] });

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest({ stream: true })),
        }
      );

      const response = await POST(req);
      const { chunks } = await parseSSE(response);

      const statusChunk = chunks.find(
        (c) => (c as Record<string, unknown>).cogni_status !== undefined
      ) as Record<string, unknown>;
      expect(statusChunk).toBeDefined();

      // Must still be a valid ChatCompletionChunk
      expect(() =>
        chatCompletionsContract.chunk.parse(statusChunk)
      ).not.toThrow();
      expect(statusChunk.id).toMatch(/^chatcmpl-/);
      expect(statusChunk.object).toBe("chat.completion.chunk");
      expect(statusChunk.model).toBe(TEST_MODEL_ID);

      const choices = statusChunk.choices as Array<{
        delta: Record<string, unknown>;
        finish_reason: string | null;
      }>;
      expect(choices[0]?.delta).toEqual({});
      expect(choices[0]?.finish_reason).toBeNull();
    });

    it("does not emit cogni_status when no StatusEvents are present", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest({ stream: true })),
        }
      );

      const response = await POST(req);
      const { chunks } = await parseSSE(response);

      const statusChunks = chunks.filter(
        (c) => (c as Record<string, unknown>).cogni_status !== undefined
      );
      expect(statusChunks).toHaveLength(0);
    });

    it("does not include cogni_status in non-streaming responses", async () => {
      setupMocks({ statusEvents: [{ phase: "thinking" }] });

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest()),
        }
      );

      const response = await POST(req);
      const json = await response.json();
      expect(json.cogni_status).toBeUndefined();
    });
  });

  describe("field-level compatibility with OpenAI SDK expectations", () => {
    it("should never include extra non-standard fields in top-level response", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(createCompletionRequest()),
        }
      );

      const response = await POST(req);
      const json = await response.json();

      // OpenAI ChatCompletion top-level fields
      const allowedKeys = new Set([
        "id",
        "object",
        "created",
        "model",
        "choices",
        "usage",
        "system_fingerprint",
        "service_tier",
      ]);
      const extraKeys = Object.keys(json).filter((k) => !allowedKeys.has(k));
      expect(extraKeys).toEqual([]);
    });

    it("should use OpenAI model echo convention (response.model matches request.model)", async () => {
      setupMocks();

      const { POST } = await import("@/app/api/v1/chat/completions/route");

      const req = new NextRequest(
        "http://localhost:3000/api/v1/chat/completions",
        {
          method: "POST",
          body: JSON.stringify(
            createCompletionRequest({ model: TEST_MODEL_ID })
          ),
        }
      );

      const response = await POST(req);
      const json = await response.json();
      expect(json.model).toBe(TEST_MODEL_ID);
    });
  });
});
