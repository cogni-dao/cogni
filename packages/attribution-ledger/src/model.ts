// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-ledger/model`
 * Purpose: Domain types and enums for the epoch ledger.
 * Scope: Pure types. Does not contain business logic or perform I/O.
 * Invariants: Mirrors epoch-ledger spec schema; all credit/unit fields are bigint (ALL_MATH_BIGINT).
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

/** Epoch statuses — 3-phase lifecycle: open → review → finalized */
export const EPOCH_STATUSES = ["open", "review", "finalized"] as const;
export type EpochStatus = (typeof EPOCH_STATUSES)[number];

/** Payout line item produced by computeStatementItems */
export interface StatementLineItem {
  readonly userId: string;
  readonly totalUnits: bigint;
  /** Proportional share as a string decimal (e.g. "0.333333") */
  readonly share: string;
  readonly amountCredits: bigint;
}

/** Input allocation for payout computation */
export interface FinalizedAllocation {
  readonly userId: string;
  readonly valuationUnits: bigint;
}

/** Allocation algorithm ref — pinned at closeIngestion, NULL while open */
export type AllocationAlgoRef = string;
