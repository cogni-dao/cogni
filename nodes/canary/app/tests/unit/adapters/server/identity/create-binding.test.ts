// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/identity/create-binding.test`
 * Purpose: Unit tests for createBinding() — verifies binding + event creation, idempotency, and invariants.
 * Scope: Tests createBinding() with mocked Drizzle DB. Does not test real database interactions.
 * Invariants:
 * - BINDINGS_ARE_EVIDENCED: Every new binding INSERT is paired with an identity_events INSERT.
 * - NO_AUTO_MERGE: ON CONFLICT(provider, external_id) DO NOTHING — idempotent, no re-pointing.
 * Side-effects: none
 * Links: docs/spec/decentralized-identity.md
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBinding } from "@/adapters/server/identity/create-binding";

// Mock chain builder for Drizzle insert operations
function createMockInsertChain(returningResult: unknown[]) {
  return {
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(returningResult),
  };
}

function createMockDb() {
  const bindingInsertChain = createMockInsertChain([{ id: "binding-uuid" }]);
  const eventInsertChain = createMockInsertChain([]);

  let insertCallCount = 0;
  const mockTx = {
    insert: vi.fn().mockImplementation(() => {
      insertCallCount++;
      // First insert call = user_bindings, second = identity_events
      return insertCallCount === 1 ? bindingInsertChain : eventInsertChain;
    }),
  };

  const mockDb = {
    transaction: vi
      .fn()
      .mockImplementation(async (cb: (tx: unknown) => Promise<void>) => {
        insertCallCount = 0;
        await cb(mockTx);
      }),
    // biome-ignore lint/suspicious/noExplicitAny: Mocking complex DB type
  } as unknown as any;

  return { mockDb, mockTx, bindingInsertChain, eventInsertChain };
}

describe("createBinding", () => {
  let mockDb: ReturnType<typeof createMockDb>["mockDb"];
  let mockTx: ReturnType<typeof createMockDb>["mockTx"];
  let bindingInsertChain: ReturnType<typeof createMockDb>["bindingInsertChain"];
  let eventInsertChain: ReturnType<typeof createMockDb>["eventInsertChain"];

  beforeEach(() => {
    vi.clearAllMocks();
    const mocks = createMockDb();
    mockDb = mocks.mockDb;
    mockTx = mocks.mockTx;
    bindingInsertChain = mocks.bindingInsertChain;
    eventInsertChain = mocks.eventInsertChain;
  });

  it("inserts binding + identity event for new binding", async () => {
    await createBinding(mockDb, "user-123", "wallet", "0xabc", {
      method: "siwe",
      domain: "example.com",
    });

    // Transaction was opened
    expect(mockDb.transaction).toHaveBeenCalledOnce();

    // Two inserts: binding + event
    expect(mockTx.insert).toHaveBeenCalledTimes(2);

    // Binding insert uses onConflictDoNothing
    expect(bindingInsertChain.onConflictDoNothing).toHaveBeenCalledOnce();

    // Event insert records evidence in payload
    expect(eventInsertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-123",
        eventType: "bind",
        payload: expect.objectContaining({
          provider: "wallet",
          external_id: "0xabc",
          method: "siwe",
          domain: "example.com",
        }),
      })
    );
  });

  it("skips identity event when binding already exists (idempotent)", async () => {
    // Simulate ON CONFLICT DO NOTHING — returning() yields empty array
    bindingInsertChain.returning.mockResolvedValue([]);

    await createBinding(mockDb, "user-123", "wallet", "0xabc", {
      method: "siwe",
    });

    // Only one insert (the binding attempt), no event insert
    expect(mockTx.insert).toHaveBeenCalledTimes(1);
  });

  it("passes correct provider and externalId to binding values", async () => {
    await createBinding(mockDb, "user-456", "discord", "123456789012345678", {
      method: "bot_challenge",
    });

    expect(bindingInsertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-456",
        provider: "discord",
        externalId: "123456789012345678",
      })
    );
  });
});
