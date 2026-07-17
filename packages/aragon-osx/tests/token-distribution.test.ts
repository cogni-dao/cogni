// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/aragon-osx/tests/token-distribution`
 * Purpose: Unit tests for DAO ownership token supply parsing and merkle distribution manifests.
 * Scope: Pure domain tests; does not test chain, wallet, database, or filesystem I/O.
 * Invariants: TOKEN_DISTRIBUTION_DETERMINISTIC, TOKEN_DISTRIBUTION_CONSERVES_AMOUNT.
 * Side-effects: none
 * Links: packages/aragon-osx/src/token-distribution.ts
 * @internal
 */

import {
  buildDaoTokenCumulativeDistribution,
  buildDaoTokenMerkleDistribution,
  buildDaoTokenSettlementModel,
  DAO_TOKEN_SUPPLY_DEFAULT_WHOLE,
  DAO_TOKEN_SUPPLY_MAX_WHOLE,
  DAO_TOKEN_SUPPLY_MIN_WHOLE,
  DEFAULT_DAO_TOKENOMICS_TEMPLATE_ID,
  hashCumulativeClaimLeaf,
  hashDaoTokenClaimLeaf,
  parseDaoGenesisMintUnits,
  parseDaoTokenSupplyUnits,
  resolveDaoTokenomics,
  splitEpochDeltaByCredits,
  verifyDaoTokenMerkleProof,
} from "@cogni/aragon-osx";
import { encodePacked, keccak256 } from "viem";
import { describe, expect, it } from "vitest";

const TOKEN = "0x00000000000000000000000000000000000000aa" as const;
const ALICE = "0x00000000000000000000000000000000000000a1" as const;
const BOB = "0x00000000000000000000000000000000000000b2" as const;
const CAROL = "0x00000000000000000000000000000000000000c3" as const;
const DISTRIBUTOR = "0x00000000000000000000000000000000000000d4" as const;
const MANIFEST_IDENTITY = {
  nodeId: "00000000-0000-4000-8000-000000000001",
  scopeId: "00000000-0000-4000-8000-000000000002",
  statementHash:
    "sha256:0000000000000000000000000000000000000000000000000000000000000003",
} as const;

describe("parseDaoTokenSupplyUnits", () => {
  it("converts whole tokens to 18-decimal base units", () => {
    expect(parseDaoTokenSupplyUnits(DAO_TOKEN_SUPPLY_DEFAULT_WHOLE)).toBe(
      1_000_000n * 10n ** 18n
    );
  });

  it("enforces configured slider bounds", () => {
    expect(() =>
      parseDaoTokenSupplyUnits(DAO_TOKEN_SUPPLY_MIN_WHOLE - 1)
    ).toThrow(RangeError);
    expect(() =>
      parseDaoTokenSupplyUnits(DAO_TOKEN_SUPPLY_MAX_WHOLE + 1)
    ).toThrow(RangeError);
    expect(() => parseDaoTokenSupplyUnits(1.5)).toThrow(RangeError);
  });
});

describe("parseDaoGenesisMintUnits", () => {
  it("allows a 1-token genesis mint (solo_one_token) below the supply floor", () => {
    // Regression: parseDaoTokenSupplyUnits rejected this (1 < 1000 floor),
    // making the default Create-DAO click throw an uncaught RangeError.
    expect(parseDaoGenesisMintUnits(1)).toBe(10n ** 18n);
    expect(() => parseDaoGenesisMintUnits(1)).not.toThrow();
  });

  it("converts larger genesis mints to 18-decimal base units", () => {
    expect(parseDaoGenesisMintUnits(200_000)).toBe(200_000n * 10n ** 18n);
  });

  it("rejects non-positive, non-integer, or over-ceiling amounts", () => {
    expect(() => parseDaoGenesisMintUnits(0)).toThrow(RangeError);
    expect(() => parseDaoGenesisMintUnits(1.5)).toThrow(RangeError);
    expect(() =>
      parseDaoGenesisMintUnits(DAO_TOKEN_SUPPLY_MAX_WHOLE + 1)
    ).toThrow(RangeError);
  });
});

