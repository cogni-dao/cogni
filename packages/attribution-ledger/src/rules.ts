// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-ledger/rules`
 * Purpose: Statement item computation with BIGINT arithmetic and largest-remainder rounding (ALL_MATH_BIGINT).
 * Scope: Pure function. Does not perform I/O or mutate external state.
 * Invariants:
 * - All arithmetic uses BigInt — no floating point (ALL_MATH_BIGINT).
 * - Sum of statement item amounts === poolTotalCredits (STATEMENT_DETERMINISTIC).
 * - Largest-remainder method distributes rounding residual.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

import type { FinalizedAllocation, StatementLineItem } from "./model";

/**
 * Compute proportional payouts from finalized allocations and a pool total.
 *
 * 1. Group allocations by user_id, sum valuation_units per user
 * 2. Compute each user's share: user_units / total_units
 * 3. Distribute pool_total_credits proportionally using BIGINT arithmetic
 * 4. Apply largest-remainder rounding to ensure exact sum equals pool total
 *
 * @param allocations - Finalized allocations (may contain multiple per user)
 * @param poolTotalCredits - Total credit pool to distribute
 * @returns Sorted payout line items (deterministic order by userId)
 */
export function computeStatementItems(
  allocations: readonly FinalizedAllocation[],
  poolTotalCredits: bigint
): StatementLineItem[] {
  if (allocations.length === 0) {
    return [];
  }

  if (poolTotalCredits <= 0n) {
    return [];
  }

  // Guard: reject negative valuationUnits (append-only tables can't be fixed later)
  for (const alloc of allocations) {
    if (alloc.valuationUnits < 0n) {
      throw new RangeError(
        `Negative valuationUnits for user ${alloc.userId}: ${alloc.valuationUnits}`
      );
    }
  }

  // Step 1: Group by userId, sum units
  const userUnits = new Map<string, bigint>();
  for (const alloc of allocations) {
    const current = userUnits.get(alloc.userId) ?? 0n;
    userUnits.set(alloc.userId, current + alloc.valuationUnits);
  }

  // Compute total units
  let totalUnits = 0n;
  for (const units of userUnits.values()) {
    totalUnits += units;
  }

  if (totalUnits === 0n) {
    return [];
  }

  // Step 2-3: Compute floor allocations and remainders
  // Sort by userId for deterministic output
  const sortedUsers = [...userUnits.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  );

  const floorAllocations: Array<{
    userId: string;
    totalUnits: bigint;
    floor: bigint;
    remainder: bigint;
    index: number;
  }> = [];

  let floorSum = 0n;

  for (const [userId, units] of sortedUsers) {
    // floor = (units * poolTotalCredits) / totalUnits (integer division)
    const floor = (units * poolTotalCredits) / totalUnits;
    // remainder = (units * poolTotalCredits) % totalUnits
    const remainder = (units * poolTotalCredits) % totalUnits;

    floorAllocations.push({
      userId,
      totalUnits: units,
      floor,
      remainder,
      index: floorAllocations.length,
    });
    floorSum += floor;
  }

  // Step 4: Largest-remainder rounding
  // Residual credits to distribute = poolTotalCredits - sum(floors)
  let residual = poolTotalCredits - floorSum;

  // Sort by remainder descending, then by userId for deterministic tie-breaking
  const byRemainder = [...floorAllocations].sort((a, b) => {
    if (b.remainder !== a.remainder) {
      return b.remainder > a.remainder ? 1 : -1;
    }
    return a.userId.localeCompare(b.userId);
  });

  const bonuses = new Map<string, bigint>();
  for (const alloc of byRemainder) {
    if (residual <= 0n) break;
    bonuses.set(alloc.userId, 1n);
    residual -= 1n;
  }

  // Build final payouts, maintaining deterministic userId sort order
  return floorAllocations.map(({ userId, totalUnits: units, floor }) => {
    const bonus = bonuses.get(userId) ?? 0n;
    const amountCredits = floor + bonus;

    // Compute share as a decimal string with 6 fractional digits
    // Scale to 6 decimal places: (units * 10^6) / totalUnits
    const SHARE_SCALE = 10n ** 6n;
    const scaledShare = (units * SHARE_SCALE) / totalUnits;
    const wholePart = scaledShare / SHARE_SCALE;
    const fracPart = scaledShare % SHARE_SCALE;
    const share = `${wholePart}.${fracPart.toString().padStart(6, "0")}`;

    return {
      userId,
      totalUnits: units,
      share,
      amountCredits,
    };
  });
}
