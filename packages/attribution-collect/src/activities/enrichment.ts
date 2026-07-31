// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-collect/activities/enrichment`
 * Purpose: Temporal Activities for epoch enrichment — draft evaluation creation and final evaluation building.
 * Scope: Profile-driven enricher dispatch via @cogni/attribution-pipeline-plugins registries; does not contain enricher logic itself.
 * Invariants:
 * - ENRICHER_IDEMPOTENT: Same receipts → same hashes → same evaluation.
 * - ENRICHER_SKIP_UNCHANGED: evaluateEpochDraft pre-computes inputsHash and skips adapter call if existing draft matches (saves LLM tokens for future AI enrichers).
 * - ENRICHER_DRAFT_ONLY: evaluateEpochDraft writes status='draft' only; buildLockedEvaluations returns data without writing.
 * - PROFILE_DISPATCH: enrichers run in profile.enricherRefs order, resolved via attributionPipeline.
 * Side-effects: IO (database via attributionStore)
 * Links: work/items/task.0113.epoch-artifact-pipeline.md, docs/spec/plugin-attribution-pipeline.md
 * @internal
 */

import {
  type AttributionStore,
  computeArtifactsHash,
  computeEnricherInputsHash,
} from "@cogni/attribution-ledger";
import {
  type EnricherContext,
  resolveProfile,
  validateEvaluationWrite,
} from "@cogni/attribution-pipeline-contracts";
import type { DefaultRegistries } from "@cogni/attribution-pipeline-plugins";

import type { Logger } from "pino";

/**
 * Dependencies injected into enrichment activities.
 */
export interface EnrichmentActivityDeps {
  readonly attributionStore: AttributionStore;
  readonly nodeId: string;
  readonly logger: Logger;
  readonly registries: DefaultRegistries;
}

/**
 * Input for deriveWeightConfig activity.
 */
export interface DeriveWeightConfigInput {
  readonly attributionPipeline: string;
}

/**
 * Output from deriveWeightConfig activity.
 */
export interface DeriveWeightConfigOutput {
  readonly weightConfig: Record<string, number>;
}

/**
 * Input for evaluateEpochDraft activity.
 */
export interface EvaluateEpochDraftInput {
  readonly epochId: string; // bigint serialized as string for Temporal
  readonly attributionPipeline: string;
}

/**
 * Output from evaluateEpochDraft activity.
 */
export interface EvaluateEpochDraftOutput {
  readonly evaluationRefs: string[];
  readonly receiptCount: number;
}

/**
 * Input for buildLockedEvaluations activity.
 */
export interface BuildLockedEvaluationsInput {
  readonly epochId: string; // bigint serialized as string for Temporal
  readonly attributionPipeline: string;
}

/**
 * Evaluation params serialized for Temporal wire format.
 * All bigint fields represented as decimal strings — Temporal serializes
 * activity args/returns as JSON, and JSON.stringify(bigint) throws.
 * Inside activities, convert back: BigInt(epochId).
 */
export interface UpsertEvaluationParamsWire {
  readonly nodeId: string;
  readonly epochId: string; // bigint as decimal string
  readonly evaluationRef: string;
  readonly status: "draft" | "locked";
  readonly algoRef: string;
  readonly schemaRef?: string;
  readonly inputsHash: string;
  readonly payloadHash: string;
  readonly payloadJson: Record<string, unknown>;
}

/**
 * Output from buildLockedEvaluations activity.
 */
export interface BuildLockedEvaluationsOutput {
  readonly evaluations: UpsertEvaluationParamsWire[];
  readonly artifactsHash: string;
}

/**
 * Creates enrichment activity functions with injected dependencies.
 */
