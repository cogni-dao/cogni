// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@core/chat/rules`
 * Purpose: Verifies core chat business rules for message processing and validation.
 * Scope: Pure business logic testing. Does NOT test external dependencies or I/O.
 * Invariants: Message length limits; role normalization; system filtering; deterministic trimming.
 * Side-effects: none
 * Notes: Tests Unicode handling; uses message builders for data creation.
 * Links: core chat rules module
 * @public
 */

import {
  assertMessageLength,
  ChatErrorCode,
  ChatValidationError,
  filterSystemMessages,
  MAX_MESSAGE_CHARS,
  normalizeMessageRole,
  trimConversationHistory,
} from "@cogni/node-core";
import {
  createConversation,
  createLongMessage,
  createMixedRoleConversation,
  createMultiByteMessage,
  createUserMessage,
} from "@tests/_fakes/ai/fakes";
import { describe, expect, it } from "vitest";

describe("core/chat/rules", () => {
  describe("assertMessageLength", () => {
    it("should pass for messages under the limit", () => {
      const shortMessage = createUserMessage("Hello world!");
      expect(() =>
        assertMessageLength(shortMessage.content, MAX_MESSAGE_CHARS)
      ).not.toThrow();
    });

    it("should pass for messages exactly at the limit", () => {
      const exactMessage = createLongMessage(MAX_MESSAGE_CHARS);
      expect(() =>
        assertMessageLength(exactMessage.content, MAX_MESSAGE_CHARS)
      ).not.toThrow();
    });

    it("should throw ChatValidationError for messages over the limit", () => {
      const longMessage = createLongMessage(MAX_MESSAGE_CHARS + 1);

      expect(() =>
        assertMessageLength(longMessage.content, MAX_MESSAGE_CHARS)
      ).toThrow(ChatValidationError);

      try {
        assertMessageLength(longMessage.content, MAX_MESSAGE_CHARS);
      } catch (error) {
        expect(error).toBeInstanceOf(ChatValidationError);
        expect((error as ChatValidationError).code).toBe(
          ChatErrorCode.MESSAGE_TOO_LONG
        );
        expect((error as ChatValidationError).message).toContain(
          `${MAX_MESSAGE_CHARS + 1} exceeds maximum ${MAX_MESSAGE_CHARS}`
        );
      }
    });

    it("should handle multi-byte characters correctly", () => {
      const emojiMessage = createMultiByteMessage("👋", 3); // 3 emoji = 3 chars
      expect(() => assertMessageLength(emojiMessage.content, 5)).not.toThrow();
      expect(() => assertMessageLength(emojiMessage.content, 2)).toThrow(
        ChatValidationError
      );
    });
  });

  describe("trimConversationHistory", () => {
    it("should return unchanged array when under limit", () => {
      const messages = createConversation("Hello", "Hi there");
      const result = trimConversationHistory(messages, 100);
      expect(result).toEqual(messages);
    });

    it("should return empty array unchanged", () => {
      const result = trimConversationHistory([], 100);
      expect(result).toEqual([]);
    });

    it("should preserve single message even if over limit", () => {
      const messages = [createLongMessage(100)];
      const result = trimConversationHistory(messages, 50);
      expect(result).toEqual(messages);
    });

    it("should remove oldest messages to fit under limit", () => {
      const messages = [
        createLongMessage(30, "user"), // oldest - should be removed
        createLongMessage(30, "assistant"), // should be removed
        createLongMessage(30, "user"), // newest - should be kept
      ];
      // Total: 90 chars, limit: 50, should remove first 2 messages
      const result = trimConversationHistory(messages, 50);
      expect(result).toHaveLength(1);
      expect(result[0]?.content).toBe("A".repeat(30));
    });

    it("should handle exact boundary case", () => {
      const messages = [createLongMessage(25), createLongMessage(25)];
      // Total: 50 chars, limit: 50, should return unchanged
      const result = trimConversationHistory(messages, 50);
      expect(result).toEqual(messages);
    });

    it("should handle multi-byte characters in trimming", () => {
      const messages = [
        createMultiByteMessage("👋", 30), // 30 chars
        createMultiByteMessage("✨", 30), // 30 chars
      ];
      const result = trimConversationHistory(messages, 40);
      expect(result).toHaveLength(1);
      expect(result[0]?.content).toBe("✨".repeat(30));
    });
  });

  describe("filterSystemMessages", () => {
    it("should remove system messages from mixed array", () => {
      const messages = createMixedRoleConversation();
      const result = filterSystemMessages(messages);

      expect(result).toHaveLength(3); // user, assistant, user
      expect(result[0]?.role).toBe("user");
      expect(result[1]?.role).toBe("assistant");
      expect(result[2]?.role).toBe("user");
    });

    it("should return empty array when only system messages", () => {
      const messages = [
        {
          role: "system" as const,
          content: "System message 1",
          timestamp: "2025-01-01T00:00:00Z",
        },
        {
          role: "system" as const,
          content: "System message 2",
          timestamp: "2025-01-01T00:00:01Z",
        },
      ];

      const result = filterSystemMessages(messages);
      expect(result).toEqual([]);
    });

    it("should return unchanged when no system messages", () => {
      const messages = createConversation("Hello", "Hi");
      const result = filterSystemMessages(messages);
      expect(result).toEqual(messages);
    });
  });

  describe("normalizeMessageRole", () => {
    it("should normalize valid roles", () => {
      expect(normalizeMessageRole("user")).toBe("user");
      expect(normalizeMessageRole("assistant")).toBe("assistant");
      expect(normalizeMessageRole("system")).toBe("system");
    });

    it("should handle case variations", () => {
      expect(normalizeMessageRole("USER")).toBe("user");
      expect(normalizeMessageRole("Assistant")).toBe("assistant");
      expect(normalizeMessageRole("SYSTEM")).toBe("system");
    });

    it("should handle whitespace", () => {
      expect(normalizeMessageRole("  user  ")).toBe("user");
      expect(normalizeMessageRole("\tassistant\n")).toBe("assistant");
    });

    it("should return null for invalid roles", () => {
      expect(normalizeMessageRole("")).toBe(null);
      expect(normalizeMessageRole("invalid")).toBe(null);
      expect(normalizeMessageRole("bot")).toBe(null);
      expect(normalizeMessageRole("human")).toBe(null);
    });
  });
});
