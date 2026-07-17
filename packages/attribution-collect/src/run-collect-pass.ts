// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-collect/run-collect-pass`
 * Purpose: In-process orchestrator for one epoch collect pass — the plain-async twin of CollectEpochWorkflow, run by a node against its OWN ledger DB.
 * Scope: Composes the ledger + enrichment activity factories directly (no Temporal). Does not change the operator's Temporal collect path; the worker still runs CollectEpochWorkflow byte-identically. Does not compute the epoch window's asOf — the caller supplies asOfIso (the workflow reads it from the schedule search attribute; the node reads it from the request).
 * Invariants:
 *   - SEQUENCE_MIRRORS_WORKFLOW: derive weights → find stale → transition|ensure → (if open) per-source collect → materialize → evaluate → allocate → ensure pool. Same order as CollectEpochWorkflow + its two stage children.
 *   - WEBHOOK_ONLY_SKIPS_POLL: a source with no poll adapter (webhook-only, the spawned-node shape) is skipped for polling; its receipts already arrived via the Phase-1 receipt seam, so the pass proceeds to select/enrich/allocate over receipts already in the DB. Never throws on a missing poll adapter.
 *   - NODE_SCOPED: nodeId + scopeId flow from deps into the activity factories.
 * Side-effects: IO (database, GitHub API when a poll adapter is present)
 * Links: docs/design/attribution-operator-gateway.md, packages/temporal-workflows/src/workflows/collect-epoch.workflow.ts
 * @public
 */

import { computeEpochWindowV1 } from "@cogni/attribution-ledger/epoch-window";

import { createEnrichmentActivities } from "./activities/enrichment.js";
import {
  type AttributionActivityDeps,
  createAttributionActivities,
} from "./activities/ledger.js";
import type { AttributionIngestRunV1 } from "./contract.js";

/**
 * Dependencies for one collect pass — identical to the ledger activity deps.
 * The enrichment activities consume a subset of these (attributionStore, nodeId,
 * logger, registries).
 */
export type RunCollectPassDeps = AttributionActivityDeps;

/** Best-effort summary echoed back by the dispatch route. */
export interface CollectPassSummary {
  readonly epochId: string;
  readonly epochStatus: string;
  readonly sourcesPolled: number;
  readonly receiptsInserted: number;
}

/**
 * Run one epoch collect pass in-process against the node's own ledger DB.
 *
 * 1-3. Setup: compute window (from asOfIso), extract pipeline, derive weights.
 * 4-5. Detect stale epoch → build locked evaluations → transition atomically
 *      (close stale + create) or simple find-or-create.
 * 6.   Per source: skip webhook-only sources, else resolve streams → load cursor
 *      → collect → insert receipts → save cursor.
 * 7-9. Materialize selection → evaluate draft → compute allocations.
 * 10.  Ensure pool components (base_issuance from config, idempotent).
 *
 * If the epoch is already closed/finalized, returns after setup (no collection).
 */
