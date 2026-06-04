// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/prompts/chat.prompt`
 * Purpose: Prompt templates for chat graph.
 * Scope: Versioned text templates. Does not compute prompt_hash (done by adapter).
 * Invariants:
 *   - Prompts are pure text; no IO
 *   - prompt_hash computed by litellm.adapter.ts only (not here)
 * Side-effects: none
 * Notes: P1 skeleton - expand with graph-specific prompts as needed
 * Links: chat.graph.ts, litellm.adapter.ts, AI_SETUP_SPEC.md
 * @internal
 */

/**
 * System prompt for chat graph.
 * Used when graph needs custom system behavior beyond baseline.
 */
export const CHAT_GRAPH_SYSTEM_PROMPT = `You are a helpful AI assistant.
When you need to perform actions or look up information, use the available tools.
Always explain your reasoning before taking actions.
If a tool call fails, explain what happened and suggest alternatives.`;

/**
 * Tool use instruction prompt.
 * Appended when tools are available.
 */
export const TOOL_USE_INSTRUCTION = `You have access to the following tools.
Use them when they would help answer the user's question.
Format your tool calls according to the provided schemas.`;

/**
 * Error recovery prompt.
 * Used when a tool call fails and we need to continue.
 */
export const TOOL_ERROR_RECOVERY = `The previous tool call encountered an error.
Please acknowledge the error and either:
1. Try an alternative approach
2. Explain why the task cannot be completed
3. Ask the user for more information if needed`;
