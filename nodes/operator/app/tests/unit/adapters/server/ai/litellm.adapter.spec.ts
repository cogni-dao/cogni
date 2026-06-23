// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/litellm`
 * Purpose: Unit tests for LiteLLM adapter with mocked HTTP calls and error handling.
 * Scope: Tests adapter logic, parameter handling, response parsing, missing cost handling. Does NOT test real LiteLLM service.
 * Invariants: No real HTTP calls; deterministic responses; model param required; USAGE_UNIT_IS_LITELLM_CALL_ID
 * Side-effects: none (mocked fetch)
 * Notes: Tests error handling, timeout enforcement, response mapping, missing model validation. No DEFAULT_MODEL - model must be explicitly provided.
 * Links: src/adapters/server/ai/litellm.adapter.ts, LlmService port
 * @public
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { LiteLlmAdapter } from "@/adapters/server/ai/litellm.adapter";
import type { LlmCaller, LlmService } from "@/ports";

// Mock the serverEnv module - LITELLM_BASE_URL and LITELLM_MASTER_KEY needed
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({
    LITELLM_BASE_URL: "https://api.test-litellm.com",
    LITELLM_MASTER_KEY: "test-master-key-secret",
  }),
}));

// Capture logger.warn calls for private error diagnostic assertions (bug.0059)
const { mockLoggerWarn } = vi.hoisted(() => ({
  mockLoggerWarn: vi.fn(),
}));
vi.mock("@/shared/observability", () => ({
  makeLogger: () => ({
    warn: mockLoggerWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnValue({
      warn: mockLoggerWarn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
  EVENT_NAMES: {},
}));

describe("LiteLlmAdapter", () => {
  let adapter: LlmService;
  const testCaller: LlmCaller = {
    billingAccountId: "test-user-123",
    virtualKeyId: "vk-test-1",
    requestId: "req-test-abc",
    traceId: "trace-test-xyz",
  };

  // Mock fetch globally
  const mockFetch = vi.fn();

  beforeEach(() => {
    adapter = new LiteLlmAdapter();
    vi.clearAllMocks();
    global.fetch = mockFetch;
  });

  /**
   * Build a mock fetch Response that streams SSE chunks via body.getReader().
   * Models LiteLLM's streaming response shape (used by completionStream()).
   * Each entry in `chunks` is sent as one reader.read() value; caller supplies
   * the raw SSE frames (e.g. `data: {...}\n\n`, `data: [DONE]\n\n`).
   */
  function makeSseResponse(chunks: string[], headers: Headers = new Headers()) {
    const reads = chunks.map((c) => ({
      done: false as const,
      value: new TextEncoder().encode(c),
    }));
    let read = vi.fn();
    for (const r of reads) {
      read = read.mockResolvedValueOnce(r);
    }
    read = read.mockResolvedValueOnce({ done: true, value: undefined });

    return {
      ok: true,
      headers,
      body: {
        getReader: () => ({ read, releaseLock: vi.fn() }),
      },
    };
  }

  /** Drain a stream to completion (triggers SSE parsing + final settlement). */
  async function drain(
    stream: AsyncIterable<import("@/ports").ChatDeltaEvent>
  ): Promise<void> {
    for await (const _ of stream) {
      // discard deltas; we assert on `final` / request shape
    }
  }

  describe("completionStream method", () => {
    const basicParams = {
      model: "gpt-3.5-turbo", // model is required (no env fallback)
      messages: [{ role: "user" as const, content: "Hello world" }],
      caller: testCaller,
    };

    /** Standard happy-path SSE frames: one content delta, a usage event, DONE. */
    const successFrames = [
      'data: {"choices":[{"delta":{"content":"Hello! How can I help you today?"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":8,"total_tokens":18}}\n\n',
      "data: [DONE]\n\n",
    ];

    it("sends correct request to LiteLLM API with master key auth", async () => {
      mockFetch.mockResolvedValueOnce(makeSseResponse(successFrames));

      const { stream } = await adapter.completionStream(basicParams);
      await drain(stream);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.test-litellm.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer test-master-key-secret", // Uses master key, not per-user virtual key
          },
          body: JSON.stringify({
            model: "gpt-3.5-turbo", // explicitly provided (required)
            messages: [{ role: "user", content: "Hello world" }],
            temperature: 0.7, // default
            max_tokens: 4096, // default
            user: "test-user-123", // billingAccountId for cost attribution
            metadata: {
              cogni_billing_account_id: "test-user-123",
              request_id: "req-test-abc",
              existing_trace_id: "trace-test-xyz",
            },
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: expect.any(AbortSignal),
        }
      );
    });

    it("uses provided parameters over defaults", async () => {
      mockFetch.mockResolvedValueOnce(makeSseResponse(successFrames));

      const { stream } = await adapter.completionStream({
        ...basicParams,
        model: "custom-model",
        temperature: 0.2,
        maxTokens: 1024,
      });
      await drain(stream);

      const firstCall = mockFetch.mock.calls[0];
      expect(firstCall).toBeDefined();
      const requestOptions = firstCall?.[1];
      expect(requestOptions).toBeDefined();
      const requestBody = JSON.parse(requestOptions?.body as string);
      expect(requestBody).toEqual({
        model: "custom-model",
        messages: [{ role: "user", content: "Hello world" }],
        temperature: 0.2,
        max_tokens: 1024,
        user: "test-user-123",
        metadata: {
          cogni_billing_account_id: "test-user-123",
          request_id: "req-test-abc",
          existing_trace_id: "trace-test-xyz",
        },
        stream: true,
        stream_options: { include_usage: true },
      });
    });

    it("resolves final with usage and cost from header", async () => {
      const headers = new Headers();
      headers.set("x-litellm-response-cost", "0.0002");
      headers.set("x-litellm-call-id", "litellm-call-abc-123");

      mockFetch.mockResolvedValueOnce(makeSseResponse(successFrames, headers));

      const { stream, final } = await adapter.completionStream(basicParams);
      await drain(stream);
      const result = await final;

      expect(result).toEqual({
        message: {
          role: "assistant",
          content: "Hello! How can I help you today?",
        },
        finishReason: "stop",
        providerMeta: { model: "gpt-3.5-turbo", provider: "openai" },
        usage: {
          promptTokens: 10,
          completionTokens: 8,
          totalTokens: 18,
        },
        providerCostUsd: 0.0002,
        litellmCallId: "litellm-call-abc-123", // From x-litellm-call-id header only (USAGE_UNIT_IS_LITELLM_CALL_ID)
        // New fields per AI_SETUP_SPEC.md
        promptHash: expect.any(String), // SHA-256 hash of canonical payload
        resolvedProvider: "openai", // Inferred from "gpt-" prefix in model name
        resolvedModel: "gpt-3.5-turbo", // From request param (SSE doesn't return it)
      });
    });

    it("omits providerCostUsd when no cost in header or usage event", async () => {
      // No cost header AND no usage.cost field → cost must be absent
      mockFetch.mockResolvedValueOnce(makeSseResponse(successFrames));

      const { stream, final } = await adapter.completionStream(basicParams);
      await drain(stream);
      const result = await final;

      // Message should still be returned
      expect(result.message.content).toBe("Hello! How can I help you today?");
      expect(result.message.role).toBe("assistant");

      // providerCostUsd should be absent (not undefined)
      expect(result).not.toHaveProperty("providerCostUsd");

      // Other fields should still be present
      expect(result.usage).toEqual({
        promptTokens: 10,
        completionTokens: 8,
        totalTokens: 18,
      });
    });

    it("handles multiple messages correctly", async () => {
      mockFetch.mockResolvedValueOnce(makeSseResponse(successFrames));

      const { stream } = await adapter.completionStream({
        ...basicParams,
        messages: [
          { role: "system", content: "You are helpful" },
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" },
          { role: "user", content: "How are you?" },
        ],
      });
      await drain(stream);

      const firstCall = mockFetch.mock.calls[0];
      expect(firstCall).toBeDefined();
      const requestOptions = firstCall?.[1];
      expect(requestOptions).toBeDefined();
      const requestBody = JSON.parse(requestOptions?.body as string);
      expect(requestBody.messages).toEqual([
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "How are you?" },
      ]);
    });

    it("throws error when API returns non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => '{"error":"invalid api key"}',
      });

      await expect(adapter.completionStream(basicParams)).rejects.toThrow(
        "LiteLLM API error: 401 Unauthorized"
      );
    });

    it("handles fetch network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      await expect(adapter.completionStream(basicParams)).rejects.toThrow(
        "LiteLLM stream init failed: Network error"
      );
    });

    it("handles unknown error", async () => {
      mockFetch.mockRejectedValueOnce("Unknown error string");

      await expect(adapter.completionStream(basicParams)).rejects.toThrow(
        "LiteLLM stream init failed: Unknown error"
      );
    });

    it("throws error when model parameter is missing", async () => {
      const paramsWithoutModel = {
        messages: [{ role: "user" as const, content: "Hello" }],
        caller: testCaller,
      };

      await expect(
        adapter.completionStream(paramsWithoutModel)
      ).rejects.toThrow("LiteLLM completionStream requires model parameter");

      // Verify fetch was never called
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("handles different finish reasons", async () => {
      const frames = [
        'data: {"choices":[{"delta":{"content":"Response"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
        'data: {"usage":{"prompt_tokens":10,"completion_tokens":8,"total_tokens":18}}\n\n',
        "data: [DONE]\n\n",
      ];
      mockFetch.mockResolvedValueOnce(makeSseResponse(frames));

      const { stream, final } = await adapter.completionStream(basicParams);
      await drain(stream);
      const result = await final;
      expect(result.finishReason).toBe("length");
    });
  });

  describe("AI_SETUP_SPEC.md: Correlation ID propagation", () => {
    it("includes request_id and trace_id in LiteLLM metadata", async () => {
      mockFetch.mockResolvedValueOnce(
        makeSseResponse([
          'data: {"choices":[{"delta":{"content":"test"},"finish_reason":"stop"}]}\n\n',
          'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
          "data: [DONE]\n\n",
        ])
      );

      const { stream } = await adapter.completionStream({
        model: "test-model",
        messages: [{ role: "user", content: "test" }],
        caller: {
          billingAccountId: "acc-123",
          virtualKeyId: "vk-456",
          requestId: "req-correlation-test",
          traceId: "trace-correlation-test",
        },
      });
      await drain(stream);

      const requestBody = JSON.parse(
        mockFetch.mock.calls[0]?.[1]?.body as string
      );
      expect(requestBody.metadata).toEqual({
        cogni_billing_account_id: "acc-123",
        request_id: "req-correlation-test",
        existing_trace_id: "trace-correlation-test",
      });
    });
  });

  describe("bug.0059: private error diagnostics in operator logs", () => {
    const errorTestParams = {
      model: "openai/gpt-4",
      messages: [{ role: "user" as const, content: "Hello" }],
      caller: testCaller,
    };

    it("logs responseExcerpt on HTTP error", async () => {
      const errorBody =
        '{"error":{"message":"No endpoints found for gpt-4","type":"invalid_request_error"}}';
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => errorBody,
      });

      await expect(adapter.completionStream(errorTestParams)).rejects.toThrow();

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 404,
          kind: "provider_4xx",
          requestId: testCaller.requestId,
          traceId: testCaller.traceId,
          model: "openai/gpt-4",
          provider: "openai",
          responseExcerpt: expect.stringContaining("No endpoints found"),
        }),
        "adapter.litellm.stream_http_error"
      );
    });

    it("redacts secrets in responseExcerpt", async () => {
      const bodyWithSecret =
        '{"error":"auth failed","key":"sk-1234567890abcdefghijklmnopqrstuvwxyz"}';
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => bodyWithSecret,
      });

      await expect(adapter.completionStream(errorTestParams)).rejects.toThrow();

      const logPayload = mockLoggerWarn.mock.calls[0]?.[0];
      expect(logPayload?.responseExcerpt).not.toContain("sk-1234567890");
      expect(logPayload?.responseExcerpt).toContain("[REDACTED");
    });

    it("logs rootCauseKind on network error", async () => {
      const networkErr = new Error("connect ECONNREFUSED 127.0.0.1:4000");
      networkErr.cause = { code: "ECONNREFUSED" };
      mockFetch.mockRejectedValueOnce(networkErr);

      await expect(adapter.completionStream(errorTestParams)).rejects.toThrow();

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          rootCauseKind: "network",
          errorMessage: "connect ECONNREFUSED 127.0.0.1:4000",
          causeCode: "ECONNREFUSED",
          requestId: testCaller.requestId,
        }),
        "adapter.litellm.stream_network_error"
      );
    });

    it("logs rootCauseKind on timeout", async () => {
      const timeoutErr = new Error("The operation was aborted");
      timeoutErr.name = "TimeoutError";
      mockFetch.mockRejectedValueOnce(timeoutErr);

      await expect(adapter.completionStream(errorTestParams)).rejects.toThrow();

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          rootCauseKind: "timeout",
          requestId: testCaller.requestId,
        }),
        "adapter.litellm.stream_network_error"
      );
    });

    it("returns [unreadable] when response body cannot be read", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: async () => {
          throw new Error("body already consumed");
        },
      });

      await expect(adapter.completionStream(errorTestParams)).rejects.toThrow();

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          responseExcerpt: "[unreadable]",
        }),
        "adapter.litellm.stream_http_error"
      );
    });
  });

  describe("bug.0057: completionStream() with x-litellm-spend-logs-metadata header", () => {
    const streamTestParams = {
      model: "openai/gpt-4",
      messages: [{ role: "user" as const, content: "Hello" }],
      caller: testCaller,
    };

    const mockStreamResponse = {
      ok: true,
      headers: new Headers([["x-litellm-call-id", "stream-call-xyz"]]),
      body: {
        getReader: () => ({
          read: vi
            .fn()
            .mockResolvedValueOnce({
              done: false,
              value: new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'
              ),
            })
            .mockResolvedValueOnce({
              done: false,
              value: new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":" there"}}]}\n\n'
              ),
            })
            .mockResolvedValueOnce({
              done: false,
              value: new TextEncoder().encode(
                'data: {"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}\n\n'
              ),
            })
            .mockResolvedValueOnce({
              done: false,
              value: new TextEncoder().encode("data: [DONE]\n\n"),
            })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          releaseLock: vi.fn(),
        }),
      },
    };

    it("sets x-litellm-spend-logs-metadata header in completionStream when spendLogsMetadata provided", async () => {
      mockFetch.mockResolvedValueOnce(mockStreamResponse);

      await adapter.completionStream({
        ...streamTestParams,
        spendLogsMetadata: { run_id: "run-xyz", graph_id: "langgraph:poet" },
      });

      const requestOptions = mockFetch.mock.calls[0]?.[1];
      expect(requestOptions?.headers).toEqual(
        expect.objectContaining({
          "x-litellm-spend-logs-metadata": JSON.stringify({
            run_id: "run-xyz",
            graph_id: "langgraph:poet",
          }),
        })
      );
    });

    it("does not set x-litellm-spend-logs-metadata header in completionStream when spendLogsMetadata absent", async () => {
      mockFetch.mockResolvedValueOnce(mockStreamResponse);

      await adapter.completionStream(streamTestParams);

      const requestOptions = mockFetch.mock.calls[0]?.[1];
      expect(requestOptions?.headers).not.toHaveProperty(
        "x-litellm-spend-logs-metadata"
      );
    });
  });

  describe("LlmService interface compliance", () => {
    it("implements LlmService interface correctly", () => {
      const service: LlmService = adapter;
      expect(service.completionStream).toBeTypeOf("function");
    });

    it("completionStream method returns a promise", () => {
      mockFetch.mockResolvedValueOnce(
        makeSseResponse([
          'data: {"choices":[{"delta":{"content":"test"},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ])
      );

      const result = adapter.completionStream({
        model: "test-model", // model is required
        messages: [{ role: "user", content: "test" }],
        caller: testCaller,
      });

      expect(result).toBeInstanceOf(Promise);
    });
  });
});
