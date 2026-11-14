// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-ledger/claimant-shares`
 * Purpose: Claimant domain types, deterministic unit splitting, and the explodeToClaimants() join function for receipt-weight × claimant allocation.
 * Scope: Defines claimant types (user/identity), explodeToClaimants() for joining receipt weights with locked claimant records, deterministic unit splitting with largest-remainder rounding, and claimant-aware proportional credit computation. Does not perform I/O.
 * Invariants:
 * - CLAIMANTS_CAN_BE_UNRESOLVED: identity claimants may reference provider + external_id without a resolved user_id.
 * - CLAIMANT_SHARE_SPLIT_DETERMINISTIC: unit splitting uses integer math with largest-remainder tiebroken by claimant key.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

export const CLAIMANT_SHARES_EVALUATION_REF = "cogni.claimant_shares.v0";
export const CLAIMANT_SHARES_ALGO_REF = "claimant-shares-v0";
export const CLAIMANT_SHARE_DENOMINATOR_PPM = 1_000_000;

export interface UserClaimant {
  readonly kind: "user";
  readonly userId: string;
}

export interface IdentityClaimant {
  readonly kind: "identity";
  readonly provider: string;
  readonly externalId: string;
  readonly providerLogin: string | null;
}

export type AttributionClaimant = UserClaimant | IdentityClaimant;

export interface ClaimantShare {
  readonly claimant: AttributionClaimant;
  readonly sharePpm: number;
}

export interface SelectedReceiptForAttribution {
  readonly receiptId: string;
  readonly userId: string | null;
  readonly source: string;
  readonly eventType: string;
  readonly included: boolean;
  readonly weightOverrideMilli: bigint | null;
  readonly platformUserId: string;
  readonly platformLogin: string | null;
  readonly artifactUrl: string | null;
  readonly eventTime: Date;
  readonly payloadHash: string;
}

export interface FinalClaimantAllocation {
  readonly claimant: AttributionClaimant;
  readonly finalUnits: bigint;
  readonly receiptIds?: readonly string[];
}

export interface AttributionStatementLine {
  readonly claimantKey: string;
  readonly claimant: AttributionClaimant;
  readonly finalUnits: bigint;
  readonly poolShare: string;
  readonly creditAmount: bigint;
  readonly receiptIds: readonly string[];
}

export function claimantKey(claimant: AttributionClaimant): string {
  if (claimant.kind === "user") return `user:${claimant.userId}`;
  return `identity:${claimant.provider}:${claimant.externalId}`;
}

