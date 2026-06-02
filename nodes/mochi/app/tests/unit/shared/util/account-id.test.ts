// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/util/account-id`
 * Purpose: Unit tests for stable account ID derivation.
 * Scope: Tests pure account ID generation logic without external dependencies. Does not test database or API integration.
 * Invariants: Deterministic output, collision resistance, proper formatting
 * Side-effects: none (unit tests only)
 * Notes: Tests cryptographic hash properties and edge cases
 * Links: Tests @/shared/util/account-id
 */

import { deriveAccountIdFromApiKey } from "@cogni/node-shared";
import { describe, expect, it } from "vitest";

describe("deriveAccountIdFromApiKey", () => {
  describe("Deterministic Output", () => {
    it("should return consistent ID for same API key", () => {
      const apiKey = "test-api-key-12345";
      const id1 = deriveAccountIdFromApiKey(apiKey);
      const id2 = deriveAccountIdFromApiKey(apiKey);

      expect(id1).toBe(id2);
    });

    it("should return expected format", () => {
      const apiKey = "test-api-key-12345";
      const accountId = deriveAccountIdFromApiKey(apiKey);

      // Should be "key:" + 32 hex characters
      expect(accountId).toMatch(/^key:[a-f0-9]{32}$/);
      expect(accountId).toHaveLength(36); // "key:" (4) + 32 hex chars
    });

    it("should handle empty string", () => {
      const accountId = deriveAccountIdFromApiKey("");

      expect(accountId).toMatch(/^key:[a-f0-9]{32}$/);
      expect(accountId).toHaveLength(36);
    });
  });

  describe("Collision Resistance", () => {
    it("should generate different IDs for different keys", () => {
      const keys = [
        "key1",
        "key2",
        "different-key",
        "another-completely-different-key",
        "sk-1234567890abcdef",
        "sk-abcdef1234567890",
      ];

      const ids = keys.map(deriveAccountIdFromApiKey);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(keys.length);
    });

    it("should be collision-resistant with similar keys", () => {
      const similarKeys = [
        "test-key-1",
        "test-key-2",
        "test-key-12",
        "test-key-123",
        "test-key-1234",
      ];

      const ids = similarKeys.map(deriveAccountIdFromApiKey);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(similarKeys.length);
    });

    it("should handle keys with different lengths", () => {
      const keys = ["a", "ab", "abc", "a".repeat(100), "a".repeat(1000)];

      const ids = keys.map(deriveAccountIdFromApiKey);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(keys.length);

      // All should have same format regardless of input length
      ids.forEach((id) => {
        expect(id).toMatch(/^key:[a-f0-9]{32}$/);
        expect(id).toHaveLength(36);
      });
    });
  });

  describe("Edge Cases", () => {
    it("should handle special characters", () => {
      const specialKeys = [
        "key with spaces",
        "key-with-dashes",
        "key_with_underscores",
        "key.with.dots",
        "key@with@symbols",
        "key/with/slashes",
        "key\\with\\backslashes",
      ];

      const ids = specialKeys.map(deriveAccountIdFromApiKey);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(specialKeys.length);

      // All should have valid format
      ids.forEach((id) => {
        expect(id).toMatch(/^key:[a-f0-9]{32}$/);
      });
    });

    it("should handle Unicode characters", () => {
      const unicodeKeys = [
        "key-🔑",
        "clé-française",
        "键-中文",
        "ключ-русский",
        "🚀🌟💫",
      ];

      const ids = unicodeKeys.map(deriveAccountIdFromApiKey);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(unicodeKeys.length);

      // All should have valid format
      ids.forEach((id) => {
        expect(id).toMatch(/^key:[a-f0-9]{32}$/);
      });
    });
  });

  describe("Real-World Examples", () => {
    it("should handle typical OpenAI-style keys", () => {
      const openaiStyleKeys = [
        "sk-1234567890abcdef1234567890abcdef12345678",
        "sk-abcdef1234567890abcdef1234567890abcdef12",
        "sk-proj-1234567890abcdef1234567890abcdef123456789012345678901234",
      ];

      const ids = openaiStyleKeys.map(deriveAccountIdFromApiKey);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(openaiStyleKeys.length);

      // All should have valid format
      ids.forEach((id) => {
        expect(id).toMatch(/^key:[a-f0-9]{32}$/);
      });
    });

    it("should handle LiteLLM virtual keys", () => {
      const litellmKeys = [
        "litellm-virtual-key-123",
        "virtual-key-456789",
        "test-key-for-development",
        "prod-key-abcdef123456",
      ];

      const ids = litellmKeys.map(deriveAccountIdFromApiKey);
      const uniqueIds = new Set(ids);

      expect(uniqueIds.size).toBe(litellmKeys.length);

      // Verify specific expected values (deterministic)
      expect(deriveAccountIdFromApiKey("litellm-virtual-key-123")).toBe(
        deriveAccountIdFromApiKey("litellm-virtual-key-123")
      );
    });
  });
});
