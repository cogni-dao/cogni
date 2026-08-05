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
 * - CUMULATIVE_LEAF_NO_INDEX: cumulative leaves are keccak256(abi.encodePacked(address, uint256 cumulativeAmount)) — NO index, matching the vendored 1inch CumulativeMerkleDrop.
 * - CUMULATIVE_CONSERVES_SUPPLY: a cumulative distribution's leaves sum to the TOTAL supply distributed to date (prior cumulative + this epoch's delta), not just this epoch.
 * Side-effects: none
 * Links: docs/spec/attribution-pipeline-overview.md, packages/cogni-contracts/src/cumulative-merkle-distributor/
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

// ---------------------------------------------------------------------------
// Cumulative distribution (1inch CumulativeMerkleDrop shape — R3)
//
// ONE distributor per node, deployed once, mutable owner-set root, cumulative
// leaves. Per epoch the DAO mints only the DELTA into the existing distributor
// and calls setMerkleRoot(newCumulativeRoot). A claimant's leaf carries their
// cumulative-earned-to-date so a single claim covers all unclaimed epochs.
// ---------------------------------------------------------------------------

/**
 * Prior cumulative balance for one account — the sum of all token amounts the
 * account has been allocated across every FINALIZED epoch BEFORE the current one.
 * Sourced from the most-recent persisted cumulative manifest's leaves.
 */
export interface PriorCumulativeBalance {
  readonly account: HexAddress;
  /** Cumulative tokens (base units) allocated to this account through prior epochs. */
  readonly cumulativeAmount: bigint;
}

/**
 * One account's NEW token delta for THIS epoch (base units), already
 * wallet-resolved. Deltas come from exploding the signed statement lines to
 * claimant wallets and largest-remainder rounding against the epoch's mint
 * delta (the per-epoch poolTotal in base units).
 */
export interface CumulativeEpochDelta {
  readonly claimantKey: string;
  readonly account: HexAddress;
  /** Token amount NEWLY earned this epoch (base units, may be 0 → no-op). */
  readonly deltaAmount: bigint;
  readonly receiptIds?: readonly string[];
}

export interface DaoTokenCumulativeDistributionInput {
  readonly distributionId: string;
  readonly nodeId: string;
  readonly scopeId: string;
  readonly statementHash: string;
  readonly chainId: number;
  readonly tokenAddress: HexAddress;
  /** Per-account cumulative balances through all PRIOR finalized epochs. */
  readonly priorCumulative: readonly PriorCumulativeBalance[];
  /** This epoch's per-account NEW deltas (wallet-resolved, base units). */
  readonly epochDeltas: readonly CumulativeEpochDelta[];
}

export interface DaoTokenCumulativeLeaf {
  /**
   * Stable per-account index in the (sorted) leaf set. The 1inch leaf preimage
   * does NOT include this — it exists only for persistence/UI ordering.
   */
  readonly index: number;
  readonly claimantKey: string;
  readonly account: HexAddress;
  /** Cumulative tokens (base units) earned through THIS epoch = prior + delta. */
  readonly cumulativeAmount: bigint;
  /** Tokens newly earned in THIS epoch (base units). */
  readonly deltaAmount: bigint;
  readonly receiptIds: readonly string[];
  readonly leafHash: Hex;
  readonly proof: readonly Hex[];
}

export interface DaoTokenCumulativeDistribution {
  readonly kind: "cogni.dao_ownership_token_distribution.cumulative.v0";
  readonly merkleTreeLibrary: "openzeppelin/merkle-tree@1";
  readonly claimContractPattern: "1inch.cumulative-merkle-drop.v1";
  readonly distributionId: string;
  readonly nodeId: string;
  readonly scopeId: string;
  readonly statementHash: string;
  readonly chainId: number;
  readonly tokenAddress: HexAddress;
  /**
   * The new cumulative merkle root to pass to `setMerkleRoot` on the existing
   * per-node distributor.
   */
  readonly merkleRoot: Hex;
  /**
   * Per-epoch MINT delta (base units) = sum of every account's deltaAmount =
   * this epoch's poolTotal in base units. The DAO mints exactly this into the
   * existing distributor; the cumulative root then governs the larger claim set.
   */
  readonly mintDelta: bigint;
  /**
   * Total supply distributed to date (base units) = sum of every leaf's
   * cumulativeAmount = prior cumulative supply + mintDelta. CUMULATIVE_CONSERVES_SUPPLY.
   */
  readonly cumulativeTotal: bigint;
  readonly leaves: readonly DaoTokenCumulativeLeaf[];
}