export function computeAttributionStatementLines(
  allocations: readonly FinalClaimantAllocation[],
  poolTotalCredits: bigint
): AttributionStatementLine[] {
  if (allocations.length === 0) {
    return [];
  }

  if (poolTotalCredits <= 0n) {
    return [];
  }

  const claimantUnits = new Map<
    string,
    {
      claimant: AttributionClaimant;
      totalUnits: bigint;
      receiptIds: Set<string>;
    }
  >();

  for (const allocation of allocations) {
    if (allocation.finalUnits < 0n) {
      throw new RangeError(
        `Negative finalUnits for claimant ${claimantKey(allocation.claimant)}: ${allocation.finalUnits}`
      );
    }

    const key = claimantKey(allocation.claimant);
    const existing = claimantUnits.get(key);
    if (existing) {
      existing.totalUnits += allocation.finalUnits;
      for (const receiptId of allocation.receiptIds ?? []) {
        existing.receiptIds.add(receiptId);
      }
      continue;
    }

    claimantUnits.set(key, {
      claimant: allocation.claimant,
      totalUnits: allocation.finalUnits,
      receiptIds: new Set(allocation.receiptIds ?? []),
    });
  }

  let totalUnits = 0n;
  for (const entry of claimantUnits.values()) {
    totalUnits += entry.totalUnits;
  }

  if (totalUnits === 0n) {
    return [];
  }

  const sortedClaimants = [...claimantUnits.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  );

  const floorAllocations: Array<{
    claimantKey: string;
    claimant: AttributionClaimant;
    totalUnits: bigint;
    receiptIds: readonly string[];
    floor: bigint;
    remainder: bigint;
  }> = [];

  let floorSum = 0n;

  for (const [key, entry] of sortedClaimants) {
    const floor = (entry.totalUnits * poolTotalCredits) / totalUnits;
    const remainder = (entry.totalUnits * poolTotalCredits) % totalUnits;

    floorAllocations.push({
      claimantKey: key,
      claimant: entry.claimant,
      totalUnits: entry.totalUnits,
      receiptIds: [...entry.receiptIds].sort(),
      floor,
      remainder,
    });
    floorSum += floor;
  }

  let residual = poolTotalCredits - floorSum;

  const byRemainder = [...floorAllocations].sort((a, b) => {
    if (b.remainder !== a.remainder) {
      return b.remainder > a.remainder ? 1 : -1;
    }
    return a.claimantKey.localeCompare(b.claimantKey);
  });

  const bonuses = new Map<string, bigint>();
  for (const allocation of byRemainder) {
    if (residual <= 0n) break;
    bonuses.set(allocation.claimantKey, 1n);
    residual -= 1n;
  }

  return floorAllocations.map(
    ({ claimantKey: key, claimant, totalUnits: units, receiptIds, floor }) => {
      const bonus = bonuses.get(key) ?? 0n;
      const amountCredits = floor + bonus;

      const shareScale = 10n ** 6n;
      const scaledShare = (units * shareScale) / totalUnits;
      const wholePart = scaledShare / shareScale;
      const fracPart = scaledShare % shareScale;
      const share = `${wholePart}.${fracPart.toString().padStart(6, "0")}`;

      return {
        claimantKey: key,
        claimant,
        finalUnits: units,
        poolShare: share,
        creditAmount: amountCredits,
        receiptIds,
      };
    }
  );
}

// ---------------------------------------------------------------------------
// Receipt-weight × claimants join (explodeToClaimants)
// ---------------------------------------------------------------------------

import type { ReceiptUnitWeight } from "./allocation";
import type { ReceiptClaimantsRecord } from "./store";

/**
 * Core pure function: receipt weights × claimants → claimant allocations.
 * - Joins by receiptId
 * - For each receipt: if overrideShares exist, splits units by PPM shares;
 *   otherwise splits units equally among claimantKeys (largest-remainder rounding)
 * - Groups by claimantKey across all receipts, sums units
 * - Returns sorted by claimantKey (deterministic)
 * - THROWS if any receiptId in weights has no matching claimants record
 */
export function explodeToClaimants(
  receiptWeights: readonly ReceiptUnitWeight[],
  claimants: readonly ReceiptClaimantsRecord[],
  overrides?: readonly SubjectOverride[]
): FinalClaimantAllocation[] {
  const claimantsByReceipt = new Map<string, ReceiptClaimantsRecord>();
  for (const record of claimants) {
    claimantsByReceipt.set(record.receiptId, record);
  }

  // Build share override lookup: receiptId → ClaimantShare[]
  const shareOverrideMap = new Map<string, readonly ClaimantShare[]>();
  if (overrides) {
    for (const o of overrides) {
      if (o.overrideShares !== null) {
        shareOverrideMap.set(o.subjectRef, o.overrideShares);
      }
    }
  }

  // Accumulator: claimantKey → { claimant, totalUnits, receiptIds }
  const grouped = new Map<
    string,
    {
      claimant: AttributionClaimant;
      totalUnits: bigint;
      receiptIds: Set<string>;
    }
  >();

  for (const weight of receiptWeights) {
    const record = claimantsByReceipt.get(weight.receiptId);
    if (!record) {
      throw new Error(
        `explodeToClaimants: receipt "${weight.receiptId}" has no matching claimants record`
      );
    }

    const keys = record.claimantKeys;
    if (keys.length === 0) continue;

    const shareOverride = shareOverrideMap.get(weight.receiptId);

    if (shareOverride && shareOverride.length > 0) {
      // PPM-based split: distribute units according to explicit shares
      splitByPpm(weight, shareOverride, grouped);
    } else {
      // Equal split with largest-remainder rounding
      splitEqually(weight, keys, grouped);
    }
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, entry]) => ({
      claimant: entry.claimant,
      finalUnits: entry.totalUnits,
      receiptIds: [...entry.receiptIds].sort(),
    }));
}

