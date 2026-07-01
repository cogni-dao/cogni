// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/aragon-osx/epoch-distribution-service`
 * Purpose: Turn a FINALIZED signed attribution epoch statement into a DaoTokenMerkleDistribution (Merkle root + manifest), resolving each claimant to its own EVM wallet via a read-only port.
 * Scope: Orchestration over the FROZEN buildDaoTokenMerkleDistribution leaf/root math + a wallet resolver port. Does NOT read chain state, persist manifests, move tokens, or fork the root math.
 * Invariants:
 * - EPOCH_DISTRIBUTION_FROZEN_ROOT: leaf/root computation is delegated unchanged to buildDaoTokenMerkleDistribution.
 * - EPOCH_DISTRIBUTION_CREDIT_INPUT: each statement line's signed `credit_amount` is the allocation weight (never finalUnits).
 * - EPOCH_DISTRIBUTION_NO_INVENTED_WALLET: a claimant with no resolved wallet is excluded and reported as a `claimants_unresolved` blocker — never given a synthesized address.
 * - EPOCH_DISTRIBUTION_CONTRIBUTOR_WALLET: tokens are allocated to the contributor's own wallet (no-central-custody).
 * Side-effects: none (awaits the injected read-only resolver; no writes)
 * Links: docs/spec/tokenomics.md, docs/spec/attribution-ledger.md, packages/aragon-osx/src/token-distribution.ts
 * @public
 */

import {
  buildDaoTokenCumulativeDistribution,
  buildDaoTokenMerkleDistribution,
  type DaoTokenCumulativeDistribution,
  type DaoTokenDistributionAllocation,
  type DaoTokenMerkleDistribution,
  type PriorCumulativeBalance,
  splitEpochDeltaByCredits,
} from "./token-distribution";
import type {
  DaoTokenSettlementBlocker,
  DaoTokenSettlementBlockerCode,
} from "./token-settlement";
import type { HexAddress } from "./types";
import type { ClaimantWalletResolver } from "./wallet-resolver";

/**
 * One line of a finalized signed attribution statement — the signed per-claimant
 * `creditAmount` entitlement is the distribution input (Merkle settlement consumes
 * signed creditAmount, NOT internal finalUnits — see tokenomics.md).
 */
export interface FinalizedStatementLine {
  readonly claimantKey: string;
  readonly creditAmount: bigint;
  readonly receiptIds: readonly string[];
}

/**
 * The finalized, signed epoch statement plus the on-chain manifest identity needed
 * to build a node/scope/chain-bound Merkle distribution. The statement MUST be
 * finalized (signed) — this service does not finalize, it only distributes.
 */
export interface FinalizedEpochStatement {
  /** Distribution manifest id (e.g. derived from epochId / statementId). */
  readonly distributionId: string;
  readonly nodeId: string;
  readonly scopeId: string;
  /** Content hash of the signed statement (binds the manifest to the statement). */
  readonly statementHash: string;
  readonly chainId: number;
  /** The DAO's GovernanceERC20 token address (the settlement token). */
  readonly tokenAddress: HexAddress;
  readonly lines: readonly FinalizedStatementLine[];
}

export interface EpochDistributionResult {
  /**
   * The built Merkle distribution, or null when no positive allocation could be
   * formed (e.g. every claimant unresolved, or a zero token budget).
   */
  readonly distribution: DaoTokenMerkleDistribution | null;
  /** Settlement blockers — non-empty distribution still carries blockers if some claimants were unresolved. */
  readonly blockers: readonly DaoTokenSettlementBlocker[];
  /** Claimant keys that could not resolve to a wallet (excluded from the manifest). */
  readonly unresolvedClaimantKeys: readonly string[];
}

function blocker(
  code: DaoTokenSettlementBlockerCode,
  message: string
): DaoTokenSettlementBlocker {
  return { code, message };
}

/**
 * Build a DaoTokenMerkleDistribution for a finalized epoch statement.
 *
 * For each statement line: resolve `claimantKey → contributor wallet` via the
 * read-only resolver, map the signed `creditAmount → creditAmount` and
 * `resolvedWallet → account`, then delegate to the FROZEN
 * `buildDaoTokenMerkleDistribution` for leaf/root math.
 *
 * Claimants with no resolved wallet are EXCLUDED (never given an invented address)
 * and surface as a single `claimants_unresolved` blocker, mirroring the existing
 * settlement-model semantics.
 *
 * Returns `{ distribution: null }` (with blockers) when no positive, wallet-backed
 * allocation remains — the caller decides whether to publish.
 */
