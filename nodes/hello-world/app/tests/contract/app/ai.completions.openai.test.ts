// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/ai.completions.openai`
 * Purpose: Contract tests for OpenAI-compatible Chat Completions endpoint.
 * Scope: Validates request/response schemas match OpenAI spec. Does not test real LLM calls or HTTP routing.
 * Invariants:
 *   - Input schema accepts all valid OpenAI Chat Completions requests
 *   - Output schema matches OpenAI ChatCompletion response format
 *   - Chunk schema matches OpenAI ChatCompletionChunk format
 *   - Error schema matches OpenAI error response format
 * Side-effects: none
 * Links: ai.completions.v1.contract, OpenAI API reference
 * @public
 */

import {
  type ChatCompletionChunk,
  type ChatCompletionInput,
  type ChatCompletionOutput,
  chatCompletionsContract,
} from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";
import { chatMessagesToDtos } from "@/app/_facades/ai/completion.server";

describe("OpenAI Chat Completions Contract", () => {
  describe("input schema", () => {
    it("should accept minimal valid request (model + messages)", () => {
      const input = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      };
      expect(() => chatCompletionsContract.input.parse(input)).not.toThrow();
    });

    it("should accept all standard OpenAI message roles", () => {
      const input = {
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You are a helpful assistant" },
          { role: "user", content: "Hello" },
          {
            role: "assistant",
            content: "Hi there!",
            tool_calls: [
              {
                id: "call_123",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"location":"NYC"}',
                },
              },
            ],
          },
          {
            role: "tool",
            content: '{"temp": 72}',
            tool_call_id: "call_123",
          },
        ],
      };
      expect(() => chatCompletionsContract.input.parse(input)).not.toThrow();
    });

    it("should accept all optional OpenAI parameters", () => {
      const input: ChatCompletionInput = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        temperature: 0.7,
        top_p: 0.9,
        n: 1,
        stream: false,
        stop: ["\n", "END"],
        max_tokens: 100,
        max_completion_tokens: 200,
        presence_penalty: 0.5,
        frequency_penalty: -0.5,
        logit_bias: { "50256": -100 },
        user: "user-123",
        seed: 42,
        response_format: { type: "json_object" },
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get current weather",
              parameters: {
                type: "object",
                properties: {
                  location: { type: "string" },
                },
                required: ["location"],
              },
            },
          },
        ],
        tool_choice: "auto",
      };
      expect(() => chatCompletionsContract.input.parse(input)).not.toThrow();
    });

    it("should accept stream_options with include_usage", () => {
      const input = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
        stream_options: { include_usage: true },
      };
      expect(() => chatCompletionsContract.input.parse(input)).not.toThrow();
    });

    it("should accept tool_choice as specific function", () => {
      const input = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        tool_choice: {
          type: "function",
          function: { name: "get_weather" },
        },
      };
      expect(() => chatCompletionsContract.input.parse(input)).not.toThrow();
    });

    it("should accept response_format with json_schema", () => {
      const input = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "person",
            strict: true,
            schema: {
              type: "object",
              properties: {
                name: { type: "string" },
                age: { type: "number" },
              },
              required: ["name", "age"],
              additionalProperties: false,
            },
          },
        },
      };
      expect(() => chatCompletionsContract.input.parse(input)).not.toThrow();
    });

    it("should accept graph_name extension field", () => {
      const input = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        graph_name: "langgraph:poet",
      };
      const parsed = chatCompletionsContract.input.parse(input);
      expect(parsed.graph_name).toBe("langgraph:poet");
    });

    it("should reject missing model", () => {
      const input = {
        messages: [{ role: "user", content: "Hello" }],
      };
      expect(() => chatCompletionsContract.input.parse(input)).toThrow();
    });

    it("should reject missing messages", () => {
      const input = { model: "gpt-4o" };
      expect(() => chatCompletionsContract.input.parse(input)).toThrow();
    });

    it("should reject invalid role", () => {
      const input = {
        model: "gpt-4o",
        messages: [{ role: "admin", content: "Hello" }],
      };
      expect(() => chatCompletionsContract.input.parse(input)).toThrow();
    });

    it("should reject temperature out of range", () => {
      const input = {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        temperature: 3,
      };
      expect(() => chatCompletionsContract.input.parse(input)).toThrow();
    });

    it("should reject tool message without tool_call_id", () => {
      const input = {
        model: "gpt-4o",
        messages: [{ role: "tool", content: "result" }],
      };
      expect(() => chatCompletionsContract.input.parse(input)).toThrow();
    });

    it("should accept assistant message with null content when tool_calls present", () => {
      const input = {
        model: "gpt-4o",
        messages: [
          { role: "user", content: "What's the weather?" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"location":"NYC"}',
                },
              },
            ],
          },
        ],
      };
      expect(() => chatCompletionsContract.input.parse(input)).not.toThrow();
    });
  });

  describe("output schema (ChatCompletion)", () => {
    it("should validate a standard ChatCompletion response", () => {
      const output: ChatCompletionOutput = {
        id: "chatcmpl-abc123",
        object: "chat.completion",
        created: 1677858242,
        model: "gpt-4o-2024-08-06",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "Hello! How can I help you today?",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 13,
          completion_tokens: 7,
          total_tokens: 20,
        },
      };
      expect(() => chatCompletionsContract.output.parse(output)).not.toThrow();
    });

    it("should validate response with tool_calls", () => {
      const output: ChatCompletionOutput = {
        id: "chatcmpl-abc123",
        object: "chat.completion",
        created: 1677858242,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_abc123",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: '{"location":"NYC"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 30,
          total_tokens: 80,
        },
      };
      expect(() => chatCompletionsContract.output.parse(output)).not.toThrow();
    });

    it("should require object to be 'chat.completion'", () => {
      const output = {
        id: "chatcmpl-abc123",
        object: "wrong_object",
        created: 1677858242,
        model: "gpt-4o",
        choices: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      expect(() => chatCompletionsContract.output.parse(output)).toThrow();
    });

    it("should validate finish_reason values", () => {
      const validReasons = ["stop", "length", "tool_calls", "content_filter"];
      for (const reason of validReasons) {
        const output: ChatCompletionOutput = {
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 1677858242,
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "test" },
              finish_reason:
                reason as ChatCompletionOutput["choices"][0]["finish_reason"],
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
        expect(() =>
          chatCompletionsContract.output.parse(output)
        ).not.toThrow();
      }
    });
  });

  describe("chunk schema (ChatCompletionChunk)", () => {
    it("should validate first streaming chunk (role announcement)", () => {
      const chunk: ChatCompletionChunk = {
        id: "chatcmpl-abc123",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: null,
          },
        ],
      };
      expect(() => chatCompletionsContract.chunk.parse(chunk)).not.toThrow();
    });

    it("should validate content delta chunk", () => {
      const chunk: ChatCompletionChunk = {
        id: "chatcmpl-abc123",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: { content: "Hello" },
            finish_reason: null,
          },
        ],
      };
      expect(() => chatCompletionsContract.chunk.parse(chunk)).not.toThrow();
    });

    it("should validate final chunk with finish_reason", () => {
      const chunk: ChatCompletionChunk = {
        id: "chatcmpl-abc123",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
      };
      expect(() => chatCompletionsContract.chunk.parse(chunk)).not.toThrow();
    });

    it("should validate usage chunk (stream_options.include_usage)", () => {
      const chunk: ChatCompletionChunk = {
        id: "chatcmpl-abc123",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o",
        choices: [],
        usage: {
          prompt_tokens: 13,
          completion_tokens: 7,
          total_tokens: 20,
        },
      };
      expect(() => chatCompletionsContract.chunk.parse(chunk)).not.toThrow();
    });

    it("should validate tool call delta chunk", () => {
      const chunk: ChatCompletionChunk = {
        id: "chatcmpl-abc123",
        object: "chat.completion.chunk",
        created: 1677652288,
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc123",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: '{"lo',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };
      expect(() => chatCompletionsContract.chunk.parse(chunk)).not.toThrow();
    });

    it("should require object to be 'chat.completion.chunk'", () => {
      const chunk = {
        id: "chatcmpl-abc123",
        object: "chat.completion", // Wrong!
        created: 1677652288,
        model: "gpt-4o",
        choices: [],
      };
      expect(() => chatCompletionsContract.chunk.parse(chunk)).toThrow();
    });
  });

  describe("error schema", () => {
    it("should validate standard OpenAI error response", () => {
      const error = {
        error: {
          message: "You exceeded your current quota.",
          type: "insufficient_quota",
          param: null,
          code: "insufficient_quota",
        },
      };
      expect(() => chatCompletionsContract.error.parse(error)).not.toThrow();
    });

    it("should validate error with param", () => {
      const error = {
        error: {
          message: "The model does not exist.",
          type: "invalid_request_error",
          param: "model",
          code: "model_not_found",
        },
      };
      expect(() => chatCompletionsContract.error.parse(error)).not.toThrow();
    });
  });

  describe("chatMessagesToDtos", () => {
    it("should convert system message", () => {
      const dtos = chatMessagesToDtos([
        { role: "system", content: "You are helpful" },
      ]);
      expect(dtos).toEqual([{ role: "system", content: "You are helpful" }]);
    });

    it("should convert user message", () => {
      const dtos = chatMessagesToDtos([{ role: "user", content: "Hello" }]);
      expect(dtos).toEqual([{ role: "user", content: "Hello" }]);
    });

    it("should convert assistant message with tool_calls", () => {
      const dtos = chatMessagesToDtos([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function" as const,
              function: { name: "get_weather", arguments: '{"loc":"NYC"}' },
            },
          ],
        },
      ]);
      expect(dtos).toEqual([
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_1",
              name: "get_weather",
              arguments: '{"loc":"NYC"}',
            },
          ],
        },
      ]);
    });

    it("should convert tool message", () => {
      const dtos = chatMessagesToDtos([
        { role: "tool", content: '{"temp": 72}', tool_call_id: "call_1" },
      ]);
      expect(dtos).toEqual([
        {
          role: "tool",
          content: '{"temp": 72}',
          toolCallId: "call_1",
        },
      ]);
    });

    it("should convert full conversation", () => {
      const dtos = chatMessagesToDtos([
        { role: "system", content: "You are helpful" },
        { role: "user", content: "What's 2+2?" },
        { role: "assistant", content: "4" },
        { role: "user", content: "Thanks!" },
      ]);
      expect(dtos).toHaveLength(4);
      expect(dtos[0]?.role).toBe("system");
      expect(dtos[1]?.role).toBe("user");
      expect(dtos[2]?.role).toBe("assistant");
      expect(dtos[3]?.role).toBe("user");
    });
  });
});
