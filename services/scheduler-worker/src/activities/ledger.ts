// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/activities/ledger`
 * Purpose: Temporal Activities for the full ledger pipeline — ingestion, selection, allocation, pool, epoch transition, and finalization.
 * Scope: Plain async functions that perform I/O (DB, GitHub API, EIP-712 verification). Called by CollectEpochWorkflow and FinalizeEpochWorkflow. Does not contain deterministic orchestration logic.
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
 *   - Per EPOCH_FINALIZE_IDEMPOTENT: finalizeEpoch returns existing statement if already finalized
 *   - Per FINALIZE_CLAIMANT_AWARE: finalizeEpoch loads locked claimant rows from epoch_receipt_claimants, dispatches the pinned allocator, explodes to claimant allocations, and stores claimant metadata in attribution statement lines
 *   - Per FINALIZE_BUILDS_CUMULATIVE_ROOT (R3): on a successful finalize, finalizeEpoch resolves this epoch's claimant deltas to wallets, folds them onto the prior persisted cumulative manifest, and persists the new cumulative merkle root + per-epoch mint delta. The admin's SINGLE finalize signature drives this — there is no second signing flow. The DAO.mint(delta) + distributor.setMerkleRoot(root) transaction is BUILT from the persisted cumulative manifest (root + delta + distributorAddress); this activity never sends an on-chain tx.
 * Side-effects: IO (database, GitHub API, viem EIP-712 verification)
 * Links: docs/spec/attribution-ledger.md, docs/spec/temporal-patterns.md, packages/aragon-osx/src/epoch-distribution-service.ts
 * @internal
 */

import {
  buildCumulativeEpochDistribution,
  type ClaimantWalletResolver,
  type FinalizedEpochStatement,
  type HexAddress,
  type PriorCumulativeBalance,
} from "@cogni/aragon-osx";
import type {
  CloseIngestionWithEvaluationsParams,
  UnselectedReceipt,
} from "@cogni/attribution-ledger";
import {
  applyReceiptWeightOverrides,
  buildEIP712TypedData,
  buildReceiptWeightOverrideSnapshots,
  claimantKey,
  computeApproverSetHash,
  computeAttributionStatementLines,
  computeFinalClaimantAllocationSetHash,
  computeWeightConfigHash,
  estimatePoolComponentsV0,
  explodeToClaimants,
  sha256OfCanonicalJson,
  toReviewSubjectOverrides,
  validateWeightConfig,
} from "@cogni/attribution-ledger";
import {
  dispatchAllocator,
  dispatchSelectionPolicy,
  resolveProfile,
} from "@cogni/attribution-pipeline-contracts";
import type { DefaultRegistries } from "@cogni/attribution-pipeline-plugins";
import type { ActivityEvent } from "@cogni/ingestion-core";

import { verifyTypedData } from "viem";

import type { Logger } from "../observability/logger.js";
import type {
  AttributionStore,
  DataSourceRegistration,
} from "../ports/index.js";

/**
 * 18-decimal base-unit scale for the GovernanceERC20. The per-epoch mint delta
 * maps 1 signed credit → 1 whole token (× 10^18 base units), matching the V0
 * Walk mapping previously in features/governance/publish-epoch/build-distribution.
 */
const TOKEN_BASE_UNITS = 10n ** 18n;

/**
 * Dependencies injected into ledger activities at worker creation.
 */
