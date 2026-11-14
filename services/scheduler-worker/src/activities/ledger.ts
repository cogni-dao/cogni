// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/activities/ledger`
 * Purpose: Temporal Activities for the ledger collect pipeline — ingestion, selection, allocation, pool, and epoch transition. Finalization runs IN-PROCESS in the node app (story.5007), NOT here.
 * Scope: Plain async functions that perform I/O (DB, GitHub API). Called by CollectEpochWorkflow. Does not contain deterministic orchestration logic.
 * Invariants:
 *   - NO_DOMAIN_LOGIC_HERE: this file must never contain selection policies, allocation formulas, enrichment logic, or source-specific branching (e.g. `if eventType === "pr_merged"`). It loads data, dispatches to contracts/plugins, and writes results.
 *   - Per RECEIPT_IDEMPOTENT: All activities idempotent via PK constraints or upsert
 *   - Per CURSOR_STATE_PERSISTED: Cursors saved after each collect() call
 *   - Per NODE_SCOPED: All operations pass nodeId + scopeId from deps
 *   - Per TEMPORAL_DETERMINISM: Activities contain all I/O; workflows call only these proxies
 *   - Per SOURCE_NO_ADAPTER: collectFromSource and resolveStreams throw if no poll adapter registered for a configured source (fail loud, not silent skip)
 *   - Per SELECTION_AUTO_POPULATE: materializeSelection inserts new selections (DO NOTHING on conflict), updates only userId on unresolved rows
 *   - Per SELECTION_POLICY_DELEGATED: materializeSelection resolves selection policy from the pipeline profile and dispatches via dispatchSelectionPolicy — zero hardcoded inclusion logic
 *   - Per IDENTITY_BEST_EFFORT: Unresolved receipts get userId=null in selection rows, never dropped
 *   - Per USER_PROJECTIONS_RECOMPUTABLE: upsertUserProjections persists recomputable user projections only
 *   - Per CONFIG_LOCKED_AT_REVIEW: transitionEpochForWindow pins allocationAlgoRef + weightConfigHash when closing stale epoch
 *   - Per EVALUATION_FINAL_ATOMIC: transitionEpochForWindow passes evaluations to store.transitionEpochForWindow for atomic close + create
 *   - FINALIZE_IS_IN_PROCESS (story.5007): epoch finalization + the R3 cumulative fold no longer run here — they run synchronously in the operator app's finalize route via `runFinalizeEpoch` (@cogni/attribution-pipeline-plugins). This module holds NO distribution/wallet/config deps.
 * Side-effects: IO (database, GitHub API)
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger, https://cognidao.org/knowledge/temporal-workflow-rules, packages/attribution-pipeline-plugins/src/finalize/run-finalize-epoch.ts
 * @internal
 */

import type {
  CloseIngestionWithEvaluationsParams,
  UnselectedReceipt,
} from "@cogni/attribution-ledger";
import {
  computeApproverSetHash,
  computeWeightConfigHash,
  estimatePoolComponentsV0,
  sha256OfCanonicalJson,
  validateWeightConfig,
} from "@cogni/attribution-ledger";
import {
  dispatchAllocator,
  dispatchSelectionPolicy,
  resolveProfile,
} from "@cogni/attribution-pipeline-contracts";
import type { DefaultRegistries } from "@cogni/attribution-pipeline-plugins";
import type { ActivityEvent } from "@cogni/ingestion-core";

import type { Logger } from "../observability/logger.js";
import type {
  AttributionStore,
  DataSourceRegistration,
} from "../ports/index.js";

/**
 * Dependencies injected into ledger activities at worker creation.
 */
export interface AttributionActivityDeps {
  readonly attributionStore: AttributionStore;
  readonly sourceRegistrations: ReadonlyMap<string, DataSourceRegistration>;
  readonly registries: DefaultRegistries;
  readonly nodeId: string;
  readonly scopeId: string;
  readonly logger: Logger;
}

/**
 * Input for ensureEpochForWindow activity.
 * scopeId is NOT in input — uses injected deps.scopeId only.
 */
export interface EnsureEpochInput {
  readonly periodStart: string; // ISO date
  readonly periodEnd: string; // ISO date
  readonly weightConfig: Record<string, number>;
}

/**
 * Output from ensureEpochForWindow activity.
 */