describe("buildDaoTokenMerkleDistribution", () => {
  it("allocates exact distributionAmount with deterministic largest-remainder rounding", () => {
    const distribution = buildDaoTokenMerkleDistribution({
      distributionId: "epoch-1",
      ...MANIFEST_IDENTITY,
      chainId: 8453,
      tokenAddress: TOKEN,
      distributionAmount: 10n,
      allocations: [
        { claimantKey: "user:carol", account: CAROL, creditAmount: 1n },
        { claimantKey: "user:alice", account: ALICE, creditAmount: 1n },
        { claimantKey: "user:bob", account: BOB, creditAmount: 1n },
      ],
    });

    expect(distribution.merkleTreeLibrary).toBe("openzeppelin/merkle-tree@1");
    expect(distribution.claimContractPattern).toBe(
      "uniswap.merkle-distributor.v1"
    );
    expect(distribution.totalAllocated).toBe(10n);
    expect(distribution.leaves.map((leaf) => leaf.claimantKey)).toEqual([
      "user:alice",
      "user:bob",
      "user:carol",
    ]);
    expect(distribution.leaves.map((leaf) => leaf.amount)).toEqual([
      4n,
      3n,
      3n,
    ]);
  });

  it("builds proofs that verify against the merkle root", () => {
    const distribution = buildDaoTokenMerkleDistribution({
      distributionId: "epoch-2",
      ...MANIFEST_IDENTITY,
      chainId: 8453,
      tokenAddress: TOKEN,
      distributionAmount: parseDaoTokenSupplyUnits(DAO_TOKEN_SUPPLY_MIN_WHOLE),
      allocations: [
        { claimantKey: "user:alice", account: ALICE, creditAmount: 7n },
        { claimantKey: "user:bob", account: BOB, creditAmount: 3n },
      ],
    });

    for (const leaf of distribution.leaves) {
      expect(
        verifyDaoTokenMerkleProof(
          leaf.leafHash,
          leaf.proof,
          distribution.merkleRoot
        )
      ).toBe(true);
      expect(leaf.leafHash).toBe(
        hashDaoTokenClaimLeaf(leaf.index, leaf.account, leaf.amount)
      );
    }
  });

  it("matches the fixed EVM leaf and sorted-pair merkle vector", () => {
    const distribution = buildDaoTokenMerkleDistribution({
      distributionId: "epoch-vector",
      ...MANIFEST_IDENTITY,
      chainId: 8453,
      tokenAddress: TOKEN,
      distributionAmount: 100n,
      allocations: [
        { claimantKey: "user:alice", account: ALICE, creditAmount: 70n },
        { claimantKey: "user:bob", account: BOB, creditAmount: 30n },
      ],
    });

    expect(distribution.leaves).toHaveLength(2);
    expect(distribution.leaves[0]?.leafHash).toBe(
      "0x69f9cb1515ec48568483268117987a5bb1ee111146cceb05ab953c591553b5c9"
    );
    expect(distribution.leaves[1]?.leafHash).toBe(
      "0x4e61e809c8698c87957d2ed326955e91f76a564f5b31d00e50a2ebb6f1e60b53"
    );
    expect(distribution.merkleRoot).toBe(
      "0x642fd2a30e3c0a14d8bc871a26aca1ef3498eb5ebcea8b6a5be02fe0b1b3dc4d"
    );
    expect(distribution.leaves[0]?.proof).toEqual([
      "0x4e61e809c8698c87957d2ed326955e91f76a564f5b31d00e50a2ebb6f1e60b53",
    ]);
    expect(distribution.leaves[1]?.proof).toEqual([
      "0x69f9cb1515ec48568483268117987a5bb1ee111146cceb05ab953c591553b5c9",
    ]);
  });

  it("groups duplicate claimant rows without allowing account ambiguity", () => {
    const distribution = buildDaoTokenMerkleDistribution({
      distributionId: "epoch-3",
      ...MANIFEST_IDENTITY,
      chainId: 8453,
      tokenAddress: TOKEN,
      distributionAmount: 100n,
      allocations: [
        {
          claimantKey: "user:alice",
          account: ALICE,
          creditAmount: 25n,
          receiptIds: ["r2"],
        },
        {
          claimantKey: "user:alice",
          account: ALICE,
          creditAmount: 25n,
          receiptIds: ["r1"],
        },
        { claimantKey: "user:bob", account: BOB, creditAmount: 50n },
      ],
    });

    expect(distribution.leaves[0]?.amount).toBe(50n);
    expect(distribution.leaves[0]?.receiptIds).toEqual(["r1", "r2"]);

    expect(() =>
      buildDaoTokenMerkleDistribution({
        distributionId: "epoch-4",
        ...MANIFEST_IDENTITY,
        chainId: 8453,
        tokenAddress: TOKEN,
        distributionAmount: 100n,
        allocations: [
          { claimantKey: "user:alice", account: ALICE, creditAmount: 1n },
          { claimantKey: "user:alice", account: BOB, creditAmount: 1n },
        ],
      })
    ).toThrow(/multiple claim accounts/);
  });

  it("binds manifest metadata to node, scope, and signed statement lineage", () => {
    const distribution = buildDaoTokenMerkleDistribution({
      distributionId: "epoch-5",
      ...MANIFEST_IDENTITY,
      chainId: 8453,
      tokenAddress: TOKEN,
      distributionAmount: 100n,
      allocations: [
        { claimantKey: "user:alice", account: ALICE, creditAmount: 1n },
      ],
    });

    expect(distribution.nodeId).toBe(MANIFEST_IDENTITY.nodeId);
    expect(distribution.scopeId).toBe(MANIFEST_IDENTITY.scopeId);
    expect(distribution.statementHash).toBe(MANIFEST_IDENTITY.statementHash);
    expect(distribution.leaves[0]?.creditAmount).toBe(1n);
  });

  it("rejects manifests without scope lineage or valid EVM addresses", () => {
    expect(() =>
      buildDaoTokenMerkleDistribution({
        distributionId: "epoch-6",
        ...MANIFEST_IDENTITY,
        statementHash: "",
        chainId: 8453,
        tokenAddress: TOKEN,
        distributionAmount: 100n,
        allocations: [
          { claimantKey: "user:alice", account: ALICE, creditAmount: 1n },
        ],
      })
    ).toThrow(/statementHash/);

    expect(() =>
      buildDaoTokenMerkleDistribution({
        distributionId: "epoch-7",
        ...MANIFEST_IDENTITY,
        chainId: 8453,
        tokenAddress: TOKEN,
        distributionAmount: 100n,
        allocations: [
          {
            claimantKey: "user:alice",
            account: "0xnot-an-address",
            creditAmount: 1n,
          },
        ],
      })
    ).toThrow(/invalid claim account/);
  });
});

