// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/services/message-preparation`
 * Purpose: Transform raw messages into LLM-ready format with validation.
 * Scope: Message filtering, validation, trimming, system prompt application, fallback promptHash computation. Does NOT perform credit checks or IO.
 * Invariants:
 *   - Filters client system messages (defense-in-depth)
 *   - Validates message length per MAX_MESSAGE_CHARS
 *   - Trims conversation history to fit context window
 *   - Prepends baseline system prompt exactly once
 *   - Computes fallback promptHash for error path availability
 * Side-effects: none (pure)
 * Notes: Per COMPLETION_REFACTOR_PLAN.md P1 extraction
 * Links: completion.ts, core/chat/rules.ts, core/ai/system-prompt.server.ts
 * @public
 */

import {
  applyBaselineSystemPrompt,
  assertMessageLength,
  estimateTotalTokens,
  filterSystemMessages,
  MAX_MESSAGE_CHARS,
  type Message,
  trimConversationHistory,
} from "@cogni/node-core";
import {
  computePromptHash,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
} from "@cogni/node-shared";

/**
 * Result of message preparation.
 * Contains LLM-ready messages and metadata for downstream processing.
 */
export interface PreparedMessages {
  /** Messages ready for LLM call (with system prompt prepended) */
  readonly messages: Message[];
  /** Fallback promptHash computed before LLM call (for error path) */
  readonly fallbackPromptHash: string;
  /** Estimated token count for credit pre-flight check */
  readonly estimatedTokensUpperBound: number;
}

/**
 * Prepare raw messages for LLM execution.
 *
 * 1. Filters system messages (defense-in-depth)
 * 2. Validates message length per MAX_MESSAGE_CHARS
 * 3. Trims conversation history to fit context window
 * 4. Prepends baseline system prompt
 * 5. Computes fallback promptHash for error path availability
 * 6. Estimates token count for credit check
 *
 * @param rawMessages - Messages from client
 * @param model - Model identifier for hash computation
 * @returns PreparedMessages with LLM-ready messages and metadata
 * @throws ChatValidationError if message exceeds length limit
 */
export function prepareMessages(
  rawMessages: Message[],
  model: string
): PreparedMessages {
  // 1. Remove any client-provided system messages (defense-in-depth)
  const userMessages = filterSystemMessages(rawMessages);

  // 2. Validate message length
  for (const message of userMessages) {
    assertMessageLength(message.content, MAX_MESSAGE_CHARS);
  }

  // 3. Trim conversation history to fit context window
  const trimmedMessages = trimConversationHistory(
    userMessages,
    MAX_MESSAGE_CHARS
  );

  // 4. Prepend baseline system prompt (exactly once, always first)
  const finalMessages = applyBaselineSystemPrompt(trimmedMessages);

  // 5. Estimate token count (includes system prompt)
  const estimatedTokensUpperBound = estimateTotalTokens(finalMessages);

  // 6. Compute fallback promptHash for error path availability
  // Per AI_SETUP_SPEC.md: prompt_hash must be available on error path
  // Messages are converted to LLM-ready format (role + content only, no timestamp)
  const llmMessages = finalMessages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const fallbackPromptHash = computePromptHash({
    model,
    messages: llmMessages,
    temperature: DEFAULT_TEMPERATURE,
    maxTokens: DEFAULT_MAX_TOKENS,
  });

  return {
    messages: finalMessages,
    fallbackPromptHash,
    estimatedTokensUpperBound,
  };
}
