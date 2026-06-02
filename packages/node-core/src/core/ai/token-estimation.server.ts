// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@core/ai/token-estimation.server`
 * Purpose: Provides token estimation utilities for pre-flight checks.
 * Scope: Pure functions for estimating token counts. Does not perform actual tokenization or cost calculation.
 * Invariants: Estimator must be conservative and deterministic.
 * Side-effects: none
 * Links: Used by completion service
 * @internal
 */

import type { Message } from "../chat/model";

// Conservative estimate for completion tokens (most responses are 200-400 tokens)
export const DEFAULT_MAX_COMPLETION_TOKENS = 512;
export const CHARS_PER_TOKEN_ESTIMATE = 4;
export const ESTIMATED_USD_PER_1K_TOKENS = 0.02; // $0.02 per 1k tokens (measured agent consumption)

/**
 * Estimate total tokens for a conversation (prompt + completion).
 * Uses a conservative character-based heuristic.
 */
export function estimateTotalTokens(messages: Message[]): number {
  const totalChars = messages.reduce(
    (sum, message) => sum + message.content.length,
    0
  );
  const promptTokens = Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE);
  return promptTokens + DEFAULT_MAX_COMPLETION_TOKENS;
}