export interface AttributionActivityDeps {
  readonly attributionStore: AttributionStore;
  readonly sourceRegistrations: ReadonlyMap<string, DataSourceRegistration>;
  readonly registries: DefaultRegistries;
  readonly nodeId: string;
  readonly scopeId: string;
  readonly chainId: number;
  /**
   * The DAO's GovernanceERC20 token address (settlement token). Read from
   * repo-spec at bootstrap. Required to build the cumulative distribution
   * manifest at finalize; null until the node activates distributions.
   */
  readonly tokenAddress: string | null;
  /**
   * The ONE per-node cumulative distributor recorded in repo-spec at R2
   * activation. Terminal fallback for distributor resolution at finalize: the
   * FIRST epoch has no prior/current manifest, so this repo-spec-sourced address
   * is what makes the first manifest carry a distributor. Null until R2 records
   * it (off-chain finalize still runs).
   */
  readonly distributorAddress: string | null;
  /**
   * Read-only resolver: attribution claimant key → contributor wallet. Used at
   * finalize to map this epoch's claimant credit lines onto EVM wallets for the
   * cumulative root. Null disables cumulative-root building (off-chain ledger
   * still finalizes).
   */
  readonly walletResolver: ClaimantWalletResolver | null;
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
 * Input for finalizeEpoch compound activity.
 */
export interface FinalizeEpochInput {
  readonly epochId: string; // bigint serialized
  readonly signature: string; // EIP-712 hex
  readonly signerAddress: string; // from SIWE session
}

/**
 * Output from finalizeEpoch compound activity.
 */
export interface FinalizeEpochOutput {
  readonly statementId: string;
  readonly poolTotalCredits: string; // bigint serialized
  readonly finalAllocationSetHash: string;
  readonly statementLineCount: number;
  /**
   * Cumulative distribution produced by the SAME finalize signature (R3).
   * Null when distributions are not activated (no tokenAddress/resolver) or no
   * wallet-resolved cumulative balance remains. When present, the per-epoch
   * on-chain action is: DAO.mint(mintDelta) into the existing distributor +
   * distributor.setMerkleRoot(merkleRoot). This activity BUILDS, never sends it.
   */
  readonly cumulativeDistribution: {
    readonly distributionId: string;
    readonly merkleRoot: string;
    readonly mintDelta: string; // bigint serialized — DAO mints exactly this
    readonly cumulativeTotal: string; // bigint serialized — total supply to date
    readonly leafCount: number;
    readonly tokenAddress: string;
    readonly chainId: number;
    /** Existing per-node distributor (null until R2 activation records it). */
    readonly distributorAddress: string | null;
  } | null;
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
    chainId,
    tokenAddress,
    distributorAddress: repoSpecDistributorAddress,
    walletResolver,
    logger,
  } = deps;