export async function buildEpochDistribution(
  statement: FinalizedEpochStatement,
  epochTokenBudget: bigint,
  walletResolver: ClaimantWalletResolver
): Promise<EpochDistributionResult> {
  const blockers: DaoTokenSettlementBlocker[] = [];

  if (epochTokenBudget <= 0n) {
    return {
      distribution: null,
      blockers: [
        blocker(
          "funding_amount_mismatch",
          "epochTokenBudget must be positive to build a distribution."
        ),
      ],
      unresolvedClaimantKeys: [],
    };
  }

  // Resolve every distinct claimant key to its contributor wallet (read-only).
  const distinctKeys = [...new Set(statement.lines.map((l) => l.claimantKey))];
  const resolutions = await walletResolver.resolveWallets(distinctKeys);
  const walletByKey = new Map<string, HexAddress | null>();
  for (const r of resolutions) {
    walletByKey.set(r.claimantKey, r.wallet);
  }

  const allocations: DaoTokenDistributionAllocation[] = [];
  const unresolvedClaimantKeys = new Set<string>();

  for (const line of statement.lines) {
    if (line.creditAmount <= 0n) {
      // Zero-credit lines contribute nothing; not an unresolved-wallet condition.
      continue;
    }
    const wallet = walletByKey.get(line.claimantKey) ?? null;
    if (wallet === null) {
      unresolvedClaimantKeys.add(line.claimantKey);
      continue;
    }
    allocations.push({
      claimantKey: line.claimantKey,
      account: wallet,
      creditAmount: line.creditAmount,
      receiptIds: line.receiptIds,
    });
  }

  if (unresolvedClaimantKeys.size > 0) {
    blockers.push(
      blocker(
        "claimants_unresolved",
        `${unresolvedClaimantKeys.size} claimant(s) have no resolved EVM wallet binding; they are excluded from the distribution until a wallet is bound.`
      )
    );
  }

  if (allocations.length === 0) {
    // No wallet-backed positive allocation — cannot build a manifest.
    if (
      !blockers.some((b) => b.code === "claimants_unresolved") &&
      !blockers.some((b) => b.code === "manifest_missing")
    ) {
      blockers.push(
        blocker(
          "manifest_missing",
          "No positive, wallet-resolved allocation remains to build a Merkle distribution."
        )
      );
    }
    return {
      distribution: null,
      blockers,
      unresolvedClaimantKeys: [...unresolvedClaimantKeys].sort(),
    };
  }

  const distribution = buildDaoTokenMerkleDistribution({
    distributionId: statement.distributionId,
    nodeId: statement.nodeId,
    scopeId: statement.scopeId,
    statementHash: statement.statementHash,
    chainId: statement.chainId,
    tokenAddress: statement.tokenAddress,
    distributionAmount: epochTokenBudget,
    allocations,
  });

  return {
    distribution,
    blockers,
    unresolvedClaimantKeys: [...unresolvedClaimantKeys].sort(),
  };
}

/**
 * Result of building the CUMULATIVE distribution for a finalized epoch.
 * `distribution` is null when no wallet-backed positive cumulative balance
 * remains (same semantics as {@link EpochDistributionResult}).
 */
export interface CumulativeEpochDistributionResult {
  readonly distribution: DaoTokenCumulativeDistribution | null;
  readonly blockers: readonly DaoTokenSettlementBlocker[];
  readonly unresolvedClaimantKeys: readonly string[];
}

/**
 * Build the CUMULATIVE distribution for a finalized epoch — the R3 root math.
 *
 * Resolves THIS epoch's claimant credit lines to contributor wallets, splits the
 * per-epoch `mintDelta` (= this epoch's poolTotal in base units) across them by
 * signed credit weight (largest-remainder), folds those deltas onto the prior
 * per-account cumulative balances, and delegates to the FROZEN cumulative builder
 * for leaf/root math.
 *
 * The result carries `merkleRoot` (for `setMerkleRoot` on the existing per-node
 * distributor) and `mintDelta` (the DAO mints exactly this into the distributor).
 * One claim against the new root settles ALL of a claimant's unclaimed epochs.
 *
 * Unresolved claimants are EXCLUDED (never invented) and surface as a single
 * `claimants_unresolved` blocker. Prior cumulative balances are supplied by the
 * caller (read from the most-recent persisted cumulative manifest) and remain in
 * the new root even when an account has no delta this epoch.
 */
