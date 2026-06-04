// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/lib/compose-epoch`
 * Purpose: Joins flat ledger API responses into EpochView view models for the UI.
 * Scope: Pure functions. Accepts typed API response fragments. Does not perform IO or access external services.
 * Invariants:
 *   - ALL_MATH_BIGINT: credit/unit values stay as strings; Number() only for sorting/display derivation
 *   - UNIFIED_SCALE: all units (receipt weights, overrides, contributor totals) are in the same scale — no milli-unit conversion
 *   - Avatar/color are static placeholders (no profile system yet)
 *   - Receipts with selection.userId=null are counted in unresolvedCount/unresolvedActivities, not silently dropped
 *   - Finalized epoch receipts get per-receipt units computed from epoch.weightConfig
 * Side-effects: none
 * Links: src/features/governance/types.ts
 * @public
 */

import type {
  EpochContributor,
  EpochView,
  IngestionReceipt,
  UnresolvedActivity,
} from "@/features/governance/types";

const DEFAULT_AVATAR = "👤";
const DEFAULT_COLOR = "220 15% 50%";

function formatSourceName(source: string): string {
  switch (source) {
    case "github":
      return "GitHub";
    case "discord":
      return "Discord";
    case "google":
      return "Google";
    default:
      return source.charAt(0).toUpperCase() + source.slice(1);
  }
}

function resolveDisplayName(platformLogin: string | null): string | null {
  const trimmed = platformLogin?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function roundSharePercent(units: bigint, totalUnits: bigint): number {
  if (totalUnits <= 0n) return 0;
  return Math.round((Number(units) / Number(totalUnits)) * 1000) / 10;
}

function describeClaimant(params: {
  claimant: EpochClaimantDto;
  receipts: readonly IngestionReceipt[];
}): {
  claimantKind: "user" | "identity";
  displayName: string | null;
  claimantLabel: string;
} {
  const receiptLogin =
    params.receipts.find((receipt) => receipt.platformLogin)?.platformLogin ??
    null;

  if (params.claimant.kind === "user") {
    return {
      claimantKind: "user",
      displayName: resolveDisplayName(receiptLogin),
      claimantLabel: "Linked account",
    };
  }

  const fallback = params.claimant.providerLogin ?? receiptLogin;

  return {
    claimantKind: "identity",
    displayName: resolveDisplayName(fallback),
    claimantLabel: `${formatSourceName(params.claimant.provider)} account`,
  };
}

/** Minimal epoch shape expected from the list-epochs API. */
export interface EpochDto {
  readonly id: string;
  readonly status: "open" | "review" | "finalized";
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly weightConfig: Record<string, number>;
  readonly poolTotalCredits: string | null;
}

/** Minimal projection shape expected from the epoch-user-projections API. */
export interface UserProjectionDto {
  readonly userId: string;
  readonly projectedUnits: string;
  readonly receiptCount: number;
}

/** Minimal ingestion receipt shape expected from the epoch-activity API. */
export interface ApiIngestionReceipt {
  readonly receiptId: string;
  readonly source: string;
  readonly eventType: string;
  readonly platformUserId: string;
  readonly platformLogin: string | null;
  readonly artifactUrl: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly eventTime: string;
  readonly selection: {
    readonly userId: string | null;
    readonly included: boolean;
    readonly weightOverrideMilli: string | null;
  } | null;
}

/** Minimal claimant shape expected from the epoch-claimants API. */
export type EpochClaimantDto =
  | {
      readonly kind: "user";
      readonly userId: string;
    }
  | {
      readonly kind: "identity";
      readonly provider: string;
      readonly externalId: string;
      readonly providerLogin: string | null;
    };

/** Minimal claimant line item shape from the epoch-claimants API. */
export interface EpochClaimantLineItemDto {
  readonly claimantKey: string;
  readonly claimant: EpochClaimantDto;
  readonly displayName: string | null;
  readonly isLinked: boolean;
  readonly totalUnits: string;
  readonly share: string;
  readonly amountCredits: string;
  readonly receiptIds: readonly string[];
}

/** Snapshot of a review override applied before finalization. */
export interface ReviewOverrideSnapshotDto {
  readonly subject_ref: string;
  readonly original_units: string;
  readonly override_units: string | null;
  readonly reason: string | null;
}

/** Minimal claimant-attribution response shape from the epoch-claimants API. */
export interface EpochClaimantsDto {
  readonly epochId: string;
  readonly poolTotalCredits: string;
  readonly items: readonly EpochClaimantLineItemDto[];
  readonly reviewOverrides?: readonly ReviewOverrideSnapshotDto[] | null;
}

/**
 * Partition receipts into resolved (grouped by userId) and unresolved (grouped by platformLogin+source).
 * Pure helper — no IO.
 */
function partitionReceipts(receipts: readonly ApiIngestionReceipt[]): {
  receiptsById: Map<string, IngestionReceipt>;
  unresolvedCount: number;
  unresolvedActivities: UnresolvedActivity[];
} {
  const receiptsById = new Map<string, IngestionReceipt>();
  // Key: "source::platformLogin" → count
  const unresolvedMap = new Map<
    string,
    { login: string | null; source: string; count: number }
  >();
  let unresolvedCount = 0;

  for (const r of receipts) {
    const mapped: IngestionReceipt = {
      receiptId: r.receiptId,
      source: r.source,
      eventType: r.eventType,
      platformLogin: r.platformLogin,
      artifactUrl: r.artifactUrl,
      eventTime: r.eventTime,
      units: null,
      metadata: r.metadata ?? null,
      override: null,
    };
    receiptsById.set(r.receiptId, mapped);

    if (!r.selection?.included) {
      continue;
    }

    const resolvedUser = r.selection?.userId;
    if (!resolvedUser) {
      unresolvedCount++;
      const key = `${r.source}::${r.platformLogin ?? "<unknown>"}`;
      const existing = unresolvedMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        unresolvedMap.set(key, {
          login: r.platformLogin,
          source: r.source,
          count: 1,
        });
      }
    }
  }

  const unresolvedActivities: UnresolvedActivity[] = [...unresolvedMap.values()]
    .map((v) => ({
      platformLogin: v.login,
      source: v.source,
      eventCount: v.count,
    }))
    .sort((a, b) => b.eventCount - a.eventCount);

  return {
    receiptsById,
    unresolvedCount,
    unresolvedActivities,
  };
}

