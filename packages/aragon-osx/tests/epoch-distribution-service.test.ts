// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/aragon-osx/tests/epoch-distribution-service`
 * Purpose: Unit tests for buildEpochDistribution — claimant→wallet resolution, frozen-root delegation, unresolved-claimant blockers.
 * Scope: Pure domain tests with an in-memory ClaimantWalletResolver; no chain, DB, or filesystem I/O.
 * Invariants: EPOCH_DISTRIBUTION_FROZEN_ROOT, EPOCH_DISTRIBUTION_CREDIT_INPUT, EPOCH_DISTRIBUTION_NO_INVENTED_WALLET.
 * Side-effects: none
 * Links: packages/aragon-osx/src/epoch-distribution-service.ts
 * @internal
 */

import {
  buildDaoTokenMerkleDistribution,
  buildEpochDistribution,
  type ClaimantWalletResolver,
  type DaoTokenMerkleDistribution,
  type FinalizedEpochStatement,
  verifyDaoTokenMerkleProof,
} from "@cogni/aragon-osx";
import { describe, expect, it } from "vitest";

/** Narrow a nullable distribution to a non-null value (asserts + returns). */
function assertDistribution(
  distribution: DaoTokenMerkleDistribution | null
): DaoTokenMerkleDistribution {
  expect(distribution).not.toBeNull();
  if (distribution === null) {
    throw new Error("expected a distribution");
  }
  return distribution;
}

const TOKEN = "0x00000000000000000000000000000000000000aa" as const;
const ALICE = "0x00000000000000000000000000000000000000a1" as const;
const BOB = "0x00000000000000000000000000000000000000b2" as const;

const NODE_ID = "00000000-0000-4000-8000-000000000001";
const SCOPE_ID = "00000000-0000-4000-8000-000000000002";
const STATEMENT_HASH =
  "sha256:0000000000000000000000000000000000000000000000000000000000000003";

const ALICE_USER = "user:11111111-1111-4111-8111-111111111111";
const BOB_IDENTITY = "identity:github:222222";

/** In-memory resolver: maps claimant key → { userId, wallet }. */
function fakeResolver(
  table: Record<string, { userId: string | null; wallet: string | null }>
): ClaimantWalletResolver {
  return {
    async resolveWallets(claimantKeys) {
      return claimantKeys.map((claimantKey) => {
        const hit = table[claimantKey];
        return {
          claimantKey,
          userId: hit?.userId ?? null,
          wallet: (hit?.wallet ?? null) as `0x${string}` | null,
        };
      });
    },
  };
}

function statement(
  lines: FinalizedEpochStatement["lines"]
): FinalizedEpochStatement {
  return {
    distributionId: "dist-epoch-1",
    nodeId: NODE_ID,
    scopeId: SCOPE_ID,
    statementHash: STATEMENT_HASH,
    chainId: 8453,
    tokenAddress: TOKEN,
    lines,
  };
}