export async function buildCumulativeEpochDistribution(
  statement: FinalizedEpochStatement,
  mintDelta: bigint,
  priorCumulative: readonly PriorCumulativeBalance[],
  walletResolver: ClaimantWalletResolver
): Promise<CumulativeEpochDistributionResult> {
  const blockers: DaoTokenSettlementBlocker[] = [];

  if (mintDelta < 0n) {
    return {
      distribution: null,
      blockers: [
        blocker(
          "funding_amount_mismatch",
          "mintDelta must be non-negative to build a cumulative distribution."
        ),
      ],
      unresolvedClaimantKeys: [],
    };
  }

  // A zero-delta epoch with prior balances re-publishes the prior cumulative
  // root unchanged (no new mint). With no prior either, there is nothing to do.
  if (mintDelta === 0n && priorCumulative.length === 0) {
    return {
      distribution: null,
      blockers: [
        blocker(
          "manifest_missing",
          "No mint delta and no prior cumulative balance to build a cumulative distribution."
        ),
      ],
      unresolvedClaimantKeys: [],
    };
  }

  // Resolve every distinct claimant key in THIS epoch to its contributor wallet.
  const distinctKeys = [...new Set(statement.lines.map((l) => l.claimantKey))];
  const resolutions = await walletResolver.resolveWallets(distinctKeys);
  const walletByKey = new Map<string, HexAddress | null>();
  for (const r of resolutions) {
    walletByKey.set(r.claimantKey, r.wallet);
  }

  const allocations: DaoTokenDistributionAllocation[] = [];
  const unresolvedClaimantKeys = new Set<string>();

  for (const line of statement.lines) {
    if (line.creditAmount <= 0n) {
      continue;
    }
    const wallet = walletByKey.get(line.claimantKey) ?? null;
    if (wallet === null) {
      unresolvedClaimantKeys.add(line.claimantKey);
      continue;
    }
    allocations.push({
      claimantKey: line.claimantKey,
      account: wallet,
      creditAmount: line.creditAmount,
      receiptIds: line.receiptIds,
    });
  }

  if (unresolvedClaimantKeys.size > 0) {
    blockers.push(
      blocker(
        "claimants_unresolved",
        `${unresolvedClaimantKeys.size} claimant(s) have no resolved EVM wallet binding; they are excluded from this epoch's delta until a wallet is bound.`
      )
    );
  }

  // No wallet-backed delta AND no prior cumulative balance ⇒ nothing to settle.
  if (allocations.length === 0 && priorCumulative.length === 0) {
    if (!blockers.some((b) => b.code === "claimants_unresolved")) {
      blockers.push(
        blocker(
          "manifest_missing",
          "No positive, wallet-resolved allocation and no prior cumulative balance to build a cumulative distribution."
        )
      );
    }
    return {
      distribution: null,
      blockers,
      unresolvedClaimantKeys: [...unresolvedClaimantKeys].sort(),
    };
  }

  // CONSERVATION (minted == claimable): `mintDelta` arrives scaled for the FULL
  // pool (poolTotalCredits(ALL) × base-units), but unresolved (wallet-unlinked)
  // contributors are excluded from the root above. Splitting the full pool across
  // only the resolved subset would OVER-PAY linked contributors the unlinked
  // share and break minted==claimable. So mint ONLY the resolved credits' worth:
  // resolvedMintDelta = mintDelta × resolvedCredits / totalEpochCredits (multiply
  // -first, exact — mintDelta is an exact multiple of totalEpochCredits). Unlinked
  // credits stay a pending off-chain liability the cumulative root absorbs when
  // the contributor later links a wallet (a future epoch resolves + mints them).
  const totalEpochCredits = statement.lines.reduce(
    (sum, line) => sum + (line.creditAmount > 0n ? line.creditAmount : 0n),
    0n
  );
  const resolvedCredits = allocations.reduce(
    (sum, allocation) => sum + allocation.creditAmount,
    0n
  );
  const resolvedMintDelta =
    totalEpochCredits > 0n
      ? (mintDelta * resolvedCredits) / totalEpochCredits
      : 0n;

  // Split the RESOLVED mint delta across the resolved allocations by credit
  // weight (largest-remainder). With no resolved allocations the delta is zero;
  // the new root still re-publishes the prior cumulative balances unchanged.
  const epochDeltas =
    allocations.length > 0 && resolvedMintDelta > 0n
      ? splitEpochDeltaByCredits(allocations, resolvedMintDelta)
      : [];

  const distribution = buildDaoTokenCumulativeDistribution({
    distributionId: statement.distributionId,
    nodeId: statement.nodeId,
    scopeId: statement.scopeId,
    statementHash: statement.statementHash,
    chainId: statement.chainId,
    tokenAddress: statement.tokenAddress,
    priorCumulative,
    epochDeltas,
  });

  return {
    distribution,
    blockers,
    unresolvedClaimantKeys: [...unresolvedClaimantKeys].sort(),
  };
}