export function createEnrichmentActivities(deps: EnrichmentActivityDeps) {
  const { attributionStore, nodeId, logger, registries } = deps;

  /**
   * Derive weight config from the pipeline profile.
   * Returns the profile's defaultWeightConfig, or empty map if not set.
   */
  async function deriveWeightConfig(
    input: DeriveWeightConfigInput
  ): Promise<DeriveWeightConfigOutput> {
    const profile = resolveProfile(
      registries.profiles,
      input.attributionPipeline
    );
    const weightConfig = profile.defaultWeightConfig
      ? { ...profile.defaultWeightConfig }
      : {};
    logger.info(
      { profileId: profile.profileId, weightKeys: Object.keys(weightConfig) },
      "Derived weight config from profile"
    );
    return { weightConfig };
  }

  /**
   * Evaluate epoch with draft evaluations for all enrichers in the profile.
   * Writes status='draft' via upsertDraftEvaluation (overwrites on each pass).
   */
  async function evaluateEpochDraft(
    input: EvaluateEpochDraftInput
  ): Promise<EvaluateEpochDraftOutput> {
    const epochId = BigInt(input.epochId);
    const profile = resolveProfile(
      registries.profiles,
      input.attributionPipeline
    );

    logger.info(
      { epochId: input.epochId, profileId: profile.profileId },
      "Evaluating epoch draft"
    );

    const epoch = await attributionStore.getEpoch(epochId);
    if (!epoch) {
      throw new Error(`evaluateEpochDraft: epoch ${input.epochId} not found`);
    }

    // Pre-load receipts once for inputsHash check (cheap DB read).
    // This avoids calling enricher adapters (potentially LLM-backed) when inputs haven't changed.
    const receipts =
      await attributionStore.getSelectedReceiptsWithMetadata(epochId);

    const candidateInputsHash = await computeEnricherInputsHash({
      epochId,
      receipts: receipts.map((r) => ({
        receiptId: r.receiptId,
        receiptPayloadHash: r.payloadHash,
      })),
    });

    const evaluationRefs: string[] = [];
    let skippedCount = 0;

    for (const ref of profile.enricherRefs) {
      const adapter = registries.enrichers.get(ref.enricherRef);
      if (!adapter) {
        throw new Error(`Enricher adapter not found: ${ref.enricherRef}`);
      }

      // Check if existing draft evaluation already matches current inputs.
      const existing = await attributionStore.getEvaluation(
        epochId,
        adapter.descriptor.evaluationRef,
        "draft"
      );
      if (existing && existing.inputsHash === candidateInputsHash) {
        logger.info(
          {
            epochId: input.epochId,
            evaluationRef: adapter.descriptor.evaluationRef,
            inputsHash: `${candidateInputsHash.slice(0, 12)}...`,
          },
          "Draft evaluation unchanged — skipping enricher"
        );
        evaluationRefs.push(adapter.descriptor.evaluationRef);
        skippedCount++;
        continue;
      }

      const ctx: EnricherContext = {
        epochId,
        nodeId,
        attributionStore,
        logger,
        profileConfig: null,
      };

      const result = await adapter.evaluateDraft(ctx);
      validateEvaluationWrite(adapter.descriptor, result);

      await attributionStore.upsertDraftEvaluation({
        nodeId: result.nodeId,
        epochId: result.epochId,
        evaluationRef: result.evaluationRef,
        status: result.status,
        algoRef: result.algoRef,
        inputsHash: result.inputsHash,
        payloadHash: result.payloadHash,
        payloadJson: result.payloadJson,
      });

      evaluationRefs.push(result.evaluationRef);
    }

    logger.info(
      {
        epochId: input.epochId,
        evaluationRefs,
        receiptCount: receipts.length,
        skippedCount,
      },
      skippedCount === evaluationRefs.length
        ? "All draft evaluations unchanged — nothing to recompute"
        : "Draft evaluations written"
    );

    return {
      evaluationRefs,
      receiptCount: receipts.length,
    };
  }

  /**
   * Build final (locked) evaluations for epoch close.
   * Returns evaluation params and artifactsHash — does NOT write to store.
   * The caller (autoCloseIngestion) writes via closeIngestionWithEvaluations atomically.
   */
  async function buildLockedEvaluations(
    input: BuildLockedEvaluationsInput
  ): Promise<BuildLockedEvaluationsOutput> {
    const epochId = BigInt(input.epochId);
    const profile = resolveProfile(
      registries.profiles,
      input.attributionPipeline
    );

    logger.info(
      { epochId: input.epochId, profileId: profile.profileId },
      "Building locked evaluations"
    );

    const epoch = await attributionStore.getEpoch(epochId);
    if (!epoch) {
      throw new Error(
        `buildLockedEvaluations: epoch ${input.epochId} not found`
      );
    }

    const evaluations: UpsertEvaluationParamsWire[] = [];

    for (const ref of profile.enricherRefs) {
      const adapter = registries.enrichers.get(ref.enricherRef);
      if (!adapter) {
        throw new Error(`Enricher adapter not found: ${ref.enricherRef}`);
      }

      const ctx: EnricherContext = {
        epochId,
        nodeId,
        attributionStore,
        logger,
        profileConfig: null,
      };

      const result = await adapter.buildLocked(ctx);
      validateEvaluationWrite(adapter.descriptor, result);

      evaluations.push({
        nodeId: result.nodeId,
        epochId: input.epochId, // keep as string for Temporal wire format
        evaluationRef: result.evaluationRef,
        status: "locked",
        algoRef: result.algoRef,
        schemaRef: result.schemaRef,
        inputsHash: result.inputsHash,
        payloadHash: result.payloadHash,
        payloadJson: result.payloadJson,
      });
    }

    const artifactsHash = await computeArtifactsHash(evaluations);

    logger.info(
      {
        epochId: input.epochId,
        evaluationCount: evaluations.length,
        artifactsHash: `${artifactsHash.slice(0, 12)}...`,
      },
      "Locked evaluations built"
    );

    return {
      evaluations,
      artifactsHash,
    };
  }

  return {
    deriveWeightConfig,
    evaluateEpochDraft,
    buildLockedEvaluations,
  };
}

/** Type alias for workflow proxy usage. */
export type EnrichmentActivities = ReturnType<
  typeof createEnrichmentActivities
>;
