// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/aragon-osx/token-distribution`
 * Purpose: Pure helpers for DAO ownership token supply parsing and OSS-backed EVM-compatible merkle claim manifests.
 * Scope: Does not perform I/O or know about persistence. Deterministically converts signed
 *   statement credit entitlements into ERC20 claim amounts and OpenZeppelin-built merkle proofs.
 * Invariants:
 * - TOKEN_DISTRIBUTION_DETERMINISTIC: same inputs produce identical leaves, proofs, and root.
 * - TOKEN_DISTRIBUTION_CONSERVES_AMOUNT: all positive-token distributions allocate exactly distributionAmount.
 * - TOKEN_DISTRIBUTION_SCOPE_BOUND: manifests carry node, scope, and statement hash lineage.
 * Side-effects: none
 * Links: docs/spec/attribution-pipeline-overview.md
 * @public
 */

import { SimpleMerkleTree } from "@openzeppelin/merkle-tree";
import { encodePacked, isAddress, keccak256 } from "viem";

import {
  DAO_TOKEN_SUPPLY_MAX_WHOLE,
  DAO_TOKEN_SUPPLY_MIN_WHOLE,
} from "./osx/version";
import type { Hex, HexAddress } from "./types";

const TOKEN_DECIMALS = 18n;
const TOKEN_BASE_UNITS = 10n ** TOKEN_DECIMALS;
const ZERO_ROOT =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export interface DaoTokenDistributionAllocation {
  readonly claimantKey: string;
  readonly account: HexAddress;
  readonly creditAmount: bigint;
  readonly receiptIds?: readonly string[];
}

export interface DaoTokenMerkleDistributionInput {
  readonly distributionId: string;
  readonly nodeId: string;
  readonly scopeId: string;
  readonly statementHash: string;
  readonly chainId: number;
  readonly tokenAddress: HexAddress;
  readonly distributionAmount: bigint;
  readonly allocations: readonly DaoTokenDistributionAllocation[];
}

export interface DaoTokenMerkleLeaf {
  readonly index: number;
  readonly claimantKey: string;
  readonly account: HexAddress;
  readonly amount: bigint;
  readonly creditAmount: bigint;
  readonly receiptIds: readonly string[];
  readonly leafHash: Hex;
  readonly proof: readonly Hex[];
}

export interface DaoTokenMerkleDistribution {
  readonly kind: "cogni.dao_ownership_token_distribution.v0";
  readonly merkleTreeLibrary: "openzeppelin/merkle-tree@1";
  readonly claimContractPattern: "uniswap.merkle-distributor.v1";
  readonly distributionId: string;
  readonly nodeId: string;
  readonly scopeId: string;
  readonly statementHash: string;
  readonly chainId: number;
  readonly tokenAddress: HexAddress;
  readonly distributionAmount: bigint;
  readonly totalAllocated: bigint;
  readonly merkleRoot: Hex;
  readonly leaves: readonly DaoTokenMerkleLeaf[];
}

interface GroupedAllocation {
  claimantKey: string;
  account: HexAddress;
  creditAmount: bigint;
  receiptIds: Set<string>;
}

interface AmountAllocation extends GroupedAllocation {
  amountFloor: bigint;
  amountRemainder: bigint;
}

export function parseDaoTokenSupplyUnits(wholeTokens: number): bigint {
  if (!Number.isSafeInteger(wholeTokens)) {
    throw new RangeError("DAO token supply must be a safe whole number");
  }
  if (
    wholeTokens < DAO_TOKEN_SUPPLY_MIN_WHOLE ||
    wholeTokens > DAO_TOKEN_SUPPLY_MAX_WHOLE
  ) {
    throw new RangeError(
      `DAO token supply must be between ${DAO_TOKEN_SUPPLY_MIN_WHOLE} and ${DAO_TOKEN_SUPPLY_MAX_WHOLE} whole tokens`
    );
  }
  return BigInt(wholeTokens) * TOKEN_BASE_UNITS;
}

/**
 * Convert a GENESIS MINT amount (whole tokens) to base units.
 *
 * Distinct from {@link parseDaoTokenSupplyUnits}: the genesis mint is NOT the
 * policy supply, so the policy-supply floor (`DAO_TOKEN_SUPPLY_MIN_WHOLE`, 1000)
 * does NOT apply. The "solo_one_token" template mints exactly 1 token as a
 * formation probe — a legitimate mint that `parseDaoTokenSupplyUnits` wrongly
 * rejected (RangeError in the Create-DAO click). The genesis amount is already
 * bounded by `resolveDaoTokenomics` (> 0 and <= policy supply); here we only
 * require a positive safe integer not exceeding the absolute supply ceiling.
 */
export function parseDaoGenesisMintUnits(wholeTokens: number): bigint {
  if (!Number.isSafeInteger(wholeTokens) || wholeTokens < 1) {
    throw new RangeError("DAO genesis mint must be a positive whole number");
  }
  if (wholeTokens > DAO_TOKEN_SUPPLY_MAX_WHOLE) {
    throw new RangeError(
      `DAO genesis mint cannot exceed ${DAO_TOKEN_SUPPLY_MAX_WHOLE} whole tokens`
    );
  }
  return BigInt(wholeTokens) * TOKEN_BASE_UNITS;
}

