// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `tests/packages/db-client/drizzle-claimant-wallet-resolver`
 * Purpose: Unit tests for DrizzleClaimantWalletResolver — claimant-key parsing + the
 *   user_bindings/users resolution chain — using a fake Drizzle query builder.
 * Scope: No real database; a FIFO fake returns canned result sets in the adapter's
 *   deterministic query order. Asserts mapping logic + read-only behavior.
 * Invariants: RESOLVER_READ_ONLY, RESOLVER_NULL_IS_UNRESOLVED, RESOLVER_GITHUB_VIA_BINDING.
 * Side-effects: none
 * Links: packages/db-client/src/adapters/drizzle-claimant-wallet-resolver.adapter.ts
 * @internal
 */

import type { Database } from "@cogni/db-client";
import { DrizzleClaimantWalletResolver } from "@cogni/db-client";
import { describe, expect, it } from "vitest";

const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b2";

/**
 * Fake Drizzle query builder: each `db.select(...).from(...).where(...)` resolves
 * to the next queued result set (FIFO). The adapter's query order is deterministic:
 *   1. per identity provider: user_bindings rows {externalId, userId}
 *   2. 'wallet' bindings: {userId, externalId}
 *   3. users fallback: {id, walletAddress}
 */
function fakeDb(resultQueue: unknown[][]): {
  db: Database;
  writes: string[];
} {
  let i = 0;
  const writes: string[] = [];
  const builder = {
    from() {
      return this;
    },
    where() {
      const rows = resultQueue[i] ?? [];
      i += 1;
      return Promise.resolve(rows);
    },
  };
  const db = {
    select() {
      return builder;
    },
    // Any write call would be a guardrail violation — record it so the test fails.
    insert() {
      writes.push("insert");
      return builder;
    },
    update() {
      writes.push("update");
      return builder;
    },
    delete() {
      writes.push("delete");
      return builder;
    },
  } as unknown as Database;
  return { db, writes };
}

describe("DrizzleClaimantWalletResolver", () => {
  it("resolves a user: claimant directly to its wallet binding", async () => {
    const { db, writes } = fakeDb([
      // (2) wallet bindings
      [{ userId: "alice", externalId: ALICE }],
      // (3) users fallback — none needed
      [],
    ]);
    const resolver = new DrizzleClaimantWalletResolver(db);

    const out = await resolver.resolveWallets(["user:alice"]);

    expect(out).toEqual([
      { claimantKey: "user:alice", userId: "alice", wallet: ALICE },
    ]);
    expect(writes).toEqual([]); // read-only
  });

  it("resolves identity:github:<id> via user_bindings to user_id, then to wallet", async () => {
    const { db } = fakeDb([
      // (1) github provider binding: external_id 222222 → user bob
      [{ externalId: "222222", userId: "bob" }],
      // (2) wallet bindings for bob
      [{ userId: "bob", externalId: BOB }],
      // (3) users fallback
      [],
    ]);
    const resolver = new DrizzleClaimantWalletResolver(db);

    const out = await resolver.resolveWallets(["identity:github:222222"]);

    expect(out).toEqual([
      { claimantKey: "identity:github:222222", userId: "bob", wallet: BOB },
    ]);
  });

  it("falls back to users.wallet_address when no 'wallet' binding exists", async () => {
    const { db } = fakeDb([
      // (2) wallet bindings — none
      [],
      // (3) users fallback supplies the SIWE primary
      [{ id: "alice", walletAddress: ALICE }],
    ]);
    const resolver = new DrizzleClaimantWalletResolver(db);

    const out = await resolver.resolveWallets(["user:alice"]);
    expect(out[0]?.wallet).toBe(ALICE);
  });

  it("returns wallet=null for a user with no wallet anywhere (never invents an address)", async () => {
    const { db } = fakeDb([
      // (2) wallet bindings — none
      [],
      // (3) users fallback — none
      [],
    ]);
    const resolver = new DrizzleClaimantWalletResolver(db);

    const out = await resolver.resolveWallets(["user:ghost"]);
    expect(out).toEqual([
      { claimantKey: "user:ghost", userId: "ghost", wallet: null },
    ]);
  });

  it("returns userId=null + wallet=null when a github identity has no binding", async () => {
    const { db } = fakeDb([
      // (1) github provider binding — no match
      [],
      // (2) wallet bindings — no users to look up
      [],
      // (3) users fallback
      [],
    ]);
    const resolver = new DrizzleClaimantWalletResolver(db);

    const out = await resolver.resolveWallets(["identity:github:999"]);
    expect(out).toEqual([
      { claimantKey: "identity:github:999", userId: null, wallet: null },
    ]);
  });

  it("rejects a malformed stored address (returns null, not the bad value)", async () => {
    const { db } = fakeDb([
      [{ userId: "alice", externalId: "not-an-address" }],
      [],
    ]);
    const resolver = new DrizzleClaimantWalletResolver(db);

    const out = await resolver.resolveWallets(["user:alice"]);
    expect(out[0]?.wallet).toBeNull();
  });
});