/** PPM-based split with largest-remainder rounding, tiebroken by claimant key. */
function splitByPpm(
  weight: ReceiptUnitWeight,
  shares: readonly ClaimantShare[],
  grouped: Map<
    string,
    {
      claimant: AttributionClaimant;
      totalUnits: bigint;
      receiptIds: Set<string>;
    }
  >
): void {
  const denom = BigInt(CLAIMANT_SHARE_DENOMINATOR_PPM);

  // Compute floor allocations and remainders
  const entries: Array<{
    ck: string;
    claimant: AttributionClaimant;
    floor: bigint;
    remainder: bigint;
  }> = [];
  let floorSum = 0n;

  for (const share of shares) {
    const ck = claimantKey(share.claimant);
    const floor = (weight.units * BigInt(share.sharePpm)) / denom;
    const remainder = (weight.units * BigInt(share.sharePpm)) % denom;
    entries.push({ ck, claimant: share.claimant, floor, remainder });
    floorSum += floor;
  }

  // Distribute residual units via largest-remainder (tiebreak by claimant key)
  let residual = weight.units - floorSum;
  const byRemainder = [...entries].sort((a, b) => {
    if (b.remainder !== a.remainder) {
      return b.remainder > a.remainder ? 1 : -1;
    }
    return a.ck.localeCompare(b.ck);
  });

  const bonuses = new Set<string>();
  for (const entry of byRemainder) {
    if (residual <= 0n) break;
    bonuses.add(entry.ck);
    residual -= 1n;
  }

  // Accumulate into grouped map
  for (const entry of entries) {
    const units = entry.floor + (bonuses.has(entry.ck) ? 1n : 0n);
    accumulateClaimant(
      grouped,
      entry.ck,
      entry.claimant,
      units,
      weight.receiptId
    );
  }
}

/** Equal split with largest-remainder rounding, tiebroken by claimant key sort order. */
function splitEqually(
  weight: ReceiptUnitWeight,
  keys: readonly string[],
  grouped: Map<
    string,
    {
      claimant: AttributionClaimant;
      totalUnits: bigint;
      receiptIds: Set<string>;
    }
  >
): void {
  const perClaimant = weight.units / BigInt(keys.length);
  let remainder = weight.units - perClaimant * BigInt(keys.length);

  const sortedKeys = [...keys].sort();

  for (const ck of sortedKeys) {
    const extra = remainder > 0n ? 1n : 0n;
    if (remainder > 0n) remainder--;

    const units = perClaimant + extra;
    const claimant = parseClaimantKey(ck);
    accumulateClaimant(grouped, ck, claimant, units, weight.receiptId);
  }
}

function accumulateClaimant(
  grouped: Map<
    string,
    {
      claimant: AttributionClaimant;
      totalUnits: bigint;
      receiptIds: Set<string>;
    }
  >,
  ck: string,
  claimant: AttributionClaimant,
  units: bigint,
  receiptId: string
): void {
  const existing = grouped.get(ck);
  if (existing) {
    existing.totalUnits += units;
    existing.receiptIds.add(receiptId);
  } else {
    grouped.set(ck, {
      claimant,
      totalUnits: units,
      receiptIds: new Set([receiptId]),
    });
  }
}

/**
 * Parse a claimant key string back to an AttributionClaimant.
 * Format: "user:<uuid>" or "identity:<provider>:<externalId>"
 */
function parseClaimantKey(key: string): AttributionClaimant {
  if (key.startsWith("user:")) {
    return { kind: "user", userId: key.slice(5) };
  }
  if (key.startsWith("identity:")) {
    const rest = key.slice(9);
    const colonIdx = rest.indexOf(":");
    if (colonIdx === -1) {
      throw new Error(`Invalid identity claimant key: "${key}"`);
    }
    return {
      kind: "identity",
      provider: rest.slice(0, colonIdx),
      externalId: rest.slice(colonIdx + 1),
      providerLogin: null,
    };
  }
  throw new Error(`Unknown claimant key format: "${key}"`);
}

