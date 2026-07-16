// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/aragon-osx/epoch-distribution-service`
 * Purpose: Turn a FINALIZED signed attribution epoch statement into a DaoTokenMerkleDistribution
 *   (Merkle root + manifest), resolving each claimant to its own EVM wallet via a read-only port.
 * Scope: Orchestration over the FROZEN buildDaoTokenMerkleDistribution leaf/root math + a wallet
 *   resolver port. Does NOT read chain state, persist manifests, move tokens, or fork the root math.
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
  buildDaoTokenMerkleDistribution,
  type DaoTokenDistributionAllocation,
  type DaoTokenMerkleDistribution,
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
