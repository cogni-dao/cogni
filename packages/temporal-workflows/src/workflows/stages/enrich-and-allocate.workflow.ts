// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/workflows/stages/enrich-and-allocate`
 * Purpose: Child workflow for selection materialization, enrichment evaluation, and allocation computation.
 * Scope: Deterministic orchestration only. Does not perform I/O — all external calls happen in Activities.
 * Invariants:
 *   - Per TEMPORAL_DETERMINISM: No I/O — only proxyActivities calls and deterministic logic
 *   - Per STAGE_IO_COLOCATED: Input type defined here, not in a separate barrel
 *   - Per ACTIVITY_IDEMPOTENT: Existing activity idempotency guarantees preserved
 * Side-effects: none (deterministic orchestration only)
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger, https://cognidao.org/knowledge/temporal-workflow-rules
 * @public
 */

import { proxyActivities } from "@temporalio/workflow";
import { STANDARD_ACTIVITY_OPTIONS } from "../../activity-profiles.js";
import type {
  EnrichmentActivities,
  LedgerActivities,
} from "../../activity-types.js";

const { materializeSelection, computeAllocations } =
  proxyActivities<LedgerActivities>(STANDARD_ACTIVITY_OPTIONS);

const { evaluateEpochDraft } = proxyActivities<EnrichmentActivities>(
  STANDARD_ACTIVITY_OPTIONS
);

/** Input for EnrichAndAllocateWorkflow — plain serializable object. */
export interface EnrichAndAllocateInput {
  readonly epochId: string;
  readonly attributionPipeline: string;
  readonly weightConfig: Record<string, number>;
}

/**
 * EnrichAndAllocateWorkflow — materializeSelection → evaluateEpochDraft → computeAllocations.
 *
 * Three sequential activities that always run together. Reusable by future
 * "re-enrich" or "manual recalculate" workflows.
 */
export async function EnrichAndAllocateWorkflow(
  input: EnrichAndAllocateInput
): Promise<void> {
  // Materialize selection and resolve identities (SELECTION_AUTO_POPULATE)
  await materializeSelection({
    epochId: input.epochId,
    attributionPipeline: input.attributionPipeline,
  });

  // Evaluate epoch with draft evaluations (profile-driven enricher dispatch)
  await evaluateEpochDraft({
    epochId: input.epochId,
    attributionPipeline: input.attributionPipeline,
  });

  // Compute allocations
  await computeAllocations({
    epochId: input.epochId,
    attributionPipeline: input.attributionPipeline,
    weightConfig: input.weightConfig,
  });
}
