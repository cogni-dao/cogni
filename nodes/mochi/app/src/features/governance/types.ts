// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/types`
 * Purpose: View model types for governance UI — client-side composition of ledger API data.
 * Scope: Type-only module. No runtime imports. These are NOT API contracts; they are UI view models
 * composed from multiple ledger endpoints by hooks.
 * Invariants:
 *   - ALL_MATH_BIGINT: credit/unit values are strings (BigInt serialized)
 *   - UNIFIED_SCALE: units and override values share the same scale — no milli-unit conversion
 *   - avatar/color are placeholder defaults until a profile system exists
 *   - EpochView.unresolvedCount reflects events with no resolved user_id (IDENTITY_BEST_EFFORT)
 * Side-effects: none
 * Links: src/contracts/attribution.list-epochs.v1.contract.ts, src/contracts/attribution.epoch-user-projections.v1.contract.ts
 * @public
 */

/** A single ingestion receipt as displayed in the UI. */
export interface IngestionReceipt {
  readonly receiptId: string;
  readonly source: string;
  readonly eventType: string;
  readonly platformLogin: string | null;
  readonly artifactUrl: string | null;
  readonly eventTime: string;
  /** Per-receipt weight (milli-units). Available for open/review epochs; null for finalized. */
  readonly units: string | null;
  /** Raw metadata from ingestion (includes title, repo, etc.). */
  readonly metadata: Record<string, unknown> | null;
  /** Override applied during review (finalized epochs only). */
  readonly override: {
    readonly originalUnits: string;
    readonly overrideUnits: string;
    readonly reason: string | null;
  } | null;
}

/** A contributor row within an epoch view. */
export interface EpochContributor {
  readonly claimantKey: string;
  readonly claimantKind: "user" | "identity";
  readonly isLinked: boolean;
  readonly displayName: string | null;
  readonly claimantLabel: string;
  readonly avatar: string;
  readonly color: string;
  readonly units: string;
  readonly creditShare: number;
  readonly receiptCount: number;
  readonly receipts: readonly IngestionReceipt[];
}

/** An activity event that could not be attributed to a known user. */
export interface UnresolvedActivity {
  readonly platformLogin: string | null;
  readonly source: string;
  readonly eventCount: number;
}

/** Composite view of a single epoch (current or historical). */
export interface EpochView {
  readonly id: string;
  readonly status: "open" | "review" | "finalized";
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly poolTotalCredits: string | null;
  readonly contributors: readonly EpochContributor[];
  /** Number of activity events with no resolved user_id. */
  readonly unresolvedCount: number;
  /** Breakdown of unresolved activity by platform login. */
  readonly unresolvedActivities: readonly UnresolvedActivity[];
}

/** A single user's cumulative holdings. */
export interface HoldingView {
  readonly claimantKey: string;
  readonly claimantKind: "user" | "identity";
  readonly isLinked: boolean;
  readonly displayName: string | null;
  readonly claimantLabel: string;
  readonly avatar: string;
  readonly color: string;
  readonly totalCredits: string;
  readonly ownershipPercent: number;
  readonly epochsContributed: number;
}

/** Hook return shape for holdings. */
export interface HoldingsData {
  readonly holdings: readonly HoldingView[];
  readonly totalCreditsIssued: string;
  readonly totalContributors: number;
  readonly epochsCompleted: number;
}
