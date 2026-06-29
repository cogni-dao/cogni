// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/workflows/collect-epoch`
 * Purpose: Temporal Workflow orchestrator for epoch ingestion — delegates to child workflows for collection, enrichment, and allocation.
 * Scope: Deterministic orchestration only. All I/O happens in Activities (via child workflows). Steps: compute window → transition epoch (close stale + create) → CollectSourcesWorkflow → EnrichAndAllocateWorkflow → ensure pool. Does not handle finalization (see FinalizeEpochWorkflow).
 * Invariants:
 *   - Per TEMPORAL_DETERMINISM: No I/O, network calls, or direct imports of adapters
 *   - Per WRITES_VIA_TEMPORAL: All writes execute in Temporal activities
 *   - Per CHILD_WORKFLOW_COMPOSITION: Collection and enrichment stages delegate to typed child workflows via executeChild()
 *   - Per ACTIVITY_IDEMPOTENT: All activities idempotent via PK constraints or upsert
 *   - Per WEIGHT_PINNING: Epoch weightConfig is pinned at creation; subsequent runs use pinned value
 *   - Per EPOCH_CLOSE_ON_TRANSITION: Previous epoch closes at start of new window, not via timer/grace period
 * Side-effects: none (deterministic orchestration only)
 * Links: docs/spec/attribution-ledger.md, docs/spec/temporal-patterns.md
 * @public
 */

import { computeEpochWindowV1 } from "@cogni/attribution-ledger/epoch-window";
import {
  ApplicationFailure,
  executeChild,
  ParentClosePolicy,
  proxyActivities,
  workflowInfo,
} from "@temporalio/workflow";
import { STANDARD_ACTIVITY_OPTIONS } from "../activity-profiles.js";
import type {
  EnrichmentActivities,
  LedgerActivities,
} from "../activity-types.js";
import { CollectSourcesWorkflow } from "./stages/collect-sources.workflow.js";
import { EnrichAndAllocateWorkflow } from "./stages/enrich-and-allocate.workflow.js";

// Proxy ledger activities with standard timeout/retry profile.
// Only activities that remain inline in this parent workflow (setup + pool).
const {
  ensureEpochForWindow,
  findStaleOpenEpoch,
  transitionEpochForWindow,
  ensurePoolComponents,
} = proxyActivities<LedgerActivities>(STANDARD_ACTIVITY_OPTIONS);

const { deriveWeightConfig, buildLockedEvaluations } =
  proxyActivities<EnrichmentActivities>(STANDARD_ACTIVITY_OPTIONS);

/** Schedule adapter wrapper (infra — extract .input immediately) */
interface ScheduleActionPayload {
  scheduleId?: string;
  temporalScheduleId?: string;
  graphId?: string;
  executionGrantId?: string;
  input: AttributionIngestRunV1;
}

/** Versioned domain envelope — sole contract for this workflow. */
export interface AttributionIngestRunV1 {
  readonly version: 1;
  readonly scopeId: string;
  readonly scopeKey: string;
  readonly epochLengthDays: number;
  /** Map of source → { attributionPipeline, sourceRefs } */
  readonly activitySources: Record<
    string,
    {
      attributionPipeline: string;
      sourceRefs: string[];
    }
  >;
  /** Pool budget config — base_issuance_credits as string (bigint serialized). Optional for backward compat. */
  readonly baseIssuanceCredits?: string;
  /** EVM approver addresses for epoch close. Optional for backward compat. */
  readonly approvers?: string[];
}

/**
 * CollectEpochWorkflow — orchestrates one epoch collection pass.
 *
 * 1-3. Setup: compute window, derive weights
 * 4-5. Detect stale epoch → build evaluations → transition atomically (or simple find-or-create)
 * 6.   Delegate source collection to CollectSourcesWorkflow (child)
 * 7-9. Delegate enrichment + allocation to EnrichAndAllocateWorkflow (child)
 * 10.  Ensure pool components (inline, conditional)
 *
 * Epoch close happens at the START of the next window (not via timer/grace period).
 * When a new window begins, any stale open epoch is closed atomically with the new epoch's creation.
 *
 * Receives ScheduleActionPayload from the schedule adapter; extracts .input immediately.
 * Deterministic workflow ID: ledger-collect-{scopeKey}-{periodStart}-{periodEnd}
 * (set by the schedule action, not by this workflow)
 */
