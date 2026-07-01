// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/publish-epoch/build-distribution`
 * Purpose: Pure mapping from a FINALIZED, signed epoch statement to the inputs of
 *   `buildEpochDistribution` — the `FinalizedEpochStatement` plus the epoch's token budget.
 * Scope: Pure functions only. No I/O, no chain reads, no merkle math (that is delegated, unchanged,
 *   to the FROZEN `buildEpochDistribution` in @cogni/aragon-osx). Does NOT resolve wallets or persist.
 * Invariants:
 * - PUBLISH_BUDGET_FROM_POOL: the epoch token budget is the statement's signed `poolTotalCredits`
 *   mapped 1 credit → 1 whole token (× 10^18 base units). This is the V0 Walk mapping; it never
 *   invents a larger pool than governance signed.
 * - PUBLISH_CREDIT_WEIGHT: each line's signed `credit_amount` is the proportional distribution weight
 *   (consumed verbatim by buildEpochDistribution — never finalUnits).
 * - PUBLISH_NO_FORK_ROOT: this module produces inputs only; root/leaf math stays in the frozen builder.
 * Side-effects: none
 * Links: packages/aragon-osx/src/epoch-distribution-service.ts, docs/spec/tokenomics.md
 * @public
 */

import type { FinalizedEpochStatement } from "@cogni/aragon-osx";
import type {
  AttributionEpoch,
  AttributionStatement,
} from "@cogni/attribution-ledger";

/** 18-decimal base-unit scale for the GovernanceERC20 (matches token-distribution.ts). */
export const TOKEN_BASE_UNITS = 10n ** 18n;

export interface PublishEpochOnchainRefs {
  /** GovernanceERC20 token address (the DAO's settlement + mint token). */
  readonly tokenAddress: `0x${string}`;
  /** Chain id the DAO + token live on. */
  readonly chainId: number;
}

/**
 * Map a finalized statement (+ its epoch) and on-chain refs into the
 * `FinalizedEpochStatement` shape `buildEpochDistribution` consumes.
 *
 * `distributionId` is derived from the epoch id (stable, one distribution per
 * epoch). `statementHash` binds the manifest to the signed statement via the
 * statement's `finalAllocationSetHash`.
 */
export function toFinalizedEpochStatement(
  epoch: AttributionEpoch,
  statement: AttributionStatement,
  refs: PublishEpochOnchainRefs
): FinalizedEpochStatement {
  return {
    distributionId: `epoch-${epoch.id.toString()}`,
    nodeId: epoch.nodeId,
    scopeId: epoch.scopeId,
    statementHash: statement.finalAllocationSetHash,
    chainId: refs.chainId,
    tokenAddress: refs.tokenAddress,
    lines: statement.statementLines.map((line) => ({
      claimantKey: line.claimant_key,
      // Signed credit_amount is the proportional weight (string → bigint).
      creditAmount: BigInt(line.credit_amount),
      receiptIds: line.receipt_ids,
    })),
  };
}

/**
 * The epoch's token budget in ERC20 base units, derived from the signed
 * `poolTotalCredits` (1 credit → 1 whole token). PUBLISH_BUDGET_FROM_POOL: the
 * pool the approvers signed is the cap — we never mint more than that.
 */
export function epochTokenBudgetFromStatement(
  statement: AttributionStatement
): bigint {
  return statement.poolTotalCredits * TOKEN_BASE_UNITS;
}
