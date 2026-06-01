// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/ai/langgraph/dev/thread.spec`
 * Purpose: Unit tests for LangGraph thread ID derivation.
 * Scope: Tests UUIDv5 derivation, tenant isolation, determinism. Does NOT test thread lifecycle.
 * Invariants:
 *   - THREAD_ID_IS_UUID: Output is valid UUID format
 *   - THREAD_ID_TENANT_SCOPED: Different billingAccountId → different threadId
 *   - DETERMINISTIC: Same inputs → same output
 * Side-effects: none
 * Links: src/adapters/server/ai/langgraph/dev/thread.ts
 * @public
 */

import { describe, expect, it } from "vitest";

import {
  buildThreadMetadata,
  deriveThreadUuid,
} from "@/adapters/server/ai/langgraph/dev/thread";

// UUID v4/v5 format regex
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("adapters/server/ai/langgraph/dev/thread", () => {
  describe("deriveThreadUuid", () => {
    it("returns valid UUID format", () => {
      const result = deriveThreadUuid("account-123", "thread-abc");

      expect(result).toMatch(UUID_REGEX);
    });

    it("is deterministic - same inputs produce same output", () => {
      const billingAccountId = "acc-deterministic-test";
      const stateKey = "thread-key-123";

      const result1 = deriveThreadUuid(billingAccountId, stateKey);
      const result2 = deriveThreadUuid(billingAccountId, stateKey);
      const result3 = deriveThreadUuid(billingAccountId, stateKey);

      expect(result1).toBe(result2);
      expect(result2).toBe(result3);
    });

    it("different stateKey produces different UUID", () => {
      const billingAccountId = "acc-same";

      const result1 = deriveThreadUuid(billingAccountId, "thread-1");
      const result2 = deriveThreadUuid(billingAccountId, "thread-2");

      expect(result1).not.toBe(result2);
    });

    describe("tenant isolation (THREAD_ID_TENANT_SCOPED)", () => {
      it("same stateKey, different billingAccountId → different threadId", () => {
        const stateKey = "shared-thread-key";

        const tenantA = deriveThreadUuid("tenant-a", stateKey);
        const tenantB = deriveThreadUuid("tenant-b", stateKey);

        expect(tenantA).not.toBe(tenantB);
      });

      it("prevents cross-tenant thread access with identical keys", () => {
        // Simulates attack vector: attacker guesses victim's stateKey
        const victimAccount = "victim-billing-account-id";
        const attackerAccount = "attacker-billing-account-id";
        const guessedstateKey = "common-thread-key";

        const victimThreadId = deriveThreadUuid(victimAccount, guessedstateKey);
        const attackerThreadId = deriveThreadUuid(
          attackerAccount,
          guessedstateKey
        );

        // Even with same stateKey, UUIDs differ → no cross-tenant access
        expect(victimThreadId).not.toBe(attackerThreadId);
      });

      it("produces distinct UUIDs for multiple tenants", () => {
        const stateKey = "conversation-1";
        const tenants = [
          "tenant-alpha",
          "tenant-beta",
          "tenant-gamma",
          "tenant-delta",
        ];

        const threadIds = tenants.map((t) => deriveThreadUuid(t, stateKey));
        const uniqueIds = new Set(threadIds);

        // All should be unique
        expect(uniqueIds.size).toBe(tenants.length);
      });
    });

    it("handles empty strings gracefully", () => {
      // Edge case: empty inputs should still produce valid UUID
      const result = deriveThreadUuid("", "");

      expect(result).toMatch(UUID_REGEX);
    });

    it("handles special characters in inputs", () => {
      const result = deriveThreadUuid(
        "account:with:colons",
        "thread/with/slashes"
      );

      expect(result).toMatch(UUID_REGEX);
    });
  });

  describe("buildThreadMetadata", () => {
    it("returns metadata object with correct fields", () => {
      const billingAccountId = "acc-123";
      const stateKey = "thread-456";

      const metadata = buildThreadMetadata(billingAccountId, stateKey);

      expect(metadata).toEqual({
        billingAccountId: "acc-123",
        stateKey: "thread-456",
      });
    });

    it("preserves original values without transformation", () => {
      const billingAccountId = "UPPER-case-123";
      const stateKey = "Special_Chars-_test";

      const metadata = buildThreadMetadata(billingAccountId, stateKey);

      expect(metadata.billingAccountId).toBe(billingAccountId);
      expect(metadata.stateKey).toBe(stateKey);
    });
  });
});