export interface EnsureEpochOutput {
  readonly epochId: string; // bigint serialized as string for Temporal
  readonly status: string;
  readonly isNew: boolean;
  readonly weightConfig: Record<string, number>;
}

/**
 * Input for loadCursor activity.
 */
export interface LoadCursorInput {
  readonly source: string;
  readonly stream: string;
  readonly sourceRef: string;
}

/**
 * Input for collectFromSource activity.
 */
export interface CollectFromSourceInput {
  readonly source: string;
  readonly streams: string[];
  readonly cursorValue: string | null;
  readonly periodStart: string; // ISO date
  readonly periodEnd: string; // ISO date
}

/**
 * Output from collectFromSource activity.
 */
export interface CollectFromSourceOutput {
  readonly events: ActivityEvent[];
  readonly nextCursorValue: string;
  readonly nextCursorStreamId: string;
  readonly producerVersion: string;
}

/**
 * Input for insertReceipts activity.
 */
export interface InsertReceiptsInput {
  readonly events: ActivityEvent[];
  readonly producerVersion: string;
}

/**
 * Input for saveCursor activity.
 */
export interface SaveCursorInput {
  readonly source: string;
  readonly stream: string;
  readonly sourceRef: string;
  readonly cursorValue: string;
}

/**
 * Input for materializeSelection activity.
 * epochId + attributionPipeline — activity loads epoch row for period dates,
 * then resolves the selection policy from the pipeline profile.
 */
export interface MaterializeSelectionInput {
  readonly epochId: string; // bigint serialized as string for Temporal
  readonly attributionPipeline: string;
}

/**
 * Output from materializeSelection activity.
 */
export interface MaterializeSelectionOutput {
  readonly totalReceipts: number;
  readonly newSelections: number;
  readonly resolved: number;
  readonly unresolved: number;
}

/**
 * Input for computeAllocations activity.
 */
export interface ComputeAllocationsInput {
  readonly epochId: string; // bigint serialized
  readonly attributionPipeline: string;
  readonly weightConfig: Record<string, number>;
}

/**
 * Output from computeAllocations activity.
 */
export interface ComputeAllocationsOutput {
  readonly totalAllocations: number;
  readonly totalProposedUnits: string; // bigint serialized
}

/**
 * Input for ensurePoolComponents activity.
 */
export interface EnsurePoolComponentsInput {
  readonly epochId: string; // bigint serialized
  readonly baseIssuanceCredits: string; // bigint serialized
}

/**
 * Output from ensurePoolComponents activity.
 */
export interface EnsurePoolComponentsOutput {
  readonly componentsEnsured: number;
}

/**
 * Input for resolveStreams activity.
 */
export interface ResolveStreamsInput {
  readonly source: string;
}

/**
 * Output from resolveStreams activity.
 */
export interface ResolveStreamsOutput {
  readonly streams: string[];
}

/**
 * Input for findStaleOpenEpoch activity.
 * Detects if an open epoch exists for a DIFFERENT window than the requested one.
 */
export interface FindStaleOpenEpochInput {
  readonly periodStart: string; // ISO date — current window start
  readonly periodEnd: string; // ISO date — current window end
}

/**
 * Output from findStaleOpenEpoch activity.
 * Returns stale epoch info if found, null otherwise.
 */
export interface FindStaleOpenEpochOutput {
  readonly staleEpoch: {
    readonly epochId: string; // bigint serialized
    readonly weightConfig: Record<string, number>;
    readonly periodStart: string; // ISO date
    readonly periodEnd: string; // ISO date
  } | null;
}

/**
 * Input for transitionEpochForWindow activity.
 * Atomically closes stale open epoch + creates epoch for a new window.
 * Only called when findStaleOpenEpoch detected a stale epoch.
 * Hash computation happens inside the activity (not safe in Temporal workflow code).
 */
export interface TransitionEpochForWindowInput {
  readonly periodStart: string; // ISO date
  readonly periodEnd: string; // ISO date
  readonly weightConfig: Record<string, number>;
  /** Close payload for the stale epoch — always required. */
  readonly closeParams: {
    readonly staleEpochId: string; // bigint serialized
    readonly staleWeightConfig: Record<string, number>; // pinned config from stale epoch
    readonly approvers: string[];
    readonly attributionPipeline: string; // needed to resolve allocatorRef
    readonly evaluations: ReadonlyArray<{
      readonly nodeId: string;
      readonly epochId: string; // bigint as decimal string for Temporal wire format
      readonly evaluationRef: string;
      readonly status: "draft" | "locked";
      readonly algoRef: string;
      readonly inputsHash: string;
      readonly payloadHash: string;
      readonly payloadJson: Record<string, unknown>;
    }>;
    readonly artifactsHash: string;
  };
}