describe("resolveDaoTokenomics", () => {
  it("distinguishes policy supply from a one-token genesis mint", () => {
    const tokenomics = resolveDaoTokenomics({
      templateId: DEFAULT_DAO_TOKENOMICS_TEMPLATE_ID,
      policySupplyWholeTokens: 1_000_000,
    });

    expect(tokenomics.genesisMintWholeTokens).toBe(1);
    expect(tokenomics.futureSupplyNotMintedWholeTokens).toBe(999_999);
    expect(tokenomics.slices[0]).toMatchObject({
      label: "Genesis steward",
      wholeTokens: 1,
      mintedAtFormation: true,
    });
    expect(tokenomics.slices[1]).toMatchObject({
      role: "future_supply_unissued",
      label: "Future supply, not minted",
      wholeTokens: 999_999,
      mintedAtFormation: false,
    });
    expect(
      tokenomics.slices
        .filter((slice) => !slice.mintedAtFormation)
        .reduce((sum, slice) => sum + slice.wholeTokens, 0)
    ).toBe(999_999);
  });

  it("computes the 20% founder float template from policy supply", () => {
    const tokenomics = resolveDaoTokenomics({
      templateId: "solo_20_percent",
      policySupplyWholeTokens: 1_000_000,
    });

    expect(tokenomics.genesisMintWholeTokens).toBe(200_000);
    expect(tokenomics.futureSupplyNotMintedWholeTokens).toBe(800_000);
    expect(tokenomics.slices.map((slice) => slice.wholeTokens)).toEqual([
      200_000, 800_000,
    ]);
    expect(tokenomics.slices[1]).toMatchObject({
      role: "future_supply_unissued",
      label: "Future supply, not minted",
      mintedAtFormation: false,
    });
  });

  it("models future multi-owner templates without enabling them in the P0 wizard", () => {
    const council = resolveDaoTokenomics({
      templateId: "council_three_equal",
      policySupplyWholeTokens: 1_000_000,
    });
    const openPool = resolveDaoTokenomics({
      templateId: "open_contributor_pool",
      policySupplyWholeTokens: 1_000_000,
      ownerCount: 12,
    });

    expect(council.ownerCount).toBe(3);
    expect(council.genesisMintWholeTokens).toBe(3);
    expect(openPool.ownerCount).toBe(12);
    expect(openPool.genesisMintWholeTokens).toBe(100_000);
  });
});