/**
 * Compose an EpochView for a current (open/review) epoch from live allocations + receipts.
 * Uses mutable allocations as source of truth (appropriate for in-progress data).
 */
export function composeEpochView(
  epoch: EpochDto,
  userProjections: readonly UserProjectionDto[],
  receipts: readonly ApiIngestionReceipt[]
): EpochView {
  const { receiptsById, unresolvedCount, unresolvedActivities } =
    partitionReceipts(receipts);
  const projectionByUser = new Map(
    userProjections.map((projection) => [projection.userId, projection])
  );
  const contributorMap = new Map<
    string,
    {
      claimantKey: string;
      claimantKind: "user" | "identity";
      displayName: string | null;
      claimantLabel: string;
      units: bigint;
      receiptCount: number;
      receipts: IngestionReceipt[];
    }
  >();

  for (const receipt of receipts) {
    if (!receipt.selection?.included) {
      continue;
    }

    const baseReceipt = receiptsById.get(receipt.receiptId);
    if (!baseReceipt) {
      continue;
    }

    const weight =
      receipt.selection?.weightOverrideMilli !== null &&
      receipt.selection?.weightOverrideMilli !== undefined
        ? BigInt(receipt.selection.weightOverrideMilli)
        : BigInt(
            epoch.weightConfig[`${receipt.source}:${receipt.eventType}`] ?? 0
          );

    if (weight <= 0n) {
      continue;
    }

    const mappedReceipt: IngestionReceipt = {
      ...baseReceipt,
      units: weight.toString(),
      override: null,
    };

    const userId = receipt.selection?.userId ?? null;
    if (userId) {
      const key = `user:${userId}`;
      const existing = contributorMap.get(key);
      if (existing) {
        existing.units += weight;
        existing.receiptCount += 1;
        existing.receipts.push(mappedReceipt);
      } else {
        const projection = projectionByUser.get(userId);
        contributorMap.set(key, {
          claimantKey: key,
          claimantKind: "user",
          displayName: resolveDisplayName(receipt.platformLogin),
          claimantLabel: "Linked account",
          units: BigInt(projection?.projectedUnits ?? weight),
          receiptCount: projection?.receiptCount ?? 1,
          receipts: [mappedReceipt],
        });
      }
      continue;
    }

    const key = `identity:${receipt.source}:${receipt.platformUserId}`;
    const existing = contributorMap.get(key);
    if (existing) {
      existing.units += weight;
      existing.receiptCount += 1;
      existing.receipts.push(mappedReceipt);
    } else {
      contributorMap.set(key, {
        claimantKey: key,
        claimantKind: "identity",
        displayName: resolveDisplayName(receipt.platformLogin),
        claimantLabel: `${formatSourceName(receipt.source)} account`,
        units: weight,
        receiptCount: 1,
        receipts: [mappedReceipt],
      });
    }
  }

  const totalUnits = [...contributorMap.values()].reduce(
    (sum, contributor) => sum + contributor.units,
    0n
  );

  const contributors: EpochContributor[] = [...contributorMap.values()].map(
    (contributor) => ({
      claimantKey: contributor.claimantKey,
      claimantKind: contributor.claimantKind,
      isLinked: contributor.claimantKind === "user",
      displayName: contributor.displayName,
      claimantLabel: contributor.claimantLabel,
      avatar: DEFAULT_AVATAR,
      color: DEFAULT_COLOR,
      units: contributor.units.toString(),
      creditShare: roundSharePercent(contributor.units, totalUnits),
      receiptCount: contributor.receiptCount,
      receipts: contributor.receipts,
    })
  );

  // Sort by units DESC
  contributors.sort((a, b) => Number(b.units) - Number(a.units));

  return {
    id: epoch.id,
    status: epoch.status,
    periodStart: epoch.periodStart,
    periodEnd: epoch.periodEnd,
    poolTotalCredits: epoch.poolTotalCredits,
    contributors,
    unresolvedCount,
    unresolvedActivities,
  };
}

