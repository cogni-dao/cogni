// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/mappers`
 * Purpose: DTO mapping for AI feature - isolates core types from external layers.
 * Scope: Maps between DTOs and core domain types with validation. Includes UIMessage[] → MessageDto[] bridge for thread persistence pipeline. Does not handle external API calls or database operations.
 * Invariants: Pure functions, no side effects, proper error handling
 * Side-effects: none
 * Notes: Keeps core types isolated while enabling proper DTO translation
 * Links: Used by app facades, works with core domain
 * @public
 */

import {
  ChatErrorCode,
  ChatValidationError,
  type Message,
  type MessageToolCall,
  normalizeMessageRole,
} from "@cogni/node-core";
import type { DynamicToolUIPart, TextUIPart, UIMessage } from "ai";

/**
 * Tool call structure in DTO format.
 * Matches route.ts MessageToolCall and core MessageToolCall.
 */
export interface MessageDtoToolCall {
  /** Unique ID for this tool call */
  id: string;
  /** Tool name */
  name: string;
  /** JSON-encoded arguments string */
  arguments: string;
}

/**
 * Message DTO for completion facade.
 * Supports user, assistant (with optional tool calls), and tool (with tool result) messages.
 */
export interface MessageDto {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  timestamp?: string | undefined;
  /** Tool calls made by assistant (only for role: "assistant") */
  toolCalls?: MessageDtoToolCall[];
  /** Tool call ID this message responds to (only for role: "tool") */
  toolCallId?: string;
}

/**
 * Convert DTOs to core Message format.
 *
 * Handles:
 * - system: system instructions (passed through for OpenAI compatibility)
 * - user: plain text message
 * - assistant: text + optional tool calls
 * - tool: tool result with required toolCallId
 *
 * @throws ChatValidationError if role invalid or tool message missing toolCallId
 */
export function toCoreMessages(
  dtos: MessageDto[],
  timestamp: string
): Message[] {
  return dtos.map((dto) => {
    const normalizedRole = normalizeMessageRole(dto.role);
    if (!normalizedRole) {
      throw new ChatValidationError(
        ChatErrorCode.INVALID_CONTENT,
        `Invalid role: ${dto.role}`
      );
    }

    // Tool messages require toolCallId
    if (normalizedRole === "tool") {
      if (!dto.toolCallId) {
        throw new ChatValidationError(
          ChatErrorCode.INVALID_CONTENT,
          "Tool message missing required toolCallId"
        );
      }
      return {
        role: normalizedRole,
        content: dto.content,
        toolCallId: dto.toolCallId,
        timestamp,
      };
    }

    // Assistant messages may have tool calls
    if (normalizedRole === "assistant" && dto.toolCalls?.length) {
      const toolCalls: MessageToolCall[] = dto.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      }));
      return {
        role: normalizedRole,
        content: dto.content,
        toolCalls,
        timestamp,
      };
    }

    // System/User/Assistant without tool calls
    return {
      role: normalizedRole,
      content: dto.content,
      timestamp,
    };
  });
}

export function fromCoreMessage(msg: Message): {
  role: "assistant";
  content: string;
  timestamp: string;
} {
  return {
    role: "assistant",
    content: msg.content,
    timestamp: msg.timestamp ?? new Date().toISOString(),
  };
}

/**
 * Convert persisted UIMessage[] → MessageDto[] for the existing toCoreMessages() pipeline.
 *
 * Maps:
 * - user UIMessage text parts → user MessageDto
 * - assistant UIMessage text parts → assistant MessageDto (with optional toolCalls)
 * - assistant UIMessage dynamic-tool parts with output → tool MessageDto per tool result
 *
 * Per spec Decision 4: this bridges UIMessage persistence shape into the existing pipeline.
 * P1 replaces this with convertToModelMessages() from AI SDK.
 */
export function uiMessagesToMessageDtos(messages: UIMessage[]): MessageDto[] {
  const result: MessageDto[] = [];

  for (const msg of messages) {
    if (msg.role === "system") continue;

    // Extract text content from parts
    const textParts = msg.parts.filter(
      (p): p is TextUIPart => p.type === "text"
    );
    const textContent = textParts.map((p) => p.text).join("\n");

    // Extract dynamic-tool parts (tool calls with lifecycle)
    const toolParts = msg.parts.filter(
      (p): p is DynamicToolUIPart => p.type === "dynamic-tool"
    );

    if (msg.role === "user") {
      result.push({ role: "user", content: textContent });
    } else if (msg.role === "assistant") {
      // Build tool calls from dynamic-tool parts
      // All DynamicToolUIPart variants have toolCallId, toolName;
      // input is available on all states except input-streaming (where it may be undefined)
      const toolCalls: MessageDtoToolCall[] = toolParts.map((p) => ({
        id: p.toolCallId,
        name: p.toolName,
        arguments: JSON.stringify(
          "input" in p && p.input != null ? p.input : {}
        ),
      }));

      result.push({
        role: "assistant",
        content: textContent,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });

      // Emit tool result messages for completed tool calls
      for (const p of toolParts) {
        if (p.state === "output-available") {
          result.push({
            role: "tool",
            content: JSON.stringify(p.output),
            toolCallId: p.toolCallId,
          });
        }
      }
    }
  }

  return result;
}