describe("buildEpochDistribution", () => {
  it("resolves claimants to their own wallets and builds a Merkle distribution", async () => {
    const resolver = fakeResolver({
      [ALICE_USER]: { userId: "alice", wallet: ALICE },
      [BOB_IDENTITY]: { userId: "bob", wallet: BOB },
    });

    const result = await buildEpochDistribution(
      statement([
        { claimantKey: ALICE_USER, creditAmount: 60n, receiptIds: ["r1"] },
        { claimantKey: BOB_IDENTITY, creditAmount: 40n, receiptIds: ["r2"] },
      ]),
      1_000n,
      resolver
    );

    expect(result.blockers).toEqual([]);
    expect(result.unresolvedClaimantKeys).toEqual([]);
    const dist = assertDistribution(result.distribution);
    expect(dist.nodeId).toBe(NODE_ID);
    expect(dist.scopeId).toBe(SCOPE_ID);
    expect(dist.statementHash).toBe(STATEMENT_HASH);
    expect(dist.distributionAmount).toBe(1_000n);
    expect(dist.totalAllocated).toBe(1_000n);
    // 60/40 split of 1000 tokens.
    const byKey = new Map(dist.leaves.map((l) => [l.claimantKey, l]));
    expect(byKey.get(ALICE_USER)?.account).toBe(ALICE);
    expect(byKey.get(ALICE_USER)?.amount).toBe(600n);
    expect(byKey.get(BOB_IDENTITY)?.account).toBe(BOB);
    expect(byKey.get(BOB_IDENTITY)?.amount).toBe(400n);
  });

  it("delegates leaf/root math to the frozen builder (identical root)", async () => {
    const resolver = fakeResolver({
      [ALICE_USER]: { userId: "alice", wallet: ALICE },
      [BOB_IDENTITY]: { userId: "bob", wallet: BOB },
    });
    const lines = [
      { claimantKey: ALICE_USER, creditAmount: 60n, receiptIds: ["r1"] },
      { claimantKey: BOB_IDENTITY, creditAmount: 40n, receiptIds: ["r2"] },
    ];
    const { distribution } = await buildEpochDistribution(
      statement(lines),
      1_000n,
      resolver
    );

    const direct = buildDaoTokenMerkleDistribution({
      distributionId: "dist-epoch-1",
      nodeId: NODE_ID,
      scopeId: SCOPE_ID,
      statementHash: STATEMENT_HASH,
      chainId: 8453,
      tokenAddress: TOKEN,
      distributionAmount: 1_000n,
      allocations: [
        {
          claimantKey: ALICE_USER,
          account: ALICE,
          creditAmount: 60n,
          receiptIds: ["r1"],
        },
        {
          claimantKey: BOB_IDENTITY,
          account: BOB,
          creditAmount: 40n,
          receiptIds: ["r2"],
        },
      ],
    });

    const dist = assertDistribution(distribution);
    expect(dist.merkleRoot).toBe(direct.merkleRoot);
    // Proofs verify against the produced root.
    for (const leaf of dist.leaves) {
      expect(
        verifyDaoTokenMerkleProof(leaf.leafHash, leaf.proof, dist.merkleRoot)
      ).toBe(true);
    }
  });

  it("excludes an unresolved claimant and surfaces a claimants_unresolved blocker — never invents an address", async () => {
    const resolver = fakeResolver({
      [ALICE_USER]: { userId: "alice", wallet: ALICE },
      // Bob resolved to a user but has NO wallet binding.
      [BOB_IDENTITY]: { userId: "bob", wallet: null },
    });

    const result = await buildEpochDistribution(
      statement([
        { claimantKey: ALICE_USER, creditAmount: 60n, receiptIds: ["r1"] },
        { claimantKey: BOB_IDENTITY, creditAmount: 40n, receiptIds: ["r2"] },
      ]),
      1_000n,
      resolver
    );

    expect(result.unresolvedClaimantKeys).toEqual([BOB_IDENTITY]);
    expect(result.blockers.map((b) => b.code)).toContain(
      "claimants_unresolved"
    );
    // Alice still gets the full distribution; Bob is absent, no synthesized account.
    const accounts = assertDistribution(result.distribution).leaves.map(
      (l) => l.account
    );
    expect(accounts).toEqual([ALICE]);
    expect(accounts).not.toContain(BOB);
  });

  it("returns no distribution (only blockers) when every claimant is unresolved", async () => {
    const resolver = fakeResolver({
      [ALICE_USER]: { userId: "alice", wallet: null },
    });
    const result = await buildEpochDistribution(
      statement([
        { claimantKey: ALICE_USER, creditAmount: 100n, receiptIds: ["r1"] },
      ]),
      1_000n,
      resolver
    );
    expect(result.distribution).toBeNull();
    expect(result.blockers.map((b) => b.code)).toContain(
      "claimants_unresolved"
    );
  });

  it("rejects a non-positive token budget without calling the frozen builder", async () => {
    const resolver = fakeResolver({});
    const result = await buildEpochDistribution(
      statement([
        { claimantKey: ALICE_USER, creditAmount: 100n, receiptIds: ["r1"] },
      ]),
      0n,
      resolver
    );
    expect(result.distribution).toBeNull();
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it("ignores zero-credit lines (not treated as unresolved)", async () => {
    const resolver = fakeResolver({
      [ALICE_USER]: { userId: "alice", wallet: ALICE },
      [BOB_IDENTITY]: { userId: "bob", wallet: null },
    });
    const result = await buildEpochDistribution(
      statement([
        { claimantKey: ALICE_USER, creditAmount: 100n, receiptIds: ["r1"] },
        // Bob has 0 credit AND no wallet — must not count as unresolved.
        { claimantKey: BOB_IDENTITY, creditAmount: 0n, receiptIds: ["r2"] },
      ]),
      1_000n,
      resolver
    );
    expect(result.unresolvedClaimantKeys).toEqual([]);
    expect(result.blockers).toEqual([]);
    expect(assertDistribution(result.distribution).totalAllocated).toBe(1_000n);
  });
});