describe("buildDaoTokenSettlementModel", () => {
  it("classifies current genesis-holder minting as a formation probe only", () => {
    const model = buildDaoTokenSettlementModel({
      inventory: {
        kind: "genesis_holder",
        holder: ALICE,
        amount: 1n * 10n ** 18n,
        daoControlled: false,
      },
    });

    expect(model.phase).toBe("formation_probe_only");
    expect(model.claimable).toBe(false);
    expect(model.blockers.map((blocker) => blocker.code)).toContain(
      "inventory_not_dao_controlled"
    );
    expect(model.blockers.map((blocker) => blocker.code)).toContain(
      "statement_missing"
    );
  });

  it("marks a signed statement distribution as claimable only after matching funding", () => {
    const distribution = buildDaoTokenMerkleDistribution({
      distributionId: "epoch-1",
      ...MANIFEST_IDENTITY,
      chainId: 8453,
      tokenAddress: TOKEN,
      distributionAmount: 100n,
      allocations: [
        { claimantKey: "user:alice", account: ALICE, creditAmount: 70n },
        { claimantKey: "user:bob", account: BOB, creditAmount: 30n },
      ],
    });

    const model = buildDaoTokenSettlementModel({
      inventory: {
        kind: "funded_distributor",
        holder: DISTRIBUTOR,
        amount: distribution.distributionAmount,
        daoControlled: true,
      },
      signedStatement: {
        epochId: "1",
        ...MANIFEST_IDENTITY,
        finalized: true,
        signatureHash:
          "0x00000000000000000000000000000000000000000000000000000000000000ee",
        signer: ALICE,
        unresolvedClaimantCount: 0,
      },
      distribution,
      funding: {
        distributor: DISTRIBUTOR,
        merkleRoot: distribution.merkleRoot,
        amount: distribution.distributionAmount,
        fundingTxHash:
          "0x00000000000000000000000000000000000000000000000000000000000000ff",
        publisher: ALICE,
        publishedAt: "2026-06-29T00:00:00.000Z",
      },
    });

    expect(model.phase).toBe("claimable");
    expect(model.claimable).toBe(true);
    expect(model.blockers).toEqual([]);
  });

  it("blocks settlement when the manifest is not bound to the signed statement", () => {
    const distribution = buildDaoTokenMerkleDistribution({
      distributionId: "epoch-1",
      ...MANIFEST_IDENTITY,
      chainId: 8453,
      tokenAddress: TOKEN,
      distributionAmount: 100n,
      allocations: [
        { claimantKey: "user:alice", account: ALICE, creditAmount: 1n },
      ],
    });

    const model = buildDaoTokenSettlementModel({
      inventory: {
        kind: "emissions_holder",
        holder: DISTRIBUTOR,
        amount: parseDaoTokenSupplyUnits(1_000_000),
        daoControlled: true,
      },
      signedStatement: {
        epochId: "1",
        nodeId: MANIFEST_IDENTITY.nodeId,
        scopeId: MANIFEST_IDENTITY.scopeId,
        statementHash:
          "sha256:9999999999999999999999999999999999999999999999999999999999999999",
        finalized: true,
        unresolvedClaimantCount: 0,
      },
      distribution,
    });

    expect(model.phase).toBe("manifest_ready");
    expect(model.claimable).toBe(false);
    expect(model.blockers.map((blocker) => blocker.code)).toContain(
      "statement_hash_mismatch"
    );
  });
});

describe("hashCumulativeClaimLeaf (1inch shape — NO index)", () => {
  it("matches keccak256(abi.encodePacked(address, uint256)) with no index", () => {
    const cumulativeAmount = 12_345n;
    const expected = keccak256(
      encodePacked(["address", "uint256"], [ALICE, cumulativeAmount])
    );
    expect(hashCumulativeClaimLeaf(ALICE, cumulativeAmount)).toBe(expected);
  });

  it("differs from the Uniswap-v1 (indexed) leaf for the same account+amount", () => {
    const amount = 999n;
    expect(hashCumulativeClaimLeaf(ALICE, amount)).not.toBe(
      hashDaoTokenClaimLeaf(0, ALICE, amount)
    );
  });

  it("rejects negative amounts and non-addresses", () => {
    expect(() => hashCumulativeClaimLeaf(ALICE, -1n)).toThrow(RangeError);
    expect(() => hashCumulativeClaimLeaf("0xnope" as typeof ALICE, 1n)).toThrow(
      RangeError
    );
  });
});

