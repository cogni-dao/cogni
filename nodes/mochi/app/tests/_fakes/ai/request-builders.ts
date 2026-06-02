// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fakes/ai/request-builders`
 * Purpose: Builder functions for creating AI request bodies with all required fields.
 * Scope: Request creation utilities for stack/contract tests. Does NOT handle actual API calls.
 * Invariants: All required fields have defaults; OpenAI-compatible format.
 * Side-effects: none
 * Notes: Builds OpenAI Chat Completions API compatible request bodies.
 * Links: ai.completions.v1.contract, ai.chat.v1.contract
 * @public
 */

import type { Message } from "@cogni/node-core";
import { TEST_MODEL_ID } from "./test-constants";

/**
 * Default graph name for test requests.
 * Per GRAPH_ID_NAMESPACED: format is ${providerId}:${graphName}
 */
export const TEST_GRAPH_NAME = "langgraph:poet";

/**
 * Options for OpenAI-compatible completion request builder.
 */
export interface CompletionRequestOptions {
  /** Messages array (defaults to single user message "Hello") */
  messages?: Array<{ role: string; content: string }>;
  /** Model ID (defaults to TEST_MODEL_ID) */
  model?: string;
  /** Graph name (extension field, defaults to TEST_GRAPH_NAME) */
  graph_name?: string;
  /** Enable streaming */
  stream?: boolean;
  /** Stream options */
  stream_options?: { include_usage?: boolean };
  /** Temperature */
  temperature?: number;
  /** Max tokens */
  max_tokens?: number;
}

/**
 * Options for chat request builder (P1 — single message string).
 */
export interface ChatRequestOptions {
  /** User message text (defaults to "Hello") */
  message?: string;
  /** Fully-resolved model reference (defaults to platform/TEST_MODEL_ID) */
  modelRef?: { providerKey: string; modelId: string; connectionId?: string };
  /** Graph name or fully-qualified graphId (defaults to TEST_GRAPH_NAME) */
  graphName?: string;
  /** Optional state key for multi-turn conversations */
  stateKey?: string;
}

/**
 * Create an OpenAI-compatible chat completions request body.
 *
 * Per chatCompletionsContract: requires model, messages.
 * graph_name is an optional extension field.
 *
 * @example
 * ```ts
 * const body = createCompletionRequest({
 *   messages: [{ role: "user", content: "Hello" }],
 * });
 * const req = new NextRequest("http://localhost/api/v1/chat/completions", {
 *   method: "POST",
 *   body: JSON.stringify(body),
 * });
 * ```
 */
export function createCompletionRequest(
  options: CompletionRequestOptions = {}
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    messages: options.messages ?? [{ role: "user", content: "Hello" }],
    model: options.model ?? TEST_MODEL_ID,
  };

  // Optional extension field
  if (options.graph_name !== undefined) {
    result.graph_name = options.graph_name;
  } else {
    result.graph_name = TEST_GRAPH_NAME;
  }

  if (options.stream !== undefined) result.stream = options.stream;
  if (options.stream_options !== undefined)
    result.stream_options = options.stream_options;
  if (options.temperature !== undefined)
    result.temperature = options.temperature;
  if (options.max_tokens !== undefined) result.max_tokens = options.max_tokens;

  return result;
}

/**
 * Create a chat request body for v1/ai/chat endpoint (P1 format).
 *
 * Per ai.chat.v1.contract: requires message (string), model, graphName.
 * Supports optional stateKey.
 *
 * @example
 * ```ts
 * const body = createChatRequest({
 *   message: "Hello",
 *   stateKey: "conv-123",
 * });
 * const req = new NextRequest("http://localhost/api/v1/ai/chat", {
 *   method: "POST",
 *   body: JSON.stringify(body),
 * });
 * ```
 */
export function createChatRequest(options: ChatRequestOptions = {}): {
  message: string;
  modelRef: { providerKey: string; modelId: string; connectionId?: string };
  graphName: string;
  stateKey?: string;
} {
  const base = {
    message: options.message ?? "Hello",
    modelRef: options.modelRef ?? {
      providerKey: "platform",
      modelId: TEST_MODEL_ID,
    },
    graphName: options.graphName ?? TEST_GRAPH_NAME,
  };

  // Add optional fields if provided
  return {
    ...base,
    ...(options.stateKey && { stateKey: options.stateKey }),
  };
}

/**
 * Create an OpenAI-compatible request body from Message[] (internal format).
 * Converts from Message[] to OpenAI message format.
 *
 * @example
 * ```ts
 * const messages = [createUserMessage("Hello"), createAssistantMessage("Hi")];
 * const body = createCompletionRequestFromMessages(messages);
 * ```
 */
export function createCompletionRequestFromMessages(
  messages: Message[],
  options?: Omit<CompletionRequestOptions, "messages">
): ReturnType<typeof createCompletionRequest> {
  return createCompletionRequest({
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    ...options,
  });
}
