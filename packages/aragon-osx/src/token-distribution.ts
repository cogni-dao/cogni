// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/aragon-osx/token-distribution`
 * Purpose: Pure helpers for DAO ownership token supply parsing and EVM-compatible merkle claim manifests.
 * Scope: Does not perform I/O or know about persistence. Deterministically converts signed
 *   statement credit entitlements into ERC20 claim amounts and keccak merkle proofs.
 * Invariants:
 * - TOKEN_DISTRIBUTION_DETERMINISTIC: same inputs produce identical leaves, proofs, and root.
 * - TOKEN_DISTRIBUTION_CONSERVES_AMOUNT: all positive-token distributions allocate exactly distributionAmount.
 * - TOKEN_DISTRIBUTION_SCOPE_BOUND: manifests carry node, scope, and statement hash lineage.
 * Side-effects: none
 * Links: docs/spec/attribution-pipeline-overview.md
 * @public
 */

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

  const tree = buildMerkleTree(leavesWithoutProof.map((leaf) => leaf.leafHash));
  const leaves = leavesWithoutProof.map((leaf, index) => ({
    ...leaf,
    proof: buildMerkleProof(tree, index),
  }));

  return {
    kind: "cogni.dao_ownership_token_distribution.v0",
    distributionId: input.distributionId,
    nodeId: input.nodeId,
    scopeId: input.scopeId,
    statementHash: input.statementHash,
    chainId: input.chainId,
    tokenAddress: input.tokenAddress,
    distributionAmount: input.distributionAmount,
    totalAllocated: leaves.reduce((sum, leaf) => sum + leaf.amount, 0n),
    merkleRoot: tree.at(-1)?.[0] ?? ZERO_ROOT,
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
  let computed = leafHash;
  for (const sibling of proof) {
    computed = hashMerklePair(computed, sibling);
  }
  return computed.toLowerCase() === merkleRoot.toLowerCase();
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

function buildMerkleTree(leaves: readonly Hex[]): Hex[][] {
  if (leaves.length === 0) {
    return [];
  }

  const levels: Hex[][] = [[...leaves]];
  while ((levels.at(-1)?.length ?? 0) > 1) {
    const level = levels.at(-1) as Hex[];
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as Hex;
      const right = level[i + 1];
      next.push(right ? hashMerklePair(left, right) : left);
    }
    levels.push(next);
  }
  return levels;
}

function buildMerkleProof(tree: readonly Hex[][], leafIndex: number): Hex[] {
  const proof: Hex[] = [];
  let index = leafIndex;

  for (let levelIndex = 0; levelIndex < tree.length - 1; levelIndex += 1) {
    const level = tree[levelIndex] as readonly Hex[];
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    const sibling = level[siblingIndex];
    if (sibling) {
      proof.push(sibling);
    }
    index = Math.floor(index / 2);
  }

  return proof;
}

function hashMerklePair(a: Hex, b: Hex): Hex {
  const [left, right] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(`${left}${right.slice(2)}` as Hex);
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