/**
 * Cumulative leaf preimage — `keccak256(abi.encodePacked(address, uint256))`.
 *
 * This is the 1inch CumulativeMerkleDrop leaf: NO index (the differentiator vs
 * the Uniswap-v1 leaf `keccak256(index, account, amount)`). Proof verification
 * uses sorted sibling pairs (OZ-compatible), identical to the legacy tree.
 */
export function hashCumulativeClaimLeaf(
  account: HexAddress,
  cumulativeAmount: bigint
): Hex {
  if (!isAddress(account)) {
    throw new RangeError("cumulative leaf account must be a valid EVM address");
  }
  if (cumulativeAmount < 0n) {
    throw new RangeError("cumulative amount must be non-negative");
  }
  return keccak256(
    encodePacked(["address", "uint256"], [account, cumulativeAmount])
  );
}

/**
 * Build the cumulative DAO-token distribution for one epoch finalization.
 *
 * Folds prior per-account cumulative balances with THIS epoch's per-account
 * deltas, emits cumulative leaves (`prior + delta`), the new cumulative merkle
 * root for `setMerkleRoot`, and the per-epoch `mintDelta` the DAO mints into the
 * existing distributor.
 *
 * - Accounts with zero cumulative-to-date (no prior balance AND zero delta) are
 *   dropped (no leaf).
 * - `mintDelta` is the sum of all positive deltas; callers MUST mint exactly
 *   this into the distributor before/with the `setMerkleRoot` call so the
 *   distributor can cover the new claims.
 * - CUMULATIVE_CONSERVES_SUPPLY: `cumulativeTotal === priorCumulativeTotal + mintDelta`.
 */