export async function CollectEpochWorkflow(
  raw: ScheduleActionPayload
): Promise<void> {
  const config = raw.input;

  // 1. Derive epoch window — pure helper from @cogni/attribution-ledger (safe in workflow code)
  const info = workflowInfo();
  const scheduledStartTime = (
    info.searchAttributes?.TemporalScheduledStartTime as Date[] | undefined
  )?.[0];
  if (!scheduledStartTime) {
    throw ApplicationFailure.nonRetryable(
      "TemporalScheduledStartTime missing — workflow must be triggered by a schedule"
    );
  }
  const { periodStartIso, periodEndIso } = computeEpochWindowV1({
    asOfIso: scheduledStartTime.toISOString(),
    epochLengthDays: config.epochLengthDays,
    timezone: "UTC",
    weekStart: "monday",
  });

  // 2. Extract attributionPipeline from activity sources (required — no fallback)
  const firstSource = Object.values(config.activitySources)[0];
  if (!firstSource?.attributionPipeline) {
    throw ApplicationFailure.nonRetryable(
      "attributionPipeline missing from activitySources — check repo-spec.yaml"
    );
  }
  const attributionPipeline = firstSource.attributionPipeline;

  // 3. Derive weight config from the pipeline profile (profile owns weights)
  const { weightConfig } = await deriveWeightConfig({ attributionPipeline });

  // 4. Detect stale open epoch from a previous window
  const { staleEpoch } = await findStaleOpenEpoch({
    periodStart: periodStartIso,
    periodEnd: periodEndIso,
  });

  // 5. Ensure epoch — either via transition (close stale + create) or simple find-or-create
  let epoch: {
    readonly epochId: string;
    readonly status: string;
    readonly weightConfig: Record<string, number>;
  };
  if (staleEpoch) {
    // Build locked evaluations for the stale epoch before closing it
    const { evaluations, artifactsHash } = await buildLockedEvaluations({
      epochId: staleEpoch.epochId,
      attributionPipeline,
    });

    // Transition: close stale epoch + create new epoch in one DB transaction.
    // Hash computation happens inside the activity (crypto not safe in workflow code).
    epoch = await transitionEpochForWindow({
      periodStart: periodStartIso,
      periodEnd: periodEndIso,
      weightConfig,
      closeParams: {
        staleEpochId: staleEpoch.epochId,
        staleWeightConfig: staleEpoch.weightConfig,
        approvers: config.approvers ?? [],
        attributionPipeline,
        evaluations,
        artifactsHash,
      },
    });
  } else {
    // No stale epoch — simple find-or-create (existing path)
    epoch = await ensureEpochForWindow({
      periodStart: periodStartIso,
      periodEnd: periodEndIso,
      weightConfig,
    });
  }

  // If epoch already closed/finalized, skip collection
  if (epoch.status !== "open") return;

  // 6. Collect from all sources (child workflow — independently retryable/visible)
  await executeChild(CollectSourcesWorkflow, {
    args: [
      {
        epochId: epoch.epochId,
        sources: config.activitySources,
        periodStart: periodStartIso,
        periodEnd: periodEndIso,
      },
    ],
    workflowId: `collect-sources-${epoch.epochId}`,
    parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_TERMINATE,
  });

  // 7-9. Enrich and allocate (child workflow — selection → enrichment → allocation)
  await executeChild(EnrichAndAllocateWorkflow, {
    args: [
      {
        epochId: epoch.epochId,
        attributionPipeline,
        weightConfig: epoch.weightConfig,
      },
    ],
    workflowId: `enrich-allocate-${epoch.epochId}`,
    parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_TERMINATE,
  });

  // 10. Ensure pool components (base_issuance from config, idempotent)
  if (config.baseIssuanceCredits) {
    await ensurePoolComponents({
      epochId: epoch.epochId,
      baseIssuanceCredits: config.baseIssuanceCredits,
    });
  }
}
