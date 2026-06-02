// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fakes/ai/message-builders`
 * Purpose: Builder functions for creating test message data with configurable properties.
 * Scope: Message creation utilities for tests. Does NOT handle real message processing.
 * Invariants: Default values for all fields; configurable via options; deterministic output.
 * Side-effects: none
 * Notes: Supports conversation, long message, and role-specific builders.
 * Links: core Message types
 * @public
 */

import type { Message, MessageRole } from "../../../src/core/public";

export interface MessageOptions {
  role?: MessageRole;
  content?: string;
  timestamp?: string;
}

export function createMessage(options: MessageOptions = {}): Message {
  return {
    role: options.role ?? "user",
    content: options.content ?? "Test message",
    timestamp: options.timestamp ?? "2025-01-01T00:00:00Z",
  };
}

export function createUserMessage(content = "Hello"): Message {
  return createMessage({ role: "user", content });
}

export function createAssistantMessage(content = "Hi there"): Message {
  return createMessage({ role: "assistant", content });
}

export function createSystemMessage(content = "You are helpful"): Message {
  return createMessage({ role: "system", content });
}

export function createLongMessage(
  length: number,
  role: MessageRole = "user"
): Message {
  return createMessage({
    role,
    content: "A".repeat(length),
  });
}

export function createMultiByteMessage(char = "👋", count = 5): Message {
  return createMessage({
    content: char.repeat(count),
  });
}

export function createConversation(
  userContent: string,
  assistantContent: string
): Message[] {
  return [
    createUserMessage(userContent),
    createAssistantMessage(assistantContent),
  ];
}

export function createMixedRoleConversation(): Message[] {
  return [
    createUserMessage("Hello"),
    createSystemMessage("You are a helpful assistant"),
    createAssistantMessage("Hi there"),
    createUserMessage("How are you?"),
    createSystemMessage("Another system message"),
  ];
}
