// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-plugins/plugins/weight-sum/descriptor`
 * Purpose: Weight-sum allocator descriptor — wraps computeReceiptWeights from attribution-ledger.
 * Scope: Pure descriptor binding. Does not perform I/O or modify allocation logic.
 * Invariants:
 * - ALLOCATOR_NEEDS_DECLARED: requiredEvaluationRefs validated by dispatchAllocator before compute.
 * - ALLOCATION_ALGO_VERSIONED: delegates to versioned weight-sum-v0 implementation.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-plugin-pipeline
 * @public
 */

import { computeReceiptWeights } from "@cogni/attribution-ledger";
import type { AllocatorDescriptor } from "@cogni/attribution-pipeline-contracts";
import { z } from "zod";

import { ECHO_EVALUATION_REF } from "../echo/descriptor";

/** Algorithm ref for the weight-sum allocator. */
export const WEIGHT_SUM_ALGO_REF = "weight-sum-v0";

/** Runtime schema for per-receipt allocator output. */
export const WeightSumOutputSchema = z.array(
  z.object({
    receiptId: z.string(),
    units: z.bigint(),
  })
);

/**
 * Weight-sum allocator descriptor.
 * Wraps `computeReceiptWeights("weight-sum-v0", ...)` from attribution-ledger.
 * Requires the echo evaluation (for event count validation) but does not
 * consume evaluation payloads — allocation is computed from receipts + weights.
 */
export const WEIGHT_SUM_ALLOCATOR: AllocatorDescriptor = {
  algoRef: WEIGHT_SUM_ALGO_REF,
  requiredEvaluationRefs: [ECHO_EVALUATION_REF],
  outputSchema: WeightSumOutputSchema,
  compute: async (context) => {
    return computeReceiptWeights(
      WEIGHT_SUM_ALGO_REF,
      context.receipts,
      context.weightConfig
    );
  },
};
