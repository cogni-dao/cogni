// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/services/activity`
 * Purpose: Activity date range validation and step derivation utilities.
 * Scope: Validates inputs for Activity dashboard. Does not access DB directly.
 * Invariants:
 * - Enforces max time range (90 days).
 * - Enforces maxPoints (~48 buckets) via step selection.
 * - Throws InvalidRangeError for invalid ranges (from >= to).
 * Side-effects: none
 * Links: [activity.server.ts](../../../app/_facades/ai/activity.server.ts), ai.activity.v1.contract.ts
 * @public
 */

import {
  type ActivityStep,
  MAX_RANGE_FOR_STEP,
  MAX_RANGE_MS,
  STEP_MS,
} from "@cogni/node-contracts";

export class InvalidRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRangeError";
  }
}

/**
 * Ordered steps from finest to coarsest granularity.
 * Max is 1d (no weekly buckets - too coarse for useful analysis).
 */
const STEPS_ORDERED: ActivityStep[] = ["5m", "15m", "1h", "6h", "1d"];

/**
 * Derive the optimal step for a given range.
 * Picks the finest granularity that keeps bucket count <= 48.
 */
export function deriveStep(rangeMs: number): ActivityStep {
  for (const step of STEPS_ORDERED) {
    const bucketCount = Math.ceil(rangeMs / STEP_MS[step]);
    if (bucketCount <= 48) {
      return step;
    }
  }
  // Fallback to coarsest (1d)
  return "1d";
}

/**
 * Validate activity date range and step constraints.
 * Throws InvalidRangeError on validation failure.
 *
 * @returns { effectiveStep, diffDays } - Server-derived step and days for avgDay calculations
 */
export function validateActivityRange(params: {
  from: Date;
  to: Date;
  step?: ActivityStep | undefined;
}): { effectiveStep: ActivityStep; diffDays: number } {
  const { from, to, step } = params;

  if (from.getTime() >= to.getTime()) {
    throw new InvalidRangeError("Invalid time range: from must be before to");
  }

  const diffMs = to.getTime() - from.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  // Enforce overall max range (90 days)
  if (diffMs > MAX_RANGE_MS) {
    throw new InvalidRangeError("Date range too large (max 90 days)");
  }

  // Derive step if not provided
  const effectiveStep = step ?? deriveStep(diffMs);

  // Validate step is appropriate for range (maxPoints check)
  if (diffMs > MAX_RANGE_FOR_STEP[effectiveStep]) {
    const maxDays = Math.floor(
      MAX_RANGE_FOR_STEP[effectiveStep] / (1000 * 60 * 60 * 24)
    );
    throw new InvalidRangeError(
      `Date range too large for ${effectiveStep} step (max ~${maxDays} days for ~48 buckets)`
    );
  }

  return { effectiveStep, diffDays };
}