  /**
   * R3 — build + persist the cumulative distribution from a just-finalized epoch.
   *
   * Resolves this epoch's claimant credit lines to wallets, folds them onto the
   * prior persisted cumulative manifest (the most-recent finalized epoch's leaves
   * already carry per-account cumulative balances), and persists the new
   * cumulative merkle root + per-epoch mint delta. Returns the manifest summary
   * the finalize output exposes so callers can BUILD the
   * DAO.mint(delta)+setMerkleRoot(root) transaction. Never sends an on-chain tx.
   *
   * No-ops (returns null) when distributions are not activated (no tokenAddress
   * or resolver) or no wallet-resolved cumulative balance remains — the
   * off-chain ledger finalize already succeeded and must not be undone.
   */
  async function buildAndPersistCumulativeDistribution(args: {
    readonly epochId: bigint;
    readonly statementId: string;
    readonly finalAllocationSetHash: string;
    readonly statementLines: ReadonlyArray<{
      readonly claimant_key: string;
      readonly credit_amount: string;
      readonly receipt_ids: readonly string[];
    }>;
  }): Promise<FinalizeEpochOutput["cumulativeDistribution"]> {
    if (!tokenAddress || !walletResolver) {
      logger.info(
        { epochId: args.epochId.toString() },
        "Cumulative distribution skipped — distributions not activated (no tokenAddress/walletResolver)"
      );
      return null;
    }

    // Prior cumulative balances = the most-recent persisted cumulative manifest's
    // per-account leaf amounts (each cumulative leaf carries the account's
    // cumulative-to-date). We find the highest epoch id BEFORE this one that has a
    // persisted manifest. No new store method: enumerate epochs and read manifests.
    const allEpochs = await attributionStore.listEpochs(nodeId);
    const priorEpochIds = allEpochs
      .map((e) => e.id)
      .filter((id) => id < args.epochId)
      .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)); // descending

    let priorManifest: Awaited<
      ReturnType<typeof attributionStore.getDistributionManifestForEpoch>
    > = null;
    let priorLeaves: Awaited<
      ReturnType<typeof attributionStore.getDistributionLeavesForEpoch>
    > = [];
    for (const priorEpochId of priorEpochIds) {
      const manifest =
        await attributionStore.getDistributionManifestForEpoch(priorEpochId);
      if (manifest) {
        priorManifest = manifest;
        priorLeaves =
          await attributionStore.getDistributionLeavesForEpoch(priorEpochId);
        break;
      }
    }

    const priorCumulative: PriorCumulativeBalance[] = priorLeaves.map(
      (leaf) => ({
        account: leaf.account as HexAddress,
        cumulativeAmount: leaf.amount,
      })
    );

    const distributorAddress =
      priorManifest?.distributorAddress ??
      (await attributionStore.getDistributionManifestForEpoch(args.epochId))
        ?.distributorAddress ??
      // R2↔R3 seam: the FIRST epoch has no prior/current manifest, so fall back to
      // the ONE per-node distributor R2 recorded in repo-spec at activation.
      repoSpecDistributorAddress ??
      null;

    // The per-epoch mint delta is THIS epoch's poolTotal in base units
    // (poolTotalCredits × 10^18), mapped 1 credit → 1 whole token.
    const poolTotalCredits = args.statementLines.reduce(
      (sum, line) => sum + BigInt(line.credit_amount),
      0n
    );
    const mintDelta = poolTotalCredits * TOKEN_BASE_UNITS;

    const finalized: FinalizedEpochStatement = {
      distributionId: `epoch-${args.epochId.toString()}`,
      nodeId,
      scopeId,
      statementHash: args.finalAllocationSetHash,
      chainId,
      tokenAddress: tokenAddress as HexAddress,
      lines: args.statementLines.map((line) => ({
        claimantKey: line.claimant_key,
        creditAmount: BigInt(line.credit_amount),
        receiptIds: line.receipt_ids,
      })),
    };

    if (mintDelta <= 0n && priorCumulative.length === 0) {
      logger.info(
        { epochId: args.epochId.toString() },
        "Cumulative distribution skipped — zero mint delta and no prior cumulative balance"
      );
      return null;
    }

    const { distribution, blockers, unresolvedClaimantKeys } =
      await buildCumulativeEpochDistribution(
        finalized,
        mintDelta,
        priorCumulative,
        walletResolver
      );

    if (!distribution) {
      logger.warn(
        {
          epochId: args.epochId.toString(),
          blockers: blockers.map((b) => b.code),
          unresolvedClaimantKeys,
        },
        "Cumulative distribution not built — no wallet-resolved cumulative balance"
      );
      return null;
    }

    // Persist the cumulative manifest (header + cumulative leaves). The
    // distributionAmount column holds the cumulative supply distributed to date;
    // totalAllocated holds the same (every leaf is wallet-backed). The
    // distributorAddress carries forward from the prior manifest (R2 records it).
    await attributionStore.upsertDistributionManifest({
      nodeId: distribution.nodeId,
      scopeId: distribution.scopeId,
      epochId: args.epochId,
      distributionId: distribution.distributionId,
      statementHash: distribution.statementHash,
      merkleRoot: distribution.merkleRoot,
      chainId: distribution.chainId,
      tokenAddress: distribution.tokenAddress,
      distributionAmount: distribution.cumulativeTotal,
      totalAllocated: distribution.cumulativeTotal,
      distributorAddress,
      leaves: distribution.leaves.map((leaf) => ({
        index: leaf.index,
        claimantKey: leaf.claimantKey,
        account: leaf.account,
        amount: leaf.cumulativeAmount,
        leafHash: leaf.leafHash,
        proof: [...leaf.proof],
      })),
    });

    logger.info(
      {
        epochId: args.epochId.toString(),
        merkleRoot: `${distribution.merkleRoot.slice(0, 12)}...`,
        mintDelta: distribution.mintDelta.toString(),
        cumulativeTotal: distribution.cumulativeTotal.toString(),
        leafCount: distribution.leaves.length,
        unresolvedClaimantKeys,
      },
      "Cumulative distribution built + persisted from finalize signature"
    );

    return {
      distributionId: distribution.distributionId,
      merkleRoot: distribution.merkleRoot,
      mintDelta: distribution.mintDelta.toString(),
      cumulativeTotal: distribution.cumulativeTotal.toString(),
      leafCount: distribution.leaves.length,
      tokenAddress: distribution.tokenAddress,
      chainId: distribution.chainId,
      distributorAddress,
    };
  }

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
   * EPOCH_FINALIZE_IDEMPOTENT: returns existing statement if already finalized.
   * CONFIG_LOCKED_AT_REVIEW: verifies allocation_algo_ref and weight_config_hash are set.
   */
  async function finalizeEpoch(
    input: FinalizeEpochInput
  ): Promise<FinalizeEpochOutput> {
    const epochId = BigInt(input.epochId);

    logger.info(
      { epochId: input.epochId, signerAddress: input.signerAddress },
      "Finalizing epoch"
    );

    // 1. Load epoch — verify exists and is review (or finalized for idempotency)
    const epoch = await attributionStore.getEpoch(epochId);
    if (!epoch) {
      throw new Error(`finalizeEpoch: epoch ${input.epochId} not found`);
    }

    // EPOCH_FINALIZE_IDEMPOTENT: already finalized → repair via atomic method
    if (epoch.status === "finalized") {
      logger.info(
        { epochId: input.epochId },
        "Epoch already finalized — repairing via finalizeEpochAtomic"
      );
      const existing = await attributionStore.getStatementForEpoch(epochId);
      if (!existing) {
        throw new Error(
          `finalizeEpoch: epoch ${input.epochId} is finalized but no statement found`
        );
      }

      // Repair: ensure this signer's signature exists via atomic method
      await attributionStore.finalizeEpochAtomic({
        epochId,
        poolTotal: existing.poolTotalCredits,
        finalClaimantAllocations: await attributionStore
          .getFinalClaimantAllocationsForEpoch(epochId)
          .then((allocations) =>
            allocations.map((allocation) => ({
              nodeId: allocation.nodeId,
              epochId: allocation.epochId,
              claimantKey: allocation.claimantKey,
              claimant: allocation.claimant,
              finalUnits: allocation.finalUnits,
              receiptIds: allocation.receiptIds,
            }))
          ),
        statement: {
          nodeId,
          finalAllocationSetHash: existing.finalAllocationSetHash,
          poolTotalCredits: existing.poolTotalCredits,
          statementLines: existing.statementLines,
        },
        signature: {
          nodeId,
          signerWallet: input.signerAddress,
          signature: input.signature,
          signedAt: new Date(),
        },
        expectedFinalAllocationSetHash: existing.finalAllocationSetHash,
      });

      // R3: re-build the cumulative manifest on repair too — heals a missing or
      // stale cumulative root from an earlier finalize that predated this path.
      let repairCumulative: FinalizeEpochOutput["cumulativeDistribution"] =
        null;
      try {
        repairCumulative = await buildAndPersistCumulativeDistribution({
          epochId,
          statementId: existing.id,
          finalAllocationSetHash: existing.finalAllocationSetHash,
          statementLines: existing.statementLines.map((line) => ({
            claimant_key: line.claimant_key,
            credit_amount: line.credit_amount,
            receipt_ids: [...line.receipt_ids],
          })),
        });
      } catch (err) {
        logger.error(
          {
            epochId: input.epochId,
            err: err instanceof Error ? err.message : String(err),
          },
          "Cumulative distribution repair failed — epoch stays finalized"
        );
      }

      return {
        statementId: existing.id,
        poolTotalCredits: existing.poolTotalCredits.toString(),
        finalAllocationSetHash: existing.finalAllocationSetHash,
        statementLineCount: existing.statementLines.length,
        cumulativeDistribution: repairCumulative,
      };
    }

    if (epoch.status !== "review") {
      throw new Error(
        `finalizeEpoch: epoch ${input.epochId} is '${epoch.status}', expected 'review'`
      );
    }

    // 2. CONFIG_LOCKED_AT_REVIEW: verify config is locked
    if (!epoch.allocationAlgoRef || !epoch.weightConfigHash) {
      throw new Error(
        `finalizeEpoch: epoch ${input.epochId} missing allocation_algo_ref or weight_config_hash (CONFIG_LOCKED_AT_REVIEW violated)`
      );
    }

    // 3. Verify signer is in pinned approvers (APPROVERS_PINNED_AT_REVIEW)
    if (!epoch.approvers || epoch.approvers.length === 0) {
      throw new Error(
        `finalizeEpoch: epoch ${input.epochId} has no pinned approvers (APPROVERS_PINNED_AT_REVIEW violated)`
      );
    }
    const signerLower = input.signerAddress.toLowerCase();
    const approversLower = epoch.approvers.map((a) => a.toLowerCase());
    if (!approversLower.includes(signerLower)) {
      throw new Error(
        `finalizeEpoch: signer ${input.signerAddress} not in approvers`
      );
    }
    // Self-consistent integrity check: recompute hash from pinned list
    const pinnedApproverSetHash = await computeApproverSetHash(epoch.approvers);
    if (epoch.approverSetHash !== pinnedApproverSetHash) {
      throw new Error(
        `finalizeEpoch: approver set hash integrity failure — stored hash ${epoch.approverSetHash} does not match recomputed ${pinnedApproverSetHash}`
      );
    }

    // 4. Load pool components → pool_total = SUM(amount_credits)
    const poolComponents =
      await attributionStore.getPoolComponentsForEpoch(epochId);
    if (poolComponents.length === 0) {
      throw new Error(
        `finalizeEpoch: epoch ${input.epochId} has no pool components (POOL_REQUIRES_BASE)`
      );
    }
    const hasBaseIssuance = poolComponents.some(
      (c) => c.componentId === "base_issuance"
    );
    if (!hasBaseIssuance) {
      throw new Error(
        `finalizeEpoch: epoch ${input.epochId} missing base_issuance component (POOL_REQUIRES_BASE)`
      );
    }

    const poolTotal = poolComponents.reduce(
      (sum, c) => sum + c.amountCredits,
      0n
    );

    // 5. Load locked claimants + receipt weights + overrides → explode to claimant allocations
    const lockedClaimants = await attributionStore.loadLockedClaimants(epochId);
    if (lockedClaimants.length === 0) {
      throw new Error(
        `finalizeEpoch: epoch ${input.epochId} has no locked claimant rows`
      );
    }

    const [selections, overrideRecords] = await Promise.all([
      attributionStore.getSelectedReceiptsForAllocation(epochId),
      attributionStore.getReviewSubjectOverridesForEpoch(epochId),
    ]);
    const rawWeights = await dispatchAllocator(
      registries.allocators,
      epoch.allocationAlgoRef,
      {
        receipts: selections,
        weightConfig: epoch.weightConfig,
        evaluations: toEvaluationPayloadMap(
          await attributionStore.getEvaluationsForEpoch(epochId, "locked")
        ),
        profileConfig: null,
      }
    );
    const overrides = toReviewSubjectOverrides(overrideRecords);
    const receiptWeights = applyReceiptWeightOverrides(rawWeights, overrides);

    const finalClaimantAllocations = explodeToClaimants(
      receiptWeights,
      lockedClaimants,
      overrides
    );
    if (finalClaimantAllocations.length === 0) {
      throw new Error(
        `finalizeEpoch: epoch ${input.epochId} has no claimant allocations`
      );
    }

    // Build override audit trail for statement persistence
    const reviewOverrideSnapshots = buildReceiptWeightOverrideSnapshots(
      rawWeights,
      lockedClaimants,
      overrides
    );

    // 6. Compute statement lines from final allocations
    const statementLines = computeAttributionStatementLines(
      finalClaimantAllocations,
      poolTotal
    );

    // 7. Compute allocation set hash (deterministic)
    const finalAllocationSetHash = await computeFinalClaimantAllocationSetHash(
      finalClaimantAllocations
    );

    // 8. Build EIP-712 typed data and verify signature
    const typedData = buildEIP712TypedData({
      nodeId,
      scopeId,
      epochId: input.epochId,
      finalAllocationSetHash,
      poolTotalCredits: poolTotal.toString(),
      chainId,
    });

    const isValid = await verifyTypedData({
      address: input.signerAddress as `0x${string}`,
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature: input.signature as `0x${string}`,
    });
    if (!isValid) {
      throw new Error(
        `finalizeEpoch: signature verification failed for signer ${input.signerAddress}`
      );
    }

    // 9. Atomic finalize — epoch transition + statement + signature in one transaction
    const { epoch: finalizedEpoch, statement } =
      await attributionStore.finalizeEpochAtomic({
        epochId,
        poolTotal,
        finalClaimantAllocations: finalClaimantAllocations.map(
          (allocation) => ({
            nodeId,
            epochId,
            claimantKey: claimantKey(allocation.claimant),
            claimant: allocation.claimant,
            finalUnits: allocation.finalUnits,
            receiptIds: [...(allocation.receiptIds ?? [])],
          })
        ),
        statement: {
          nodeId,
          finalAllocationSetHash,
          poolTotalCredits: poolTotal,
          statementLines: statementLines.map((line) => ({
            claimant_key: line.claimantKey,
            claimant: line.claimant,
            final_units: line.finalUnits.toString(),
            pool_share: line.poolShare,
            credit_amount: line.creditAmount.toString(),
            receipt_ids: [...line.receiptIds],
          })),
          reviewOverrides:
            reviewOverrideSnapshots.length > 0 ? reviewOverrideSnapshots : null,
        },
        signature: {
          nodeId,
          signerWallet: input.signerAddress,
          signature: input.signature,
          signedAt: new Date(),
        },
        expectedFinalAllocationSetHash: finalAllocationSetHash,
      });

    logger.info(
      {
        epochId: input.epochId,
        statementId: statement.id,
        poolTotalCredits: poolTotal.toString(),
        finalAllocationSetHash: `${finalAllocationSetHash.slice(0, 12)}...`,
        statementLineCount: statementLines.length,
        status: finalizedEpoch.status,
      },
      "Epoch finalized"
    );

    // R3: the SAME finalize signature drives the cumulative root + mint delta.
    // Built/persisted after the atomic off-chain finalize so a build failure
    // never undoes the signed statement; the off-chain ledger is authoritative.
    let cumulativeDistribution: FinalizeEpochOutput["cumulativeDistribution"] =
      null;
    try {
      cumulativeDistribution = await buildAndPersistCumulativeDistribution({
        epochId,
        statementId: statement.id,
        finalAllocationSetHash,
        statementLines: statementLines.map((line) => ({
          claimant_key: line.claimantKey,
          credit_amount: line.creditAmount.toString(),
          receipt_ids: [...line.receiptIds],
        })),
      });
    } catch (err) {
      logger.error(
        {
          epochId: input.epochId,
          err: err instanceof Error ? err.message : String(err),
        },
        "Cumulative distribution build failed AFTER finalize — epoch stays finalized; retry/repair on next finalize call"
      );
    }

    return {
      statementId: statement.id,
      poolTotalCredits: poolTotal.toString(),
      finalAllocationSetHash,
      statementLineCount: statementLines.length,
      cumulativeDistribution,
    };
  }

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
    finalizeEpoch,
    resolveStreams,
  };
}

/** Type alias for workflow proxy usage */
export type LedgerActivities = ReturnType<typeof createAttributionActivities>;