/**
 * Output from transitionEpochForWindow activity.
 */
export interface TransitionEpochForWindowOutput {
  readonly epochId: string; // bigint serialized
  readonly status: string;
  readonly isNew: boolean;
  readonly weightConfig: Record<string, number>;
  readonly closedStaleEpochId: string; // always set — this method only called for stale transitions
}

/**
 * Creates ledger activity functions with injected dependencies.
 * Follows the same DI pattern as createActivities() in activities/index.ts.
 */
export function createAttributionActivities(deps: AttributionActivityDeps) {
  const {
    attributionStore,
    sourceRegistrations,
    registries,
    nodeId,
    scopeId,
    logger,
  } = deps;

  function toEvaluationPayloadMap(
    evaluations: ReadonlyArray<{
      readonly evaluationRef: string;
      readonly payloadJson: Record<string, unknown> | null;
    }>
  ): ReadonlyMap<string, Record<string, unknown>> {
    const payloads = new Map<string, Record<string, unknown>>();
    for (const evaluation of evaluations) {
      if (evaluation.payloadJson) {
        payloads.set(evaluation.evaluationRef, evaluation.payloadJson);
      }
    }
    return payloads;
  }

  /**
   * Creates or returns an existing epoch for the given time window.
   * Looks up by window (any status), not just open epochs — handles finalized epochs.
   * Pins weightConfig on first create; returns existing config if epoch already exists.
   */
  async function ensureEpochForWindow(
    input: EnsureEpochInput
  ): Promise<EnsureEpochOutput> {
    const { periodStart, periodEnd, weightConfig } = input;
    logger.info(
      { periodStart, periodEnd, scopeId },
      "Ensuring epoch for window"
    );

    // Check if an epoch already exists for this window (any status)
    const existing = await attributionStore.getEpochByWindow(
      nodeId,
      scopeId,
      new Date(periodStart),
      new Date(periodEnd)
    );
    if (existing) {
      // Weight config drift detection — log warning but use pinned config
      if (
        JSON.stringify(weightConfig) !== JSON.stringify(existing.weightConfig)
      ) {
        logger.warn(
          {
            epochId: existing.id.toString(),
            inputWeights: weightConfig,
            pinnedWeights: existing.weightConfig,
          },
          "Weight config drift detected — using pinned config from epoch creation"
        );
      }

      logger.info(
        { epochId: existing.id.toString(), status: existing.status },
        "Found existing epoch for window"
      );
      return {
        epochId: existing.id.toString(),
        status: existing.status,
        isNew: false,
        weightConfig: existing.weightConfig,
      };
    }

    // Create new epoch — DB constraint ensures EPOCH_WINDOW_UNIQUE.
    // Race: another worker may create the same epoch between our read and write.
    // On unique constraint violation, re-query and return the existing epoch.
    try {
      const epoch = await attributionStore.createEpoch({
        nodeId,
        scopeId,
        periodStart: new Date(periodStart),
        periodEnd: new Date(periodEnd),
        weightConfig,
      });

      logger.info(
        { epochId: epoch.id.toString(), status: epoch.status },
        "Created new epoch"
      );

      return {
        epochId: epoch.id.toString(),
        status: epoch.status,
        isNew: true,
        weightConfig: epoch.weightConfig,
      };
    } catch (err) {
      // Unique constraint violation — another worker created the epoch concurrently
      const raceEpoch = await attributionStore.getEpochByWindow(
        nodeId,
        scopeId,
        new Date(periodStart),
        new Date(periodEnd)
      );
      if (raceEpoch) {
        logger.info(
          { epochId: raceEpoch.id.toString(), status: raceEpoch.status },
          "Epoch created by concurrent worker — using existing"
        );
        return {
          epochId: raceEpoch.id.toString(),
          status: raceEpoch.status,
          isNew: false,
          weightConfig: raceEpoch.weightConfig,
        };
      }
      // Not a race condition — rethrow original error
      throw err;
    }
  }

  /**
   * Loads cursor from source_cursors for incremental sync.
   * Returns null if no cursor exists (first collection).
   */
  async function loadCursor(input: LoadCursorInput): Promise<string | null> {
    const { source, stream, sourceRef } = input;
    logger.info({ source, stream, sourceRef }, "Loading cursor");

    const cursor = await attributionStore.getCursor(
      nodeId,
      scopeId,
      source,
      stream,
      sourceRef
    );

    if (cursor) {
      logger.info(
        { source, stream, cursorValue: cursor.cursorValue },
        "Cursor loaded"
      );
      return cursor.cursorValue;
    }

    logger.info({ source, stream }, "No cursor found, starting fresh");
    return null;
  }

  /**
   * Calls adapter.collect() to fetch events from the external source.
   * Rate limit errors throw and Temporal retries with backoff.
   */
  async function collectFromSource(
    input: CollectFromSourceInput
  ): Promise<CollectFromSourceOutput> {
    const { source, streams, cursorValue, periodStart, periodEnd } = input;
    logger.info(
      { source, streams, hasCursor: !!cursorValue },
      "Collecting from source"
    );

    const registration = sourceRegistrations.get(source);
    if (!registration?.poll) {
      throw new Error(
        `[SOURCE_NO_ADAPTER] No poll adapter registered for source "${source}" — check env vars (GH_REVIEW_APP_ID, GH_REVIEW_APP_PRIVATE_KEY_BASE64, GH_REPOS)`
      );
    }

    const result = await registration.poll.collect({
      streams,
      cursor: cursorValue
        ? {
            streamId: streams[0] ?? source,
            value: cursorValue,
            retrievedAt: new Date(),
          }
        : null,
      window: { since: new Date(periodStart), until: new Date(periodEnd) },
    });

    logger.info(
      {
        source,
        eventCount: result.events.length,
        nextCursor: result.nextCursor.value,
      },
      "Collection complete"
    );

    return {
      events: result.events as ActivityEvent[],
      nextCursorValue: result.nextCursor.value,
      nextCursorStreamId: result.nextCursor.streamId,
      producerVersion: registration.version,
    };
  }

  /**
   * Stores receipts via attributionStore. Idempotent via onConflictDoNothing on PK.
   */
  async function insertReceipts(input: InsertReceiptsInput): Promise<void> {
    const { events, producerVersion } = input;
    if (events.length === 0) return;

    logger.info({ count: events.length }, "Inserting ingestion receipts");

    await attributionStore.insertIngestionReceipts(
      events.map((e) => ({
        receiptId: e.id,
        nodeId,
        source: e.source,
        eventType: e.eventType,
        platformUserId: e.platformUserId,
        platformLogin: e.platformLogin ?? null,
        artifactUrl: e.artifactUrl ?? null,
        metadata: e.metadata ?? null,
        payloadHash: e.payloadHash,
        producer: e.source,
        producerVersion,
        // eventTime crosses Temporal serialization boundary as ISO string, not Date
        eventTime: new Date(e.eventTime),
        retrievedAt: new Date(),
      }))
    );

    logger.info({ count: events.length }, "Receipts inserted");
  }

  /**
   * Upserts cursor with monotonic advancement — never goes backwards.
   * cursor = max(existing, new) ensures crash-restart safety.
   */
  async function saveCursor(input: SaveCursorInput): Promise<void> {
    const { source, stream, sourceRef, cursorValue } = input;
    logger.info({ source, stream, cursorValue }, "Saving cursor");

    // Load existing to enforce monotonic advancement
    const existing = await attributionStore.getCursor(
      nodeId,
      scopeId,
      source,
      stream,
      sourceRef
    );

    // Lexicographic comparison works for ISO-8601 timestamps (all cursor values are ISO dates).
    // If cursor format changes (e.g., opaque pagination tokens), this comparison must be updated.
    const effectiveValue =
      existing && existing.cursorValue > cursorValue
        ? existing.cursorValue
        : cursorValue;

    await attributionStore.upsertCursor(
      nodeId,
      scopeId,
      source,
      stream,
      sourceRef,
      effectiveValue
    );

    logger.info(
      { source, stream, cursorValue: effectiveValue },
      "Cursor saved"
    );
  }

  /**
   * Materializes selection rows and resolves platform identities for an epoch.
   *
   * Delegates inclusion decisions to the selection policy from the pipeline profile.
   * Two-phase writes: INSERT new selection rows, UPDATE userId on existing unresolved rows.
   * SELECTION_AUTO_POPULATE: never overwrites admin-set included/weight_override_milli/note.
   * IDENTITY_BEST_EFFORT: unresolved receipts get userId=null, never dropped.
   */
  async function materializeSelection(
    input: MaterializeSelectionInput
  ): Promise<MaterializeSelectionOutput> {
    const epochId = BigInt(input.epochId);

    // 1. Resolve selection policy from the pipeline profile
    const profile = resolveProfile(
      registries.profiles,
      input.attributionPipeline
    );

    // 2. Load epoch → get period dates
    const epoch = await attributionStore.getEpoch(epochId);
    if (!epoch) {
      throw new Error(`materializeSelection: epoch ${input.epochId} not found`);
    }

    // 3. Get selection candidates (delta: only receipts needing work)
    const unselected: UnselectedReceipt[] =
      await attributionStore.getSelectionCandidates(nodeId, epochId);

    if (unselected.length === 0) {
      logger.info(
        { epochId: input.epochId },
        "No unselected receipts — skipping"
      );
      return { totalReceipts: 0, newSelections: 0, resolved: 0, unresolved: 0 };
    }

    // 4. Load all receipts for cross-referencing (full history for cross-epoch promotion matching)
    const allReceipts = await attributionStore.getAllReceipts(nodeId);
    const receiptsToSelect = unselected.map((u) => u.receipt);
    const decisions = dispatchSelectionPolicy(
      registries.selectionPolicies,
      profile.selectionPolicyRef,
      { receiptsToSelect, allReceipts }
    );
    const inclusionMap = new Map(
      decisions.map((d) => [d.receiptId, d.included])
    );

    logger.info(
      {
        epochId: input.epochId,
        policyRef: profile.selectionPolicyRef,
        included: decisions.filter((d) => d.included).length,
        excluded: decisions.filter((d) => !d.included).length,
      },
      "Selection policy applied"
    );

    // 5. Collect unique platformUserIds by source for identity resolution
    const idsBySource = new Map<"github", Set<string>>();
    for (const { receipt } of unselected) {
      if (receipt.source !== "github") {
        continue;
      }
      const ids = idsBySource.get(receipt.source) ?? new Set();
      ids.add(receipt.platformUserId);
      idsBySource.set(receipt.source, ids);
    }

    // 6. Batch resolve identities per source
    const resolvedMap = new Map<string, string>();
    for (const [source, ids] of idsBySource) {
      const result = await attributionStore.resolveIdentities(source, [...ids]);
      for (const [extId, userId] of result) {
        resolvedMap.set(extId, userId);
      }
    }

    // 7. Write selection rows and claimants
    let newSelections = 0;
    let resolved = 0;
    let unresolved = 0;

    for (const { receipt, hasExistingSelection } of unselected) {
      const resolvedUserId = resolvedMap.get(receipt.platformUserId) ?? null;
      const included = inclusionMap.get(receipt.receiptId) ?? false;

      if (!hasExistingSelection) {
        await attributionStore.insertSelectionDoNothing([
          {
            nodeId,
            epochId,
            receiptId: receipt.receiptId,
            userId: resolvedUserId,
            included,
          },
        ]);
        newSelections++;
      } else {
        // Existing rows re-sync the policy-owned `included` flag each pass
        // (idempotency); admin-owned weight/note are preserved.
        await attributionStore.updateSelectionIncluded(
          epochId,
          receipt.receiptId,
          included
        );
        if (resolvedUserId) {
          await attributionStore.updateSelectionUserId(
            epochId,
            receipt.receiptId,
            resolvedUserId
          );
        }
      }

      if (resolvedUserId) {
        resolved++;
      } else {
        unresolved++;
      }

      // Write default-author claimant only for included receipts
      if (included) {
        const ck = resolvedUserId
          ? `user:${resolvedUserId}`
          : `identity:${receipt.source}:${receipt.platformUserId}`;
        const claimantInputsHash = await sha256OfCanonicalJson({
          receiptId: receipt.receiptId,
          userId: resolvedUserId,
          platformUserId: receipt.platformUserId,
        });
        await attributionStore.upsertDraftClaimants({
          nodeId,
          epochId,
          receiptId: receipt.receiptId,
          resolverRef: "cogni.default-author.v0",
          algoRef: "default-author-v0",
          inputsHash: claimantInputsHash,
          claimantKeys: [ck],
          createdBy: "system",
        });
      }
    }

    logger.info(
      {
        epochId: input.epochId,
        totalReceipts: unselected.length,
        newSelections,
        resolved,
        unresolved,
      },
      "Selection materialization and identity resolution complete"
    );

    return {
      totalReceipts: unselected.length,
      newSelections,
      resolved,
      unresolved,
    };
  }

  /**
   * Compute receipt-weight allocations and aggregate into user projections.
   * Uses profile-driven allocator dispatch for per-receipt output.
   * Upserts user projections (recomputable, unsigned) and removes stale ones.
   */
  async function computeAllocations(
    input: ComputeAllocationsInput
  ): Promise<ComputeAllocationsOutput> {
    const epochId = BigInt(input.epochId);
    const { attributionPipeline, weightConfig } = input;
    const profile = resolveProfile(registries.profiles, attributionPipeline);

    logger.info(
      { epochId: input.epochId, allocatorRef: profile.allocatorRef },
      "Computing allocations"
    );

    // 1. Load selected receipts (resolved users only)
    const receipts =
      await attributionStore.getSelectedReceiptsForAllocation(epochId);

    if (receipts.length === 0) {
      logger.info(
        { epochId: input.epochId },
        "No selected receipts — skipping"
      );
      return { totalAllocations: 0, totalProposedUnits: "0" };
    }

    // 2. Compute per-receipt weights (pure)
    const evaluations = toEvaluationPayloadMap(
      await attributionStore.getEvaluationsForEpoch(epochId, "draft")
    );
    const receiptWeights = await dispatchAllocator(
      registries.allocators,
      profile.allocatorRef,
      {
        receipts,
        weightConfig,
        evaluations,
        profileConfig: null,
      }
    );

    // 3. Aggregate into user projections for the review UI
    //    Group by userId from selection rows (existing pattern for projections)
    const weightByReceipt = new Map(
      receiptWeights.map((w) => [w.receiptId, w])
    );
    const userUnits = new Map<string, { units: bigint; count: number }>();
    for (const receipt of receipts) {
      if (!receipt.included) continue;
      if (!receipt.userId) continue;
      const weight = weightByReceipt.get(receipt.receiptId);
      if (!weight) continue;
      const existing = userUnits.get(receipt.userId) ?? {
        units: 0n,
        count: 0,
      };
      existing.units += weight.units;
      existing.count += 1;
      userUnits.set(receipt.userId, existing);
    }

    const projections = [...userUnits.entries()].map(
      ([userId, { units, count }]) => ({
        nodeId,
        epochId,
        userId,
        projectedUnits: units,
        receiptCount: count,
      })
    );

    const totalProposedUnits = receiptWeights.reduce(
      (acc, w) => acc + w.units,
      0n
    );

    // 4. Check if projections have actually changed before writing.
    // Avoids unnecessary DB writes when the same daily run produces identical results.
    const existingProjections =
      await attributionStore.getUserProjectionsForEpoch(epochId);
    const existingMap = new Map(
      existingProjections.map((p) => [
        p.userId,
        { units: p.projectedUnits, count: p.receiptCount },
      ])
    );

    const projectionsChanged =
      projections.length !== existingMap.size ||
      projections.some((p) => {
        const existing = existingMap.get(p.userId);
        return (
          !existing ||
          existing.units !== p.projectedUnits ||
          existing.count !== p.receiptCount
        );
      });

    if (!projectionsChanged) {
      logger.info(
        {
          epochId: input.epochId,
          totalAllocations: receiptWeights.length,
          totalProposedUnits: totalProposedUnits.toString(),
        },
        "Projections unchanged — skipping writes"
      );
      return {
        totalAllocations: receiptWeights.length,
        totalProposedUnits: totalProposedUnits.toString(),
      };
    }

    // 5. Upsert user projections (recomputable, unsigned)
    if (projections.length > 0) {
      await attributionStore.upsertUserProjections(projections);
      const activeUserIds = projections.map((p) => p.userId);
      await attributionStore.deleteStaleUserProjections(epochId, activeUserIds);
    }

    logger.info(
      {
        epochId: input.epochId,
        totalAllocations: receiptWeights.length,
        totalProposedUnits: totalProposedUnits.toString(),
      },
      "Allocations computed"
    );

    return {
      totalAllocations: receiptWeights.length,
      totalProposedUnits: totalProposedUnits.toString(),
    };
  }

  /**
   * Ensure pool components exist for an epoch. Idempotent via POOL_UNIQUE_PER_TYPE.
   * Only inserts when epoch is open (POOL_LOCKED_AT_REVIEW enforced by adapter).
   */
  async function ensurePoolComponents(
    input: EnsurePoolComponentsInput
  ): Promise<EnsurePoolComponentsOutput> {
    const epochId = BigInt(input.epochId);
    const baseIssuanceCredits = BigInt(input.baseIssuanceCredits);

    logger.info(
      {
        epochId: input.epochId,
        baseIssuanceCredits: input.baseIssuanceCredits,
      },
      "Ensuring pool components"
    );

    // Check epoch is open before attempting inserts
    const epoch = await attributionStore.getEpoch(epochId);
    if (!epoch) {
      throw new Error(`ensurePoolComponents: epoch ${input.epochId} not found`);
    }
    if (epoch.status !== "open") {
      logger.info(
        { epochId: input.epochId, status: epoch.status },
        "Epoch not open — skipping pool component insert"
      );
      return { componentsEnsured: 0 };
    }

    const estimates = estimatePoolComponentsV0({ baseIssuanceCredits });
    let ensured = 0;

    for (const estimate of estimates) {
      // insertPoolComponent is idempotent (ON CONFLICT DO NOTHING + SELECT)
      const { created } = await attributionStore.insertPoolComponent({
        nodeId,
        epochId,
        componentId: estimate.componentId,
        algorithmVersion: estimate.algorithmVersion,
        inputsJson: estimate.inputsJson,
        amountCredits: estimate.amountCredits,
        evidenceRef: estimate.evidenceRef,
      });
      if (created) {
        ensured++;
      } else {
        logger.info(
          { componentId: estimate.componentId },
          "Pool component already exists — skipping"
        );
      }
    }

    logger.info(
      { epochId: input.epochId, componentsEnsured: ensured },
      "Pool components ensured"
    );

    return { componentsEnsured: ensured };
  }

  /**
   * Detect a stale open epoch that would block creation of a new epoch for the given window.
   * Returns stale epoch info (serialized for Temporal wire) or null if no stale epoch exists.
   */
  async function findStaleOpenEpoch(
    input: FindStaleOpenEpochInput
  ): Promise<FindStaleOpenEpochOutput> {
    const openEpoch = await attributionStore.getOpenEpoch(nodeId, scopeId);
    if (!openEpoch) {
      return { staleEpoch: null };
    }

    // Same window → not stale (rerun within current epoch period)
    if (
      openEpoch.periodStart.toISOString() ===
        new Date(input.periodStart).toISOString() &&
      openEpoch.periodEnd.toISOString() ===
        new Date(input.periodEnd).toISOString()
    ) {
      return { staleEpoch: null };
    }

    logger.info(
      {
        staleEpochId: openEpoch.id.toString(),
        staleWindow: `${openEpoch.periodStart.toISOString()}..${openEpoch.periodEnd.toISOString()}`,
        newWindow: `${input.periodStart}..${input.periodEnd}`,
      },
      "Found stale open epoch blocking new window"
    );

    return {
      staleEpoch: {
        epochId: openEpoch.id.toString(),
        weightConfig: openEpoch.weightConfig,
        periodStart: openEpoch.periodStart.toISOString(),
        periodEnd: openEpoch.periodEnd.toISOString(),
      },
    };
  }

  /**
   * Atomic epoch transition: close stale open epoch (if any) + get-or-create epoch for the given window.
   * Single DB transaction — no race window between close and create.
   * Computes config hashes internally (crypto not safe in Temporal workflow code).
   * Locks claimant rows for stale epoch before transition.
   */
  async function transitionEpochForWindow(
    input: TransitionEpochForWindowInput
  ): Promise<TransitionEpochForWindowOutput> {
    const { closeParams: inputClose } = input;

    // Lock claimants for stale epoch before the atomic transition
    const staleEpochId = BigInt(inputClose.staleEpochId);
    const lockedCount =
      await attributionStore.lockClaimantsForEpoch(staleEpochId);
    logger.info(
      {
        staleEpochId: inputClose.staleEpochId,
        lockedClaimants: lockedCount,
      },
      "Claimant rows locked for stale epoch"
    );

    // Compute hashes from raw values (crypto happens here, not in workflow)
    validateWeightConfig(inputClose.staleWeightConfig);
    const weightConfigHash = await computeWeightConfigHash(
      inputClose.staleWeightConfig
    );
    const approverSetHash = await computeApproverSetHash(inputClose.approvers);
    const profile = resolveProfile(
      registries.profiles,
      inputClose.attributionPipeline
    );
    const allocationAlgoRef = profile.allocatorRef;

    logger.info(
      {
        staleEpochId: inputClose.staleEpochId,
        allocationAlgoRef,
        weightConfigHash: `${weightConfigHash.slice(0, 12)}...`,
        evaluationCount: inputClose.evaluations.length,
      },
      "Closing stale epoch during transition"
    );

    const closeParams: CloseIngestionWithEvaluationsParams = {
      epochId: staleEpochId,
      approvers: inputClose.approvers,
      approverSetHash,
      allocationAlgoRef,
      weightConfigHash,
      evaluations: inputClose.evaluations.map((e) => ({
        ...e,
        epochId: BigInt(e.epochId),
      })),
      artifactsHash: inputClose.artifactsHash,
    };

    const result = await attributionStore.transitionEpochForWindow({
      nodeId,
      scopeId,
      periodStart: new Date(input.periodStart),
      periodEnd: new Date(input.periodEnd),
      weightConfig: input.weightConfig,
      closeParams,
    });

    logger.info(
      {
        closedStaleEpochId: result.closedStaleEpochId.toString(),
        newEpochId: result.epoch.id.toString(),
      },
      "Epoch transition complete — stale epoch closed, new epoch created"
    );

    return {
      epochId: result.epoch.id.toString(),
      status: result.epoch.status,
      isNew: result.isNew,
      weightConfig: result.epoch.weightConfig,
      closedStaleEpochId: result.closedStaleEpochId.toString(),
    };
  }

  /**
   * Compound activity: atomically finalize an epoch with signature verification.
  /**
   * Resolve stream IDs for a source by querying the adapter's self-declared streams.
   */
  async function resolveStreams(
    input: ResolveStreamsInput
  ): Promise<ResolveStreamsOutput> {
    const registration = sourceRegistrations.get(input.source);
    if (!registration?.poll) {
      // No poll adapter for this source. The common case is a webhook-only source
      // (e.g. github: receipts arrive via the operator's GitHub App webhook receiver,
      // and the scheduler-worker holds no GH App key by design). Skip the poll plane
      // gracefully — returning no streams means CollectSources contributes nothing for
      // this source and the epoch proceeds to SELECT the webhook-deposited receipts.
      //
      // This is NOT silent: bootstrap cross-checks repo-spec activity_sources against
      // registered adapters and logs CONFIG_SOURCE_NO_ADAPTER at error level for true
      // coverage gaps. Reverts the fatal-throw regression from #519, which made a
      // missing poll adapter kill CollectEpoch before selection ever ran.
      logger.warn(
        { source: input.source, event: "attribution.poll_skipped_no_adapter" },
        `No poll adapter for source "${input.source}" — skipping poll (webhook-only ingestion, or a coverage gap flagged at bootstrap as CONFIG_SOURCE_NO_ADAPTER)`
      );
      return { streams: [] };
    }
    const streams = registration.poll.streams().map((s) => s.id);
    logger.info(
      { source: input.source, streams },
      "Resolved streams from adapter"
    );
    return { streams };
  }

  return {
    ensureEpochForWindow,
    loadCursor,
    collectFromSource,
    insertReceipts,
    saveCursor,
    materializeSelection,
    computeAllocations,
    ensurePoolComponents,
    findStaleOpenEpoch,
    transitionEpochForWindow,
    resolveStreams,
  };
}

/** Type alias for workflow proxy usage */
export type LedgerActivities = ReturnType<typeof createAttributionActivities>;
