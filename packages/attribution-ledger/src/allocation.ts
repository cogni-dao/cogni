// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-ledger/allocation`
 * Purpose: Versioned allocation algorithm framework — pure function dispatch for computing per-receipt weight allocations from selected receipts.
 * Scope: Pure functions. Does not perform I/O or hold state. Deterministic output for same inputs.
 * Invariants:
 * - ALLOCATION_ALGO_VERSIONED: dispatch by algoRef; same inputs → identical output.
 * - ALL_MATH_BIGINT: All weight and unit computation uses BigInt.
 * - WEIGHTS_VALIDATED: rejects floats, NaN, Infinity, unsafe integers.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

/** Input: joined selection + ingestion_receipts data for allocation pipeline. */
export interface SelectedReceiptForAllocation {
  readonly receiptId: string;
  readonly userId: string | null;
  readonly source: string;
  readonly eventType: string;
  readonly included: boolean;
  readonly weightOverrideMilli: bigint | null;
}

export interface ProposedAllocation {
  readonly userId: string;
  readonly proposedUnits: bigint;
  readonly activityCount: number;
}

// ---------------------------------------------------------------------------
// Receipt-weight allocation model (replaces user-scoped allocation for pipeline)
// ---------------------------------------------------------------------------

/** Allocator input — per-receipt, no userId, no claimant awareness. */
export interface ReceiptForWeighting {
  readonly receiptId: string;
  readonly source: string;
  readonly eventType: string;
  readonly included: boolean;
  readonly weightOverrideMilli: bigint | null;
}

/** Allocator output — per-receipt weight, not per-user. */
export interface ReceiptUnitWeight {
  readonly receiptId: string;
  readonly units: bigint;
}

/**
 * Compute per-receipt weights using the named algorithm version.
 * Pure function — no I/O, deterministic output for same inputs.
 * Throws if algoRef is unknown.
 */
export function computeReceiptWeights(
  algoRef: string,
  receipts: readonly ReceiptForWeighting[],
  weightConfig: Record<string, number>
): ReceiptUnitWeight[] {
  switch (algoRef) {
    case "weight-sum-v0":
      return receiptWeightSumV0(receipts, weightConfig);
    default:
      throw new Error(`Unknown allocation algorithm: ${algoRef}`);
  }
}

/**
 * V0 receipt-weight algorithm — weight-sum-v0:
 * 1. Filter to included === true
 * 2. For each receipt: weight = weightOverrideMilli ?? BigInt(weightConfig[`${source}:${eventType}`] ?? 0)
 * 3. Return sorted by receiptId (deterministic)
 */
function receiptWeightSumV0(
  receipts: readonly ReceiptForWeighting[],
  weightConfig: Record<string, number>
): ReceiptUnitWeight[] {
  const result: ReceiptUnitWeight[] = [];

  for (const receipt of receipts) {
    if (!receipt.included) continue;

    const configKey = `${receipt.source}:${receipt.eventType}`;
    const weight =
      receipt.weightOverrideMilli ?? BigInt(weightConfig[configKey] ?? 0);

    result.push({
      receiptId: receipt.receiptId,
      units: weight,
    });
  }

  return result.sort((a, b) => a.receiptId.localeCompare(b.receiptId));
}

/**
 * Compute proposed allocations using the named algorithm version.
 * Pure function — no I/O, deterministic output for same inputs.
 * Throws if algoRef is unknown.
 */
export function computeProposedAllocations(
  algoRef: string,
  events: readonly SelectedReceiptForAllocation[],
  weightConfig: Record<string, number>
): ProposedAllocation[] {
  switch (algoRef) {
    case "weight-sum-v0":
      return weightSumV0(events, weightConfig);
    default:
      throw new Error(`Unknown allocation algorithm: ${algoRef}`);
  }
}

/**
 * V0 algorithm — weight-sum-v0:
 * 1. Filter to included === true
 * 2. For each event: weight = weightOverrideMilli ?? BigInt(weightConfig[`${source}:${eventType}`] ?? 0)
 * 3. Group by userId, sum weights → proposedUnits, count → activityCount
 * 4. Return sorted by userId (deterministic)
 */
function weightSumV0(
  events: readonly SelectedReceiptForAllocation[],
  weightConfig: Record<string, number>
): ProposedAllocation[] {
  const userUnits = new Map<string, bigint>();
  const userCounts = new Map<string, number>();

  for (const event of events) {
    if (!event.included || !event.userId) continue;

    const configKey = `${event.source}:${event.eventType}`;
    const weight =
      event.weightOverrideMilli ?? BigInt(weightConfig[configKey] ?? 0);

    const current = userUnits.get(event.userId) ?? 0n;
    userUnits.set(event.userId, current + weight);

    const count = userCounts.get(event.userId) ?? 0;
    userCounts.set(event.userId, count + 1);
  }

  const allocations: ProposedAllocation[] = [];
  for (const [userId, proposedUnits] of userUnits) {
    allocations.push({
      userId,
      proposedUnits,
      activityCount: userCounts.get(userId) ?? 0,
    });
  }

  // Deterministic: sort by userId
  return allocations.sort((a, b) => a.userId.localeCompare(b.userId));
}

/**
 * Validate weight config values as safe integers (milli-units).
 * Rejects floats, NaN, Infinity, unsafe integers.
 * Throws on first invalid value.
 */
export function validateWeightConfig(config: Record<string, number>): void {
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isFinite(value)) {
      throw new RangeError(
        `Invalid weight config value for "${key}": ${value} (must be finite)`
      );
    }
    if (!Number.isInteger(value)) {
      throw new RangeError(
        `Invalid weight config value for "${key}": ${value} (must be an integer)`
      );
    }
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(
        `Invalid weight config value for "${key}": ${value} (exceeds safe integer range)`
      );
    }
  }
}

/**
 * Derive allocation algorithm ref from repo-spec attribution_pipeline.
 * Pure function — maps governance config to internal algorithm ID.
 */
export function deriveAllocationAlgoRef(attributionPipeline: string): string {
  switch (attributionPipeline) {
    case "cogni-v0.0":
      return "weight-sum-v0";
    default:
      throw new Error(`Unknown attribution_pipeline: ${attributionPipeline}`);
  }
}