export async function runCollectPass(
  deps: RunCollectPassDeps,
  config: AttributionIngestRunV1,
  asOfIso: string
): Promise<CollectPassSummary> {
  const { logger } = deps;

  const ledger = createAttributionActivities(deps);
  const enrichment = createEnrichmentActivities({
    attributionStore: deps.attributionStore,
    nodeId: deps.nodeId,
    logger: deps.logger,
    registries: deps.registries,
  });

  // 1. Derive epoch window from the request's asOf (in the workflow this comes
  //    from the TemporalScheduledStartTime search attribute).
  const { periodStartIso, periodEndIso } = computeEpochWindowV1({
    asOfIso,
    epochLengthDays: config.epochLengthDays,
    timezone: "UTC",
    weekStart: "monday",
  });

  // 2. Extract attributionPipeline from activity sources (required — no fallback)
  const firstSource = Object.values(config.activitySources)[0];
  if (!firstSource?.attributionPipeline) {
    throw new Error(
      "attributionPipeline missing from activitySources — check repo-spec.yaml"
    );
  }
  const attributionPipeline = firstSource.attributionPipeline;

  // 3. Derive weight config from the pipeline profile (profile owns weights)
  const { weightConfig } = await enrichment.deriveWeightConfig({
    attributionPipeline,
  });

  // 4. Detect stale open epoch from a previous window
  const { staleEpoch } = await ledger.findStaleOpenEpoch({
    periodStart: periodStartIso,
    periodEnd: periodEndIso,
  });

  // 5. Ensure epoch — either via transition (close stale + create) or find-or-create
  let epoch: {
    readonly epochId: string;
    readonly status: string;
    readonly weightConfig: Record<string, number>;
  };
  if (staleEpoch) {
    const { evaluations, artifactsHash } =
      await enrichment.buildLockedEvaluations({
        epochId: staleEpoch.epochId,
        attributionPipeline,
      });

    epoch = await ledger.transitionEpochForWindow({
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
    epoch = await ledger.ensureEpochForWindow({
      periodStart: periodStartIso,
      periodEnd: periodEndIso,
      weightConfig,
    });
  }

  // If epoch already closed/finalized, skip collection.
  if (epoch.status !== "open") {
    return {
      epochId: epoch.epochId,
      epochStatus: epoch.status,
      sourcesPolled: 0,
      receiptsInserted: 0,
    };
  }

  // 6. Collect from all sources (in-process twin of CollectSourcesWorkflow).
  let sourcesPolled = 0;
  let receiptsInserted = 0;
  for (const [source, sourceConfig] of Object.entries(config.activitySources)) {
    // WEBHOOK_ONLY_SKIPS_POLL: a spawned node has webhook-only registrations
    // (no poll adapter). Its receipts already arrived via the Phase-1 receipt
    // seam, so skip polling and let selection/enrich/allocate run over the
    // receipts already in this node's DB. Do NOT throw on a missing poll adapter.
    const reg = deps.sourceRegistrations.get(source);
    if (!reg?.poll) {
      logger.info(
        { source, event: "attribution.collect_pass.poll_skipped_no_adapter" },
        `No poll adapter for source "${source}" — skipping poll (webhook-only ingestion; receipts already delivered)`
      );
      continue;
    }

    sourcesPolled++;
    const { streams } = await ledger.resolveStreams({ source });
    for (const sourceRef of sourceConfig.sourceRefs) {
      for (const stream of streams) {
        const cursorValue = await ledger.loadCursor({
          source,
          stream,
          sourceRef,
        });
        const result = await ledger.collectFromSource({
          source,
          streams: [stream],
          cursorValue,
          periodStart: periodStartIso,
          periodEnd: periodEndIso,
        });
        if (result.events.length > 0) {
          await ledger.insertReceipts({
            events: result.events,
            producerVersion: result.producerVersion,
          });
          receiptsInserted += result.events.length;
        }
        await ledger.saveCursor({
          source,
          stream,
          sourceRef,
          cursorValue: result.nextCursorValue,
        });
      }
    }
  }

  // 7-9. Enrich and allocate (in-process twin of EnrichAndAllocateWorkflow).
  await ledger.materializeSelection({
    epochId: epoch.epochId,
    attributionPipeline,
  });
  await enrichment.evaluateEpochDraft({
    epochId: epoch.epochId,
    attributionPipeline,
  });
  await ledger.computeAllocations({
    epochId: epoch.epochId,
    attributionPipeline,
    weightConfig: epoch.weightConfig,
  });

  // 10. Ensure pool components (base_issuance from config, idempotent).
  if (config.baseIssuanceCredits) {
    await ledger.ensurePoolComponents({
      epochId: epoch.epochId,
      baseIssuanceCredits: config.baseIssuanceCredits,
    });
  }

  return {
    epochId: epoch.epochId,
    epochStatus: epoch.status,
    sourcesPolled,
    receiptsInserted,
  };
}