export function buildDaoTokenCumulativeDistribution(
  input: DaoTokenCumulativeDistributionInput
): DaoTokenCumulativeDistribution {
  validateManifestIdentity(input);

  // Fold prior + delta per account (lowercased address key for case-insensitive
  // matching; the checksummed/first-seen address is preserved for the leaf).
  const byAccount = new Map<
    string,
    {
      account: HexAddress;
      claimantKey: string;
      prior: bigint;
      delta: bigint;
      receiptIds: Set<string>;
    }
  >();

  let priorCumulativeTotal = 0n;
  for (const prior of input.priorCumulative) {
    if (!isAddress(prior.account)) {
      throw new RangeError(`invalid prior cumulative account ${prior.account}`);
    }
    if (prior.cumulativeAmount < 0n) {
      throw new RangeError("prior cumulativeAmount must be non-negative");
    }
    priorCumulativeTotal += prior.cumulativeAmount;
    const key = prior.account.toLowerCase();
    const existing = byAccount.get(key);
    if (existing) {
      existing.prior += prior.cumulativeAmount;
    } else {
      byAccount.set(key, {
        account: prior.account,
        claimantKey: "",
        prior: prior.cumulativeAmount,
        delta: 0n,
        receiptIds: new Set(),
      });
    }
  }

  let mintDelta = 0n;
  for (const epochDelta of input.epochDeltas) {
    if (!isAddress(epochDelta.account)) {
      throw new RangeError(
        `invalid epoch delta account for claimant ${epochDelta.claimantKey}`
      );
    }
    if (epochDelta.deltaAmount < 0n) {
      throw new RangeError(
        `negative deltaAmount for claimant ${epochDelta.claimantKey}`
      );
    }
    if (epochDelta.deltaAmount === 0n) {
      continue;
    }
    mintDelta += epochDelta.deltaAmount;
    const key = epochDelta.account.toLowerCase();
    const existing = byAccount.get(key);
    if (existing) {
      existing.delta += epochDelta.deltaAmount;
      if (existing.claimantKey === "") {
        existing.claimantKey = epochDelta.claimantKey;
      }
      for (const receiptId of epochDelta.receiptIds ?? []) {
        existing.receiptIds.add(receiptId);
      }
    } else {
      byAccount.set(key, {
        account: epochDelta.account,
        claimantKey: epochDelta.claimantKey,
        prior: 0n,
        delta: epochDelta.deltaAmount,
        receiptIds: new Set(epochDelta.receiptIds ?? []),
      });
    }
  }

  // Cumulative = prior + delta; drop accounts that net to zero.
  const folded = [...byAccount.values()]
    .map((entry) => ({
      account: entry.account,
      claimantKey:
        entry.claimantKey || `account:${entry.account.toLowerCase()}`,
      cumulativeAmount: entry.prior + entry.delta,
      deltaAmount: entry.delta,
      receiptIds: [...entry.receiptIds].sort(),
    }))
    .filter((entry) => entry.cumulativeAmount > 0n)
    .sort((a, b) =>
      a.account.toLowerCase().localeCompare(b.account.toLowerCase())
    );

  if (folded.length === 0) {
    throw new RangeError(
      "cumulative distribution requires at least one account with positive cumulative balance"
    );
  }

  const leavesWithoutProof = folded.map((entry, index) => ({
    index,
    claimantKey: entry.claimantKey,
    account: entry.account,
    cumulativeAmount: entry.cumulativeAmount,
    deltaAmount: entry.deltaAmount,
    receiptIds: entry.receiptIds,
    leafHash: hashCumulativeClaimLeaf(entry.account, entry.cumulativeAmount),
  }));

  const tree = SimpleMerkleTree.of(
    leavesWithoutProof.map((leaf) => leaf.leafHash)
  );
  const leaves = leavesWithoutProof.map((leaf, index) => ({
    ...leaf,
    proof: tree.getProof(index) as Hex[],
  }));

  const cumulativeTotal = leaves.reduce(
    (sum, leaf) => sum + leaf.cumulativeAmount,
    0n
  );

  // CUMULATIVE_CONSERVES_SUPPLY: prior supply + this epoch's mint delta.
  if (cumulativeTotal !== priorCumulativeTotal + mintDelta) {
    throw new Error(
      `cumulative supply invariant violated: cumulativeTotal=${cumulativeTotal} !== priorCumulativeTotal=${priorCumulativeTotal} + mintDelta=${mintDelta}`
    );
  }

  return {
    kind: "cogni.dao_ownership_token_distribution.cumulative.v0",
    merkleTreeLibrary: "openzeppelin/merkle-tree@1",
    claimContractPattern: "1inch.cumulative-merkle-drop.v1",
    distributionId: input.distributionId,
    nodeId: input.nodeId,
    scopeId: input.scopeId,
    statementHash: input.statementHash,
    chainId: input.chainId,
    tokenAddress: input.tokenAddress,
    merkleRoot: (tree.root ?? ZERO_ROOT) as Hex,
    mintDelta,
    cumulativeTotal,
    leaves,
  };
}

/**
 * Largest-remainder split of this epoch's mint delta (base units) across
 * wallet-resolved allocations weighted by signed credit amounts — the cumulative
 * analogue of `allocateTokenAmounts`. Returns per-account epoch deltas suitable
 * for {@link buildDaoTokenCumulativeDistribution}. Sums to exactly `mintDelta`.
 */
export function splitEpochDeltaByCredits(
  allocations: readonly DaoTokenDistributionAllocation[],
  mintDelta: bigint
): CumulativeEpochDelta[] {
  if (mintDelta <= 0n) {
    throw new RangeError("mintDelta must be positive");
  }
  const grouped = groupAllocations(allocations);
  if (grouped.length === 0) {
    throw new RangeError("at least one positive allocation is required");
  }
  return allocateTokenAmounts(grouped, mintDelta).map((allocation) => ({
    claimantKey: allocation.claimantKey,
    account: allocation.account,
    deltaAmount: allocation.amountFloor,
    receiptIds: [...allocation.receiptIds].sort(),
  }));
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

function validateManifestIdentity(input: {
  readonly distributionId: string;
  readonly nodeId: string;
  readonly scopeId: string;
  readonly statementHash: string;
  readonly tokenAddress: HexAddress;
}): void {
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