describe("buildDaoTokenCumulativeDistribution", () => {
  it("folds prior cumulative + this epoch's delta into cumulative leaves", () => {
    const distribution = buildDaoTokenCumulativeDistribution({
      distributionId: "epoch-2",
      ...MANIFEST_IDENTITY,
      chainId: 8453,
      tokenAddress: TOKEN,
      priorCumulative: [
        { account: ALICE, cumulativeAmount: 100n },
        { account: BOB, cumulativeAmount: 50n },
      ],
      epochDeltas: [
        { claimantKey: "user:alice", account: ALICE, deltaAmount: 25n },
        { claimantKey: "user:carol", account: CAROL, deltaAmount: 10n },
      ],
    });

    // Alice = 100 + 25; Bob = 50 + 0 (carried forward); Carol = 0 + 10.
    const byAccount = new Map(
      distribution.leaves.map((l) => [l.account.toLowerCase(), l])
    );
    expect(byAccount.get(ALICE.toLowerCase())?.cumulativeAmount).toBe(125n);
    expect(byAccount.get(BOB.toLowerCase())?.cumulativeAmount).toBe(50n);
    expect(byAccount.get(CAROL.toLowerCase())?.cumulativeAmount).toBe(10n);

    // mintDelta = only NEW tokens this epoch = 25 + 10.
    expect(distribution.mintDelta).toBe(35n);
    // cumulativeTotal = supply distributed to date = prior(150) + delta(35).
    expect(distribution.cumulativeTotal).toBe(185n);
    expect(distribution.claimContractPattern).toBe(
      "1inch.cumulative-merkle-drop.v1"
    );
  });

  it("emits index-free 1inch leaves and proofs that verify", () => {
    const distribution = buildDaoTokenCumulativeDistribution({
      distributionId: "epoch-3",
      ...MANIFEST_IDENTITY,
      chainId: 8453,
      tokenAddress: TOKEN,
      priorCumulative: [],
      epochDeltas: [
        { claimantKey: "user:alice", account: ALICE, deltaAmount: 70n },
        { claimantKey: "user:bob", account: BOB, deltaAmount: 30n },
      ],
    });

    for (const leaf of distribution.leaves) {
      expect(leaf.leafHash).toBe(
        hashCumulativeClaimLeaf(leaf.account, leaf.cumulativeAmount)
      );
      expect(
        verifyDaoTokenMerkleProof(
          leaf.leafHash,
          leaf.proof,
          distribution.merkleRoot
        )
      ).toBe(true);
    }
    expect(distribution.mintDelta).toBe(100n);
    expect(distribution.cumulativeTotal).toBe(100n);
  });

  it("carries prior balances forward when an account has no delta this epoch", () => {
    const distribution = buildDaoTokenCumulativeDistribution({
      distributionId: "epoch-4",
      ...MANIFEST_IDENTITY,
      chainId: 8453,
      tokenAddress: TOKEN,
      priorCumulative: [{ account: BOB, cumulativeAmount: 42n }],
      epochDeltas: [
        { claimantKey: "user:alice", account: ALICE, deltaAmount: 8n },
      ],
    });
    expect(distribution.mintDelta).toBe(8n);
    expect(distribution.cumulativeTotal).toBe(50n);
    expect(distribution.leaves).toHaveLength(2);
  });

  it("drops accounts that net to zero cumulative", () => {
    const distribution = buildDaoTokenCumulativeDistribution({
      distributionId: "epoch-5",
      ...MANIFEST_IDENTITY,
      chainId: 8453,
      tokenAddress: TOKEN,
      priorCumulative: [{ account: BOB, cumulativeAmount: 0n }],
      epochDeltas: [
        { claimantKey: "user:alice", account: ALICE, deltaAmount: 5n },
        { claimantKey: "user:carol", account: CAROL, deltaAmount: 0n },
      ],
    });
    expect(distribution.leaves.map((l) => l.account.toLowerCase())).toEqual([
      ALICE.toLowerCase(),
    ]);
  });

  it("throws when no account has a positive cumulative balance", () => {
    expect(() =>
      buildDaoTokenCumulativeDistribution({
        distributionId: "epoch-6",
        ...MANIFEST_IDENTITY,
        chainId: 8453,
        tokenAddress: TOKEN,
        priorCumulative: [],
        epochDeltas: [
          { claimantKey: "user:alice", account: ALICE, deltaAmount: 0n },
        ],
      })
    ).toThrow(/positive cumulative balance/);
  });
});

describe("splitEpochDeltaByCredits", () => {
  it("splits the mint delta by credit weight summing to exactly mintDelta", () => {
    const deltas = splitEpochDeltaByCredits(
      [
        { claimantKey: "user:alice", account: ALICE, creditAmount: 1n },
        { claimantKey: "user:bob", account: BOB, creditAmount: 1n },
        { claimantKey: "user:carol", account: CAROL, creditAmount: 1n },
      ],
      10n
    );
    expect(deltas.reduce((sum, d) => sum + d.deltaAmount, 0n)).toBe(10n);
    // Deterministic largest-remainder: same shape as legacy allocateTokenAmounts.
    expect(deltas.map((d) => d.deltaAmount)).toEqual([4n, 3n, 3n]);
  });
});