/**
 * Compose an EpochView for a finalized epoch from claimant-based finalized attribution.
 */
export function composeEpochViewFromClaimants(
  epoch: EpochDto,
  claimants: Pick<
    EpochClaimantsDto,
    "poolTotalCredits" | "items" | "reviewOverrides"
  >,
  receipts: readonly ApiIngestionReceipt[]
): EpochView {
  const { receiptsById, unresolvedCount, unresolvedActivities } =
    partitionReceipts(receipts);

  // Build override lookup: subjectRef (receiptId) → override snapshot
  const overridesByRef = new Map(
    (claimants.reviewOverrides ?? []).map((o) => [o.subject_ref, o])
  );

  const contributors: EpochContributor[] = claimants.items.map((item) => {
    const claimantReceipts = item.receiptIds
      .map((receiptId) => {
        const receipt = receiptsById.get(receiptId) ?? null;
        if (!receipt) return null;
        // Compute per-receipt weight from weight config (same as open/review path)
        const weightKey = `${receipt.source}:${receipt.eventType}`;
        const weight = epoch.weightConfig[weightKey] ?? 0;
        const withUnits: IngestionReceipt = {
          ...receipt,
          units: weight > 0 ? weight.toString() : null,
        };
        const ov = overridesByRef.get(receiptId);
        if (!ov || ov.override_units == null) return withUnits;
        return {
          ...withUnits,
          override: {
            originalUnits: ov.original_units,
            overrideUnits: ov.override_units,
            reason: ov.reason,
          },
        };
      })
      .filter((receipt): receipt is IngestionReceipt => receipt !== null);
    const descriptor = describeClaimant({
      claimant: item.claimant,
      receipts: claimantReceipts,
    });
    const share = Math.round(Number(item.share) * 1000) / 10;

    return {
      claimantKey: item.claimantKey,
      claimantKind: descriptor.claimantKind,
      isLinked: item.isLinked,
      displayName: item.displayName ?? descriptor.displayName,
      claimantLabel: descriptor.claimantLabel,
      avatar: DEFAULT_AVATAR,
      color: DEFAULT_COLOR,
      units: item.totalUnits,
      creditShare: share,
      receiptCount: claimantReceipts.length,
      receipts: claimantReceipts,
    };
  });

  // Sort by amount_credits DESC
  contributors.sort((a, b) => Number(b.units) - Number(a.units));

  return {
    id: epoch.id,
    status: epoch.status,
    periodStart: epoch.periodStart,
    periodEnd: epoch.periodEnd,
    poolTotalCredits: claimants.poolTotalCredits,
    contributors,
    unresolvedCount,
    unresolvedActivities,
  };
}

/** Override entry shape matching useReviewSubjectOverrides output. */
export interface OverrideEntry {
  readonly subjectRef: string;
  readonly overrideUnits: string | null;
}

/**
 * Recompute contributor sums after applying subject overrides client-side.
 * All units (receipt.units and override.overrideUnits) are in milli-units.
 * Receipts are never mutated — only contributor-level units and shares are recomputed.
 */
export function applyOverridesToEpochView(
  epoch: EpochView,
  overrides: ReadonlyMap<string, OverrideEntry>
): EpochView {
  if (overrides.size === 0) return epoch;

  const updatedContributors: EpochContributor[] = epoch.contributors.map(
    (contributor) => {
      let totalUnits = 0n;
      for (const receipt of contributor.receipts) {
        const override = overrides.get(receipt.receiptId);
        if (override?.overrideUnits != null) {
          totalUnits += BigInt(override.overrideUnits);
        } else {
          totalUnits += BigInt(receipt.units ?? "0");
        }
      }
      return { ...contributor, units: totalUnits.toString() };
    }
  );

  // Recompute shares
  const grandTotal = updatedContributors.reduce(
    (sum, c) => sum + BigInt(c.units),
    0n
  );
  const withShares: EpochContributor[] = updatedContributors.map((c) => ({
    ...c,
    creditShare: roundSharePercent(BigInt(c.units), grandTotal),
  }));

  // Re-sort by units DESC
  withShares.sort((a, b) => Number(b.units) - Number(a.units));

  return { ...epoch, contributors: withShares };
}