// ---------------------------------------------------------------------------
// Subject override types + pure functions
// ---------------------------------------------------------------------------

export interface SubjectOverride {
  readonly subjectRef: string;
  readonly overrideUnits: bigint | null;
  readonly overrideShares: readonly ClaimantShare[] | null;
  readonly overrideReason: string | null;
}

export interface ReviewOverrideSnapshot {
  readonly subject_ref: string;
  readonly original_units: string;
  readonly override_units: string | null;
  readonly original_shares: readonly ClaimantShare[];
  readonly override_shares: readonly ClaimantShare[] | null;
  readonly reason: string | null;
}

/**
 * Apply overrideUnits from subject overrides to receipt weights.
 * Pure, deterministic. Overrides match by subjectRef === receiptId.
 * Returns a new sorted array — does not mutate inputs.
 */
export function applyReceiptWeightOverrides(
  weights: readonly ReceiptUnitWeight[],
  overrides: readonly SubjectOverride[]
): ReceiptUnitWeight[] {
  if (overrides.length === 0) return [...weights];

  const overrideMap = new Map<string, bigint>();
  for (const o of overrides) {
    if (o.overrideUnits !== null) {
      overrideMap.set(o.subjectRef, o.overrideUnits);
    }
  }

  if (overrideMap.size === 0) return [...weights];

  return weights
    .map((w) => {
      const override = overrideMap.get(w.receiptId);
      if (override === undefined) return w;
      return { receiptId: w.receiptId, units: override };
    })
    .sort((a, b) => a.receiptId.localeCompare(b.receiptId));
}

/**
 * Build review override snapshots from receipt weights and subject overrides.
 * Uses receipt weights as the source of original_units.
 * When overrideShares is present, computes original_shares from locked claimants (equal PPM split).
 */
export function buildReceiptWeightOverrideSnapshots(
  originalWeights: readonly ReceiptUnitWeight[],
  lockedClaimants: readonly ReceiptClaimantsRecord[],
  overrides: readonly SubjectOverride[]
): ReviewOverrideSnapshot[] {
  if (overrides.length === 0) return [];

  const weightMap = new Map<string, bigint>();
  for (const w of originalWeights) {
    weightMap.set(w.receiptId, w.units);
  }

  const claimantMap = new Map<string, readonly string[]>();
  for (const c of lockedClaimants) {
    claimantMap.set(c.receiptId, c.claimantKeys);
  }

  const snapshots: ReviewOverrideSnapshot[] = [];
  for (const override of overrides) {
    const originalUnits = weightMap.get(override.subjectRef);
    if (originalUnits === undefined) continue;

    let originalShares: ClaimantShare[] = [];
    if (override.overrideShares) {
      const keys = claimantMap.get(override.subjectRef);
      if (keys && keys.length > 0) {
        originalShares = computeEqualSplitShares(keys);
      }
    }

    snapshots.push({
      subject_ref: override.subjectRef,
      original_units: originalUnits.toString(),
      override_units:
        override.overrideUnits !== null
          ? override.overrideUnits.toString()
          : null,
      original_shares: originalShares,
      override_shares: override.overrideShares
        ? [...override.overrideShares]
        : null,
      reason: override.overrideReason,
    });
  }

  return snapshots.sort((a, b) => a.subject_ref.localeCompare(b.subject_ref));
}

/** Compute equal-split PPM shares for a set of claimant keys (largest-remainder). */
function computeEqualSplitShares(keys: readonly string[]): ClaimantShare[] {
  const n = keys.length;
  const perClaimant = Math.floor(CLAIMANT_SHARE_DENOMINATOR_PPM / n);
  let remainder = CLAIMANT_SHARE_DENOMINATOR_PPM - perClaimant * n;

  const sortedKeys = [...keys].sort();
  return sortedKeys.map((key) => {
    const extra = remainder > 0 ? 1 : 0;
    if (remainder > 0) remainder--;
    return {
      claimant: parseClaimantKey(key),
      sharePpm: perClaimant + extra,
    };
  });
}
