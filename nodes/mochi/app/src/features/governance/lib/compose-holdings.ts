// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/lib/compose-holdings`
 * Purpose: Aggregates finalized claimant attribution across epochs into cumulative holdings.
 * Scope: Pure function. Does not perform IO or access external services.
 * Invariants:
 *   - ALL_MATH_BIGINT: credit values stay as strings until final display derivation
 *   - Source of truth is finalized claimant attribution (not mutable allocations)
 * Side-effects: none
 * Links: src/features/governance/types.ts
 * @public
 */

import type { HoldingsData, HoldingView } from "@/features/governance/types";

import type { EpochClaimantsDto, EpochDto } from "./compose-epoch";

const DEFAULT_AVATAR = "👤";
const DEFAULT_COLOR = "220 15% 50%";

export function composeHoldings(
  epochs: readonly EpochDto[],
  claimants: readonly EpochClaimantsDto[]
): HoldingsData {
  const claimantMap = new Map<
    string,
    {
      claimantKey: string;
      claimantKind: "user" | "identity";
      isLinked: boolean;
      displayName: string | null;
      totalCredits: number;
      epochs: Set<string>;
    }
  >();

  let totalCreditsAll = 0;

  for (let i = 0; i < epochs.length; i++) {
    const epoch = epochs[i];
    const epochClaimants = claimants[i];
    if (!epoch || !epochClaimants) continue;

    for (const item of epochClaimants.items) {
      const credits = Number(item.amountCredits);
      totalCreditsAll += credits;

      const existing = claimantMap.get(item.claimantKey);
      if (existing) {
        existing.totalCredits += credits;
        existing.epochs.add(epoch.id);
        if (!existing.displayName && item.displayName) {
          existing.displayName = item.displayName;
        }
        existing.isLinked = existing.isLinked || item.isLinked;
      } else {
        claimantMap.set(item.claimantKey, {
          claimantKey: item.claimantKey,
          claimantKind: item.claimant.kind,
          isLinked: item.isLinked,
          displayName: item.displayName,
          totalCredits: credits,
          epochs: new Set([epoch.id]),
        });
      }
    }
  }

  const holdings: HoldingView[] = [...claimantMap.values()]
    .sort((a, b) => b.totalCredits - a.totalCredits)
    .map((entry) => ({
      claimantKey: entry.claimantKey,
      claimantKind: entry.claimantKind,
      isLinked: entry.isLinked,
      displayName: entry.displayName,
      claimantLabel: entry.isLinked ? "Linked account" : "Unlinked account",
      avatar: DEFAULT_AVATAR,
      color: DEFAULT_COLOR,
      totalCredits: String(entry.totalCredits),
      ownershipPercent:
        totalCreditsAll > 0
          ? Math.round((entry.totalCredits / totalCreditsAll) * 1000) / 10
          : 0,
      epochsContributed: entry.epochs.size,
    }));

  return {
    holdings,
    totalCreditsIssued: String(totalCreditsAll),
    totalContributors: holdings.length,
    epochsCompleted: claimants.length,
  };
}