export function buildDaoTokenMerkleDistribution(
  input: DaoTokenMerkleDistributionInput
): DaoTokenMerkleDistribution {
  validateManifestIdentity(input);
  if (input.distributionAmount <= 0n) {
    throw new RangeError("distributionAmount must be positive");
  }

  const grouped = groupAllocations(input.allocations);
  if (grouped.length === 0) {
    throw new RangeError("at least one positive allocation is required");
  }

  const leavesWithoutProof = allocateTokenAmounts(
    grouped,
    input.distributionAmount
  ).map((allocation, index) => ({
    index,
    claimantKey: allocation.claimantKey,
    account: allocation.account,
    amount: allocation.amountFloor,
    creditAmount: allocation.creditAmount,
    receiptIds: [...allocation.receiptIds].sort(),
    leafHash: hashDaoTokenClaimLeaf(
      index,
      allocation.account,
      allocation.amountFloor
    ),
  }));

  const tree = SimpleMerkleTree.of(
    leavesWithoutProof.map((leaf) => leaf.leafHash)
  );
  const leaves = leavesWithoutProof.map((leaf, index) => ({
    ...leaf,
    proof: tree.getProof(index) as Hex[],
  }));

  return {
    kind: "cogni.dao_ownership_token_distribution.v0",
    merkleTreeLibrary: "openzeppelin/merkle-tree@1",
    claimContractPattern: "uniswap.merkle-distributor.v1",
    distributionId: input.distributionId,
    nodeId: input.nodeId,
    scopeId: input.scopeId,
    statementHash: input.statementHash,
    chainId: input.chainId,
    tokenAddress: input.tokenAddress,
    distributionAmount: input.distributionAmount,
    totalAllocated: leaves.reduce((sum, leaf) => sum + leaf.amount, 0n),
    merkleRoot: (tree.root ?? ZERO_ROOT) as Hex,
    leaves,
  };
}

export function hashDaoTokenClaimLeaf(
  index: number,
  account: HexAddress,
  amount: bigint
): Hex {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError("leaf index must be a non-negative safe integer");
  }
  if (amount < 0n) {
    throw new RangeError("claim amount must be non-negative");
  }
  return keccak256(
    encodePacked(
      ["uint256", "address", "uint256"],
      [BigInt(index), account, amount]
    )
  );
}

export function verifyDaoTokenMerkleProof(
  leafHash: Hex,
  proof: readonly Hex[],
  merkleRoot: Hex
): boolean {
  return SimpleMerkleTree.verify(merkleRoot, leafHash, [...proof]);
}

function groupAllocations(
  allocations: readonly DaoTokenDistributionAllocation[]
): GroupedAllocation[] {
  const grouped = new Map<string, GroupedAllocation>();

  for (const allocation of allocations) {
    if (allocation.claimantKey.trim().length === 0) {
      throw new RangeError("claimantKey must be non-empty");
    }
    if (!isAddress(allocation.account)) {
      throw new RangeError(
        `invalid claim account for claimant ${allocation.claimantKey}`
      );
    }
    if (allocation.creditAmount < 0n) {
      throw new RangeError(
        `negative creditAmount for claimant ${allocation.claimantKey}`
      );
    }
    if (allocation.creditAmount === 0n) {
      continue;
    }

    const existing = grouped.get(allocation.claimantKey);
    if (existing) {
      if (existing.account.toLowerCase() !== allocation.account.toLowerCase()) {
        throw new Error(
          `claimant ${allocation.claimantKey} maps to multiple claim accounts`
        );
      }
      existing.creditAmount += allocation.creditAmount;
      for (const receiptId of allocation.receiptIds ?? []) {
        existing.receiptIds.add(receiptId);
      }
      continue;
    }

    grouped.set(allocation.claimantKey, {
      claimantKey: allocation.claimantKey,
      account: allocation.account,
      creditAmount: allocation.creditAmount,
      receiptIds: new Set(allocation.receiptIds ?? []),
    });
  }

  return [...grouped.values()].sort((a, b) =>
    a.claimantKey.localeCompare(b.claimantKey)
  );
}

function allocateTokenAmounts(
  grouped: readonly GroupedAllocation[],
  distributionAmount: bigint
): AmountAllocation[] {
  const totalUnits = grouped.reduce(
    (sum, allocation) => sum + allocation.creditAmount,
    0n
  );
  if (totalUnits <= 0n) {
    throw new RangeError("total creditAmount must be positive");
  }

  const floors = grouped.map((allocation) => {
    const scaled = allocation.creditAmount * distributionAmount;
    return {
      ...allocation,
      amountFloor: scaled / totalUnits,
      amountRemainder: scaled % totalUnits,
    };
  });

  let residual =
    distributionAmount -
    floors.reduce((sum, allocation) => sum + allocation.amountFloor, 0n);
  const byRemainder = [...floors].sort((a, b) => {
    if (a.amountRemainder !== b.amountRemainder) {
      return a.amountRemainder > b.amountRemainder ? -1 : 1;
    }
    return a.claimantKey.localeCompare(b.claimantKey);
  });

  const bonuses = new Set<string>();
  for (const allocation of byRemainder) {
    if (residual <= 0n) break;
    bonuses.add(allocation.claimantKey);
    residual -= 1n;
  }

  return floors.map((allocation) => ({
    ...allocation,
    amountFloor:
      allocation.amountFloor + (bonuses.has(allocation.claimantKey) ? 1n : 0n),
  }));
}

function validateManifestIdentity(
  input: DaoTokenMerkleDistributionInput
): void {
  if (input.distributionId.trim().length === 0) {
    throw new RangeError("distributionId must be non-empty");
  }
  if (input.nodeId.trim().length === 0) {
    throw new RangeError("nodeId must be non-empty");
  }
  if (input.scopeId.trim().length === 0) {
    throw new RangeError("scopeId must be non-empty");
  }
  if (input.statementHash.trim().length === 0) {
    throw new RangeError("statementHash must be non-empty");
  }
  if (!isAddress(input.tokenAddress)) {
    throw new RangeError("tokenAddress must be a valid EVM address");
  }
}
