// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/openai-compatible/openai-compatible-llm.adapter`
 * Purpose: LlmService implementation for any OpenAI-compatible endpoint (Ollama, vLLM, llama.cpp, LM Studio).
 * Scope: Implements LlmService via standard POST /v1/chat/completions with SSE streaming. Does not handle
 *   credential storage, SSRF validation, or provider-specific quirks.
 * Invariants:
 *   - LLM_SERVICE_ADAPTER: Implements LlmService. Swaps the model backend, not the graph executor.
 *   - OPENAI_WIRE_PROTOCOL: Uses /v1/chat/completions — the de facto standard across all local LLM servers.
 *   - TOKENS_NEVER_LOGGED: Credential values (apiKey, baseUrl) never appear in logs.
 *   - BROKER_RESOLVES_CREDS: Receives pre-resolved { baseUrl, apiKey } — never reads env/DB directly.
 * Side-effects: IO (HTTP calls to user's endpoint)
 * Links: docs/spec/multi-provider-llm.md
 * @internal
 */

import {
  computePromptHash,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
} from "@cogni/node-shared";
import { createParser, type EventSourceMessage } from "eventsource-parser";
import { humanizeModelId } from "@/adapters/server/ai/providers/openai-compatible.provider";
import {
  type ChatDeltaEvent,
  classifyLlmErrorFromStatus,
  LlmError,
  type LlmService,
  type LlmToolCall,
} from "@/ports";
import { makeLogger } from "@/shared/observability";

const log = makeLogger({ component: "OpenAiCompatibleAdapter" });

/** Connection config resolved from ConnectionBrokerPort */
export interface OpenAiCompatibleEndpoint {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
}

/** Connect timeout for TTFB (user servers may be slow to start) */
const CONNECT_TIMEOUT_MS = 30_000;
/** Non-streaming request timeout */
const REQUEST_TIMEOUT_MS = 120_000;

export class OpenAiCompatibleLlmAdapter implements LlmService {
  constructor(private readonly endpoint: OpenAiCompatibleEndpoint) {}

  async completion(
    params: Parameters<LlmService["completion"]>[0]
  ): ReturnType<LlmService["completion"]> {
    if (!params.model) {
      throw new Error("OpenAI-compatible completion requires model parameter");
    }
    const model = params.model;
    const temperature = params.temperature ?? DEFAULT_TEMPERATURE;
    const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;

    const canonicalMessages = params.messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
    const promptHash = computePromptHash({
      model,
      messages: canonicalMessages,
      temperature,
      maxTokens,
    });

    const messages = params.messages.map((msg) => {
      const base: Record<string, unknown> = {
        role: msg.role,
        content: msg.content,
      };
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        base.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      if (msg.role === "tool" && msg.toolCallId) {
        base.tool_call_id = msg.toolCallId;
      }
      return base;
    });

    const response = await this.doFetch(
      {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      },
      REQUEST_TIMEOUT_MS
    );

    if (!response.ok) {
      const kind = classifyLlmErrorFromStatus(response.status);
      log.warn(
        { status: response.status, kind, model },
        "openai-compatible.completion_error"
      );
      throw new LlmError(
        `Endpoint returned ${response.status}`,
        kind,
        response.status
      );
    }

    const data = (await response.json()) as {
      model?: string;
      choices?: Array<{
        message?: { content?: string };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };

    if (
      !data.choices?.[0]?.message?.content &&
      typeof data.choices?.[0]?.message?.content !== "string"
    ) {
      throw new LlmError("Invalid response from endpoint", "unknown");
    }

    const promptTokens = Number(data.usage?.prompt_tokens) || 0;
    const completionTokens = Number(data.usage?.completion_tokens) || 0;
    const resolvedModel = data.model ?? model;
    const firstChoice = data.choices[0];
    const firstMessage = firstChoice?.message?.content;

    if (typeof firstMessage !== "string") {
      throw new LlmError("Invalid response from endpoint", "unknown");
    }

    const result: Awaited<ReturnType<LlmService["completion"]>> = {
      message: {
        role: "assistant",
        content: firstMessage,
      },
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      providerMeta: data as unknown as Record<string, unknown>,
      promptHash,
      resolvedProvider: "openai-compatible",
      resolvedModel,
      resolvedDisplayName: humanizeModelId(resolvedModel),
    };

    if (firstChoice?.finish_reason) {
      result.finishReason = firstChoice.finish_reason;
    }

    log.info(
      {
        model: resolvedModel,
        tokensUsed: promptTokens + completionTokens,
        promptHash,
      },
      "openai-compatible.completion_result"
    );

    return result;
  }

  async completionStream(
    params: Parameters<LlmService["completionStream"]>[0]
  ): ReturnType<LlmService["completionStream"]> {
    if (!params.model) {
      throw new Error(
        "OpenAI-compatible completionStream requires model parameter"
      );
    }
    const model = params.model;
    const temperature = params.temperature ?? DEFAULT_TEMPERATURE;
    const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS;

    const canonicalMessages = params.messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
    const promptHash = computePromptHash({
      model,
      messages: canonicalMessages,
      temperature,
      maxTokens,
    });

    const messages = params.messages.map((msg) => {
      const base: Record<string, unknown> = {
        role: msg.role,
        content: msg.content,
      };
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        base.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }
      if (msg.role === "tool" && msg.toolCallId) {
        base.tool_call_id = msg.toolCallId;
      }
      return base;
    });

    const requestBody: Record<string, unknown> = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true,
    };
    if (params.tools && params.tools.length > 0) {
      requestBody.tools = params.tools;
    }
    if (params.toolChoice) {
      requestBody.tool_choice = params.toolChoice;
    }

    const connectCtl = new AbortController();
    const connectTimer = setTimeout(
      () => connectCtl.abort(),
      CONNECT_TIMEOUT_MS
    );

    let response: Response;
    try {
      const signal = params.abortSignal
        ? AbortSignal.any([connectCtl.signal, params.abortSignal])
        : connectCtl.signal;

      response = await this.doFetch(requestBody, undefined, signal);
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === "AbortError") {
          throw new LlmError("Stream aborted", "aborted");
        }
        if (error.name === "TimeoutError") {
          throw new LlmError("Connect timeout", "timeout", 408);
        }
        throw new LlmError(`Network error: ${error.message}`, "unknown");
      }
      throw new LlmError("Unknown error", "unknown");
    } finally {
      clearTimeout(connectTimer);
    }

    // Retry without tools if endpoint rejects them (e.g., tinyllama)
    if (response.status === 400 && requestBody.tools) {
      const body = await response.text().catch(() => "");
      if (body.includes("does not support tools")) {
        log.info({ model }, "Model does not support tools, retrying without");
        delete requestBody.tools;
        delete requestBody.tool_choice;
        const retryCtl = new AbortController();
        const retryTimer = setTimeout(
          () => retryCtl.abort(),
          CONNECT_TIMEOUT_MS
        );
        try {
          const retrySignal = params.abortSignal
            ? AbortSignal.any([retryCtl.signal, params.abortSignal])
            : retryCtl.signal;
          response = await this.doFetch(requestBody, undefined, retrySignal);
        } finally {
          clearTimeout(retryTimer);
        }
      }
    }

    if (!response.ok) {
      const kind = classifyLlmErrorFromStatus(response.status);
      throw new LlmError(
        `Endpoint returned ${response.status}`,
        kind,
        response.status
      );
    }

    if (!response.body) {
      throw new LlmError("No response body for streaming", "unknown");
    }

    // Build deferred final promise
    let settled = false;
    let resolveFinal!: (
      v: Awaited<
        ReturnType<LlmService["completionStream"]>
      >["final"] extends Promise<infer T>
        ? T
        : never
    ) => void;
    let rejectFinal!: (e: unknown) => void;
    const final = new Promise<
      Awaited<Awaited<ReturnType<LlmService["completionStream"]>>["final"]>
    >((res, rej) => {
      resolveFinal = res;
      rejectFinal = rej;
    });

    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const stream = (async function* (): AsyncIterable<ChatDeltaEvent> {
      let fullContent = "";
      let finishReason: string | undefined;
      let promptTokens = 0;
      let completionTokens = 0;
      /** Accumulator for streamed tool call fragments (by index). */
      const toolCallAccum: Record<
        number,
        { id: string; name: string; args: string }
      > = {};

      // We manually drive the parser and collect events
      const eventQueue: EventSourceMessage[] = [];
      const streamParser = createParser({
        onEvent(event: EventSourceMessage) {
          eventQueue.push(event);
        },
      });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          streamParser.feed(decoder.decode(value, { stream: true }));

          while (eventQueue.length > 0) {
            const event = eventQueue.shift();
            if (!event) continue;
            if (event.data === "[DONE]") continue;

            let parsed: {
              choices?: Array<{
                delta?: {
                  content?: string;
                  tool_calls?: Array<{
                    index: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
                finish_reason?: string | null;
              }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            try {
              parsed = JSON.parse(event.data);
            } catch {
              log.warn(
                { data: event.data.slice(0, 100) },
                "openai-compatible.malformed_sse"
              );
              continue;
            }

            const choice = parsed.choices?.[0];
            if (!choice) continue;

            // Text delta
            if (choice.delta?.content) {
              fullContent += choice.delta.content;
              yield {
                type: "text_delta" as const,
                delta: choice.delta.content,
              };
            }

            // Tool call deltas
            if (choice.delta?.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                if (!toolCallAccum[tc.index]) {
                  toolCallAccum[tc.index] = {
                    id: tc.id ?? "",
                    name: tc.function?.name ?? "",
                    args: "",
                  };
                }
                if (tc.function?.arguments) {
                  const toolCall = toolCallAccum[tc.index];
                  if (toolCall) {
                    toolCall.args += tc.function.arguments;
                  }
                }
              }
            }

            // Finish reason
            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }

            // Usage (sent in final chunk when stream_options.include_usage = true)
            if (parsed.usage) {
              promptTokens = parsed.usage.prompt_tokens ?? 0;
              completionTokens = parsed.usage.completion_tokens ?? 0;
            }
          }
        }

        // Build tool calls from accumulated fragments
        const toolCalls: LlmToolCall[] = Object.values(toolCallAccum).map(
          (tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.args },
          })
        );

        settle(() =>
          resolveFinal({
            message: { role: "assistant" as const, content: fullContent },
            usage: {
              promptTokens,
              completionTokens,
              totalTokens: promptTokens + completionTokens,
            },
            finishReason:
              finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
            providerMeta: {} as Record<string, unknown>,
            promptHash,
            resolvedProvider: "openai-compatible",
            resolvedModel: model,
            resolvedDisplayName: humanizeModelId(model),
          })
        );
      } catch (err) {
        settle(() => rejectFinal(err));
        throw err;
      }
    })();

    return { stream, final };
  }

  private async doFetch(
    body: Record<string, unknown>,
    timeoutMs?: number | undefined,
    signal?: AbortSignal | undefined
  ): Promise<Response> {
    const url = `${this.endpoint.baseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.endpoint.apiKey) {
      headers.Authorization = `Bearer ${this.endpoint.apiKey}`;
    }
    return fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(signal
        ? { signal }
        : timeoutMs
          ? { signal: AbortSignal.timeout(timeoutMs) }
          : {}),
    });
  }
}
