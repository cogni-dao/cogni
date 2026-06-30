// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-client/adapters/drizzle-attribution`
 * Purpose: Drizzle ORM implementation of AttributionStore port.
 * Scope: Single adapter shared by app (via container.ts) and scheduler-worker. Implements all AttributionStore methods including identity resolution via user_bindings (cross-domain). Does not contain domain logic or define port interfaces.
 * Invariants:
 * - Uses serviceDb (BYPASSRLS) — no RLS in V0.
 * - SCOPE_GATED_QUERIES: Every epochId-based method enforces scope_id = this.scopeId. Scope mismatches throw EpochNotFoundError.
 * - RECEIPT_SCOPE_AGNOSTIC: ingestion_receipts has no scope_id — scope assigned at selection via epoch membership.
 * - SELECTION_POLICY_AUTHORITY: getSelectionCandidates excludes receipts already selected in prior same-scope epochs (NOT EXISTS subquery). No time-window filter — the selection policy decides epoch membership within remaining candidates.
 * - SELECTION_AUTO_POPULATE: insertSelectionDoNothing uses onConflictDoNothing; updateSelectionUserId only sets userId where NULL.
 * - SELECTION_FREEZE_ON_FINALIZE: DB trigger enforces; adapter does not duplicate check.
 * - ONE_OPEN_EPOCH: DB constraint enforces; adapter lets DB error propagate.
 * - USER_PROJECTIONS_RECOMPUTABLE: upsertUserProjections updates projected_units/receipt_count and never stores signed final units.
 * - POOL_LOCKED_AT_REVIEW: insertPoolComponent rejects inserts when epoch status != 'open'. Idempotent via ON CONFLICT DO NOTHING + SELECT fallback; returns { component, created }.
 * - CONFIG_LOCKED_AT_REVIEW: closeIngestion pins allocationAlgoRef + weightConfigHash.
 * - EVALUATION_FINAL_ATOMIC: closeIngestionWithEvaluations inserts locked evaluations + sets artifacts_hash + transitions epoch in one transaction.
 * - EPOCH_CLOSE_ON_TRANSITION: transitionEpochForWindow closes stale open epoch + creates new epoch in one DB transaction.
 * - STATEMENT_LINES_BOUNDARY_CLONE: toStatementLinesJson converts readonly statement lines to mutable Drizzle-compatible JSONB at the adapter boundary.
 * Side-effects: IO (database operations)
 * Links: docs/spec/attribution-ledger.md, packages/attribution-ledger/src/store.ts
 * @public
 */

import type {
  AttributionEpoch,
  AttributionEvaluation,
  AttributionPoolComponent,
  AttributionSelection,
  AttributionStatement,
  AttributionStatementLineRecord,
  AttributionStatementSignature,
  AttributionStore,
  CloseIngestionWithEvaluationsParams,
  DistributionClaimRecord,
  DistributionLeafRecord,
  DistributionManifestRecord,
  EpochUserProjection,
  FinalClaimantAllocationRecord,
  IngestionCursor,
  IngestionReceipt,
  InsertDistributionManifestParams,
  InsertFinalClaimantAllocationParams,
  InsertPoolComponentParams,
  InsertReceiptClaimantsParams,
  InsertReceiptParams,
  InsertSelectionAutoParams,
  InsertSignatureParams,
  InsertStatementParams,
  InsertUserProjectionParams,
  PoolComponentInsertResult,
  ReceiptClaimantsRecord,
  ReviewSubjectOverrideRecord,
  SelectedReceiptForAllocation,
  SelectedReceiptForAttribution,
  SelectedReceiptWithMetadata,
  TransitionEpochForWindowParams,
  TransitionEpochForWindowResult,
  UnselectedReceipt,
  UpsertEvaluationParams,
  UpsertReviewSubjectOverrideParams,
  UpsertSelectionParams,
} from "@cogni/attribution-ledger";
import {
  EpochNotFoundError,
  EpochNotInReviewError,
  EpochNotOpenError,
  type EpochStatus,
} from "@cogni/attribution-ledger";
import {
  epochDistributionLeaves,
  epochDistributionManifests,
  epochEvaluations,
  epochFinalClaimantAllocations,
  epochPoolComponents,
  epochReceiptClaimants,
  epochReviewSubjectOverrides,
  epochSelection,
  epochStatementSignatures,
  epochStatements,
  epochs,
  epochUserProjections,
  ingestionCursors,
  ingestionReceipts,
} from "@cogni/db-schema/attribution";
import { userBindings } from "@cogni/db-schema/identity";
import { userProfiles } from "@cogni/db-schema/profile";
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { Database } from "../client";

// ── Row mappers ─────────────────────────────────────────────────

function toEpoch(row: typeof epochs.$inferSelect): AttributionEpoch {
  return {
    id: row.id,
    nodeId: row.nodeId,
    scopeId: row.scopeId,
    status: row.status as EpochStatus,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    weightConfig: row.weightConfig,
    poolTotalCredits: row.poolTotalCredits,
    approverSetHash: row.approverSetHash,
    approvers: row.approvers ?? null,
    allocationAlgoRef: row.allocationAlgoRef,
    weightConfigHash: row.weightConfigHash,
    artifactsHash: row.artifactsHash,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
  };
}

function toIngestionReceipt(
  row: typeof ingestionReceipts.$inferSelect
): IngestionReceipt {
  return {
    receiptId: row.receiptId,
    nodeId: row.nodeId,
    source: row.source,
    eventType: row.eventType,
    platformUserId: row.platformUserId,
    platformLogin: row.platformLogin,
    artifactUrl: row.artifactUrl,
    metadata: row.metadata,
    payloadHash: row.payloadHash,
    producer: row.producer,
    producerVersion: row.producerVersion,
    eventTime: row.eventTime,
    retrievedAt: row.retrievedAt,
    ingestedAt: row.ingestedAt,
  };
}

function toSelection(
  row: typeof epochSelection.$inferSelect
): AttributionSelection {
  return {
    id: row.id,
    nodeId: row.nodeId,
    epochId: row.epochId,
    receiptId: row.receiptId,
    userId: row.userId,
    included: row.included,
    weightOverrideMilli: row.weightOverrideMilli,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toUserProjection(
  row: typeof epochUserProjections.$inferSelect
): EpochUserProjection {
  return {
    id: row.id,
    nodeId: row.nodeId,
    epochId: row.epochId,
    userId: row.userId,
    projectedUnits: row.projectedUnits,
    receiptCount: row.receiptCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toFinalClaimantAllocation(
  row: typeof epochFinalClaimantAllocations.$inferSelect
): FinalClaimantAllocationRecord {
  return {
    id: row.id,
    nodeId: row.nodeId,
    epochId: row.epochId,
    claimantKey: row.claimantKey,
    claimant: row.claimantJson,
    finalUnits: row.finalUnits,
    receiptIds: row.receiptIdsJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toCursor(row: typeof ingestionCursors.$inferSelect): IngestionCursor {
  return {
    nodeId: row.nodeId,
    scopeId: row.scopeId,
    source: row.source,
    stream: row.stream,
    sourceRef: row.sourceRef,
    cursorValue: row.cursorValue,
    retrievedAt: row.retrievedAt,
  };
}

function toPoolComponent(
  row: typeof epochPoolComponents.$inferSelect
): AttributionPoolComponent {
  return {
    id: row.id,
    nodeId: row.nodeId,
    epochId: row.epochId,
    componentId: row.componentId,
    algorithmVersion: row.algorithmVersion,
    inputsJson: row.inputsJson,
    amountCredits: row.amountCredits,
    evidenceRef: row.evidenceRef,
    computedAt: row.computedAt,
  };
}

function toStatement(
  row: typeof epochStatements.$inferSelect
): AttributionStatement {
  return {
    id: row.id,
    nodeId: row.nodeId,
    epochId: row.epochId,
    finalAllocationSetHash: row.finalAllocationSetHash,
    poolTotalCredits: row.poolTotalCredits,
    statementLines: row.statementLinesJson,
    reviewOverrides: row.reviewOverridesJson ?? null,
    supersedesStatementId: row.supersedesStatementId,
    createdAt: row.createdAt,
  };
}

function toDistributionManifest(
  row: typeof epochDistributionManifests.$inferSelect
): DistributionManifestRecord {
  return {
    id: row.id,
    nodeId: row.nodeId,
    scopeId: row.scopeId,
    epochId: row.epochId,
    distributionId: row.distributionId,
    statementHash: row.statementHash,
    merkleRoot: row.merkleRoot,
    chainId: Number(row.chainId),
    tokenAddress: row.tokenAddress,
    distributionAmount: row.distributionAmount,
    totalAllocated: row.totalAllocated,
    distributorAddress: row.distributorAddress,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDistributionLeaf(
  row: typeof epochDistributionLeaves.$inferSelect
): DistributionLeafRecord {
  return {
    index: row.leafIndex,
    claimantKey: row.claimantKey,
    account: row.account,
    amount: row.amount,
    leafHash: row.leafHash,
    proof: row.proofJson,
  };
}

function toReviewSubjectOverride(
  row: typeof epochReviewSubjectOverrides.$inferSelect
): ReviewSubjectOverrideRecord {
  return {
    id: row.id,
    nodeId: row.nodeId,
    epochId: row.epochId,
    subjectRef: row.subjectRef,
    overrideUnits: row.overrideUnits,
    overrideSharesJson: row.overrideSharesJson ?? null,
    overrideReason: row.overrideReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type EpochStatementLinesJson = NonNullable<
  typeof epochStatements.$inferInsert.statementLinesJson
>;
type EpochStatementLineJson = EpochStatementLinesJson[number];

function toStatementLinesJson(
  items: readonly AttributionStatementLineRecord[]
): EpochStatementLinesJson {
  return items.map(
    (item): EpochStatementLineJson => ({
      claimant_key: item.claimant_key,
      claimant:
        item.claimant.kind === "user"
          ? {
              kind: "user",
              userId: item.claimant.userId,
            }
          : {
              kind: "identity",
              provider: item.claimant.provider,
              externalId: item.claimant.externalId,
              providerLogin: item.claimant.providerLogin,
            },
      final_units: item.final_units,
      pool_share: item.pool_share,
      credit_amount: item.credit_amount,
      // Clone nested arrays at the adapter boundary so core statement items stay
      // readonly while Drizzle receives mutable JSON-compatible values.
      receipt_ids: [...item.receipt_ids],
    })
  );
}

type EpochReviewOverridesJson = NonNullable<
  typeof epochStatements.$inferInsert.reviewOverridesJson
>;

/**
 * REVIEW_OVERRIDES_BOUNDARY_CLONE: strips readonly from ReviewOverrideSnapshot[]
 * so Drizzle's mutable JSONB types are satisfied.
 */
function toReviewOverridesJson(
  snapshots: readonly import("@cogni/attribution-ledger").ReviewOverrideSnapshot[]
): EpochReviewOverridesJson {
  return snapshots.map((s) => ({
    subject_ref: s.subject_ref,
    original_units: s.original_units,
    override_units: s.override_units,
    original_shares: s.original_shares.map((cs) => ({
      claimant:
        cs.claimant.kind === "user"
          ? { kind: "user" as const, userId: cs.claimant.userId }
          : {
              kind: "identity" as const,
              provider: cs.claimant.provider,
              externalId: cs.claimant.externalId,
              providerLogin: cs.claimant.providerLogin,
            },
      sharePpm: cs.sharePpm,
    })),
    override_shares: s.override_shares
      ? s.override_shares.map((cs) => ({
          claimant:
            cs.claimant.kind === "user"
              ? { kind: "user" as const, userId: cs.claimant.userId }
              : {
                  kind: "identity" as const,
                  provider: cs.claimant.provider,
                  externalId: cs.claimant.externalId,
                  providerLogin: cs.claimant.providerLogin,
                },
          sharePpm: cs.sharePpm,
        }))
      : null,
    reason: s.reason,
  }));
}

function toStatementSignature(
  row: typeof epochStatementSignatures.$inferSelect
): AttributionStatementSignature {
  return {
    id: row.id,
    nodeId: row.nodeId,
    statementId: row.statementId,
    signerWallet: row.signerWallet,
    signature: row.signature,
    signedAt: row.signedAt,
  };
}

function toEvaluation(
  row: typeof epochEvaluations.$inferSelect
): AttributionEvaluation {
  return {
    id: row.id,
    nodeId: row.nodeId,
    epochId: row.epochId,
    evaluationRef: row.evaluationRef,
    status: row.status as "draft" | "locked",
    algoRef: row.algoRef,
    inputsHash: row.inputsHash,
    payloadHash: row.payloadHash,
    payloadJson: row.payloadJson,
    payloadRef: row.payloadRef,
    createdAt: row.createdAt,
  };
}

// ── Adapter ─────────────────────────────────────────────────────

export class DrizzleAttributionAdapter implements AttributionStore {
  constructor(
    private readonly db: Database,
    private readonly scopeId: string
  ) {}

  // ── Scope gate ────────────────────────────────────────────────

  /**
   * Validate that an epoch belongs to this adapter's scope.
   * SCOPE_GATED_QUERIES: scope mismatches throw EpochNotFoundError
   * (indistinguishable from a genuinely missing epoch).
   */
  private async resolveEpochScoped(epochId: bigint): Promise<AttributionEpoch> {
    const rows = await this.db
      .select()
      .from(epochs)
      .where(and(eq(epochs.id, epochId), eq(epochs.scopeId, this.scopeId)))
      .limit(1);
    if (!rows[0]) throw new EpochNotFoundError(epochId.toString());
    return toEpoch(rows[0]);
  }

  /**
   * Like resolveEpochScoped but acquires a row-level lock (SELECT ... FOR UPDATE).
   * Use for write operations that must serialize against concurrent finalization.
   * Accepts optional `tx` to run within an existing transaction context.
   */
  private async resolveEpochScopedForUpdate(
    epochId: bigint,
    tx?: Parameters<Parameters<(typeof this.db)["transaction"]>[0]>[0]
  ): Promise<AttributionEpoch> {
    const queryRunner = tx ?? this.db;
    const rows = await queryRunner
      .select()
      .from(epochs)
      .where(and(eq(epochs.id, epochId), eq(epochs.scopeId, this.scopeId)))
      .limit(1)
      .for("update");
    if (!rows[0]) throw new EpochNotFoundError(epochId.toString());
    return toEpoch(rows[0]);
  }

  /**
   * Validate that all epochIds in a batch belong to this adapter's scope.
   * Deduplicates before querying. Throws on first mismatch.
   */
  private async validateEpochIds(epochIds: bigint[]): Promise<void> {
    const unique = [...new Set(epochIds.map((id) => id.toString()))];
    for (const id of unique) {
      await this.resolveEpochScoped(BigInt(id));
    }
  }

  // ── Epochs ──────────────────────────────────────────────────

  async createEpoch(params: {
    nodeId: string;
    scopeId: string;
    periodStart: Date;
    periodEnd: Date;
    weightConfig: Record<string, number>;
  }): Promise<AttributionEpoch> {
    const [row] = await this.db
      .insert(epochs)
      .values({
        nodeId: params.nodeId,
        scopeId: params.scopeId,
        periodStart: params.periodStart,
        periodEnd: params.periodEnd,
        weightConfig: params.weightConfig,
      })
      .returning();
    if (!row) throw new Error("createEpoch: INSERT returned no rows");
    return toEpoch(row);
  }

  async getOpenEpoch(
    nodeId: string,
    scopeId: string
  ): Promise<AttributionEpoch | null> {
    const rows = await this.db
      .select()
      .from(epochs)
      .where(
        and(
          eq(epochs.nodeId, nodeId),
          eq(epochs.scopeId, scopeId),
          eq(epochs.status, "open")
        )
      )
      .limit(1);
    return rows[0] ? toEpoch(rows[0]) : null;
  }

  async getEpochByWindow(
    nodeId: string,
    scopeId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<AttributionEpoch | null> {
    const rows = await this.db
      .select()
      .from(epochs)
      .where(
        and(
          eq(epochs.nodeId, nodeId),
          eq(epochs.scopeId, scopeId),
          eq(epochs.periodStart, periodStart),
          eq(epochs.periodEnd, periodEnd)
        )
      )
      .limit(1);
    return rows[0] ? toEpoch(rows[0]) : null;
  }

  async getEpoch(id: bigint): Promise<AttributionEpoch | null> {
    const rows = await this.db
      .select()
      .from(epochs)
      .where(and(eq(epochs.id, id), eq(epochs.scopeId, this.scopeId)))
      .limit(1);
    return rows[0] ? toEpoch(rows[0]) : null;
  }

  async listEpochs(nodeId: string): Promise<AttributionEpoch[]> {
    const rows = await this.db
      .select()
      .from(epochs)
      .where(and(eq(epochs.nodeId, nodeId), eq(epochs.scopeId, this.scopeId)))
      .orderBy(epochs.id);
    return rows.map(toEpoch);
  }

  async closeIngestion(
    epochId: bigint,
    approvers: string[],
    approverSetHash: string,
    allocationAlgoRef: string,
    weightConfigHash: string
  ): Promise<AttributionEpoch> {
    const [row] = await this.db
      .update(epochs)
      .set({
        status: "review",
        approvers: approvers.map((a) => a.toLowerCase()),
        approverSetHash,
        allocationAlgoRef,
        weightConfigHash,
      })
      .where(
        and(
          eq(epochs.id, epochId),
          eq(epochs.scopeId, this.scopeId),
          eq(epochs.status, "open")
        )
      )
      .returning();
    if (!row) {
      const existing = await this.getEpoch(epochId);
      if (!existing) {
        throw new EpochNotFoundError(epochId.toString());
      }
      // Idempotent: already in review or finalized → return as-is
      if (existing.status === "review" || existing.status === "finalized") {
        return existing;
      }
      // Should not happen (open epoch that didn't match UPDATE) — defensive
      throw new EpochNotOpenError(epochId.toString());
    }
    return toEpoch(row);
  }

  async finalizeEpoch(
    epochId: bigint,
    poolTotal: bigint
  ): Promise<AttributionEpoch> {
    const [row] = await this.db
      .update(epochs)
      .set({
        status: "finalized",
        poolTotalCredits: poolTotal,
        closedAt: new Date(),
      })
      .where(
        and(
          eq(epochs.id, epochId),
          eq(epochs.scopeId, this.scopeId),
          eq(epochs.status, "review")
        )
      )
      .returning();
    if (!row) {
      const existing = await this.getEpoch(epochId);
      if (!existing) {
        throw new EpochNotFoundError(epochId.toString());
      }
      // Idempotent: already finalized → return as-is
      if (existing.status === "finalized") {
        return existing;
      }
      // Wrong state (open) — caller must closeIngestion first
      throw new EpochNotOpenError(epochId.toString());
    }
    return toEpoch(row);
  }

  // ── Evaluations ──────────────────────────────────────────────

  async closeIngestionWithEvaluations(
    params: CloseIngestionWithEvaluationsParams
  ): Promise<AttributionEpoch> {
    return await this.db.transaction(async (tx) => {
      // 1. Scope gate + status check (inline)
      const epochRows = await tx
        .select()
        .from(epochs)
        .where(
          and(eq(epochs.id, params.epochId), eq(epochs.scopeId, this.scopeId))
        )
        .limit(1);
      if (!epochRows[0]) {
        throw new EpochNotFoundError(params.epochId.toString());
      }
      if (epochRows[0].status !== "open") {
        // Idempotent: already in review/finalized → return as-is
        if (
          epochRows[0].status === "review" ||
          epochRows[0].status === "finalized"
        ) {
          return toEpoch(epochRows[0]);
        }
        throw new EpochNotOpenError(params.epochId.toString());
      }

      // 2. Insert locked evaluations
      for (const evaluation of params.evaluations) {
        await tx
          .insert(epochEvaluations)
          .values({
            nodeId: evaluation.nodeId,
            epochId: evaluation.epochId,
            evaluationRef: evaluation.evaluationRef,
            status: "locked",
            algoRef: evaluation.algoRef,
            inputsHash: evaluation.inputsHash,
            payloadHash: evaluation.payloadHash,
            payloadJson: evaluation.payloadJson,
          })
          .onConflictDoNothing({
            target: [
              epochEvaluations.epochId,
              epochEvaluations.evaluationRef,
              epochEvaluations.status,
            ],
          });
      }

      // 3. Transition epoch open → review with config pins + artifacts_hash
      const [updated] = await tx
        .update(epochs)
        .set({
          status: "review",
          approvers: params.approvers.map((a) => a.toLowerCase()),
          approverSetHash: params.approverSetHash,
          allocationAlgoRef: params.allocationAlgoRef,
          weightConfigHash: params.weightConfigHash,
          artifactsHash: params.artifactsHash,
        })
        .where(
          and(
            eq(epochs.id, params.epochId),
            eq(epochs.scopeId, this.scopeId),
            eq(epochs.status, "open")
          )
        )
        .returning();

      if (!updated) {
        // Concurrent close won — reload and return
        const [reloaded] = await tx
          .select()
          .from(epochs)
          .where(
            and(eq(epochs.id, params.epochId), eq(epochs.scopeId, this.scopeId))
          )
          .limit(1);
        if (!reloaded) {
          throw new EpochNotFoundError(params.epochId.toString());
        }
        return toEpoch(reloaded);
      }

      return toEpoch(updated);
    });
  }

  async transitionEpochForWindow(
    params: TransitionEpochForWindowParams
  ): Promise<TransitionEpochForWindowResult> {
    return await this.db.transaction(async (tx) => {
      // 1. Check if epoch already exists for this window (any status) → return it
      const [existing] = await tx
        .select()
        .from(epochs)
        .where(
          and(
            eq(epochs.nodeId, params.nodeId),
            eq(epochs.scopeId, params.scopeId),
            eq(epochs.periodStart, params.periodStart),
            eq(epochs.periodEnd, params.periodEnd)
          )
        )
        .limit(1);
      if (existing) {
        // Idempotent rerun — previous call already closed stale + created this epoch
        return {
          epoch: toEpoch(existing),
          isNew: false,
          closedStaleEpochId: params.closeParams.epochId,
        };
      }

      // 2. Close the stale open epoch (different window, since step 1 didn't match)
      // Insert locked evaluations for the stale epoch
      for (const evaluation of params.closeParams.evaluations) {
        await tx
          .insert(epochEvaluations)
          .values({
            nodeId: evaluation.nodeId,
            epochId: evaluation.epochId,
            evaluationRef: evaluation.evaluationRef,
            status: "locked",
            algoRef: evaluation.algoRef,
            inputsHash: evaluation.inputsHash,
            payloadHash: evaluation.payloadHash,
            payloadJson: evaluation.payloadJson,
          })
          .onConflictDoNothing({
            target: [
              epochEvaluations.epochId,
              epochEvaluations.evaluationRef,
              epochEvaluations.status,
            ],
          });
      }

      // Transition stale epoch open → review
      // WHERE status='open' makes this idempotent — concurrent close returns 0 rows
      await tx
        .update(epochs)
        .set({
          status: "review",
          approvers: params.closeParams.approvers.map((a: string) =>
            a.toLowerCase()
          ),
          approverSetHash: params.closeParams.approverSetHash,
          allocationAlgoRef: params.closeParams.allocationAlgoRef,
          weightConfigHash: params.closeParams.weightConfigHash,
          artifactsHash: params.closeParams.artifactsHash,
        })
        .where(
          and(
            eq(epochs.id, params.closeParams.epochId),
            eq(epochs.scopeId, this.scopeId),
            eq(epochs.status, "open")
          )
        );

      // 3. Create the new epoch for the requested window
      const [created] = await tx
        .insert(epochs)
        .values({
          nodeId: params.nodeId,
          scopeId: params.scopeId,
          periodStart: params.periodStart,
          periodEnd: params.periodEnd,
          weightConfig: params.weightConfig,
        })
        .returning();

      if (!created) {
        throw new Error("Failed to create epoch — INSERT returned no rows");
      }

      return {
        epoch: toEpoch(created),
        isNew: true,
        closedStaleEpochId: params.closeParams.epochId,
      };
    });
  }

  async upsertDraftEvaluation(params: UpsertEvaluationParams): Promise<void> {
    await this.resolveEpochScoped(params.epochId);
    await this.db
      .insert(epochEvaluations)
      .values({
        nodeId: params.nodeId,
        epochId: params.epochId,
        evaluationRef: params.evaluationRef,
        status: "draft",
        algoRef: params.algoRef,
        inputsHash: params.inputsHash,
        payloadHash: params.payloadHash,
        payloadJson: params.payloadJson,
      })
      .onConflictDoUpdate({
        target: [
          epochEvaluations.epochId,
          epochEvaluations.evaluationRef,
          epochEvaluations.status,
        ],
        set: {
          algoRef: params.algoRef,
          inputsHash: params.inputsHash,
          payloadHash: params.payloadHash,
          payloadJson: params.payloadJson,
          createdAt: new Date(),
        },
      });
  }

  async getEvaluationsForEpoch(
    epochId: bigint,
    status?: "draft" | "locked"
  ): Promise<AttributionEvaluation[]> {
    await this.resolveEpochScoped(epochId);
    const conditions = [eq(epochEvaluations.epochId, epochId)];
    if (status) conditions.push(eq(epochEvaluations.status, status));
    const rows = await this.db
      .select()
      .from(epochEvaluations)
      .where(and(...conditions));
    return rows.map(toEvaluation);
  }

  async getEvaluation(
    epochId: bigint,
    evaluationRef: string,
    status?: "draft" | "locked"
  ): Promise<AttributionEvaluation | null> {
    await this.resolveEpochScoped(epochId);
    const conditions = [
      eq(epochEvaluations.epochId, epochId),
      eq(epochEvaluations.evaluationRef, evaluationRef),
    ];
    if (status) conditions.push(eq(epochEvaluations.status, status));
    const rows = await this.db
      .select()
      .from(epochEvaluations)
      .where(and(...conditions))
      .limit(1);
    return rows[0] ? toEvaluation(rows[0]) : null;
  }

  async getSelectedReceiptsWithMetadata(
    epochId: bigint
  ): Promise<SelectedReceiptWithMetadata[]> {
    await this.resolveEpochScoped(epochId);
    const rows = await this.db
      .select({
        receiptId: epochSelection.receiptId,
        userId: epochSelection.userId,
        source: ingestionReceipts.source,
        eventType: ingestionReceipts.eventType,
        included: epochSelection.included,
        weightOverrideMilli: epochSelection.weightOverrideMilli,
        metadata: ingestionReceipts.metadata,
        payloadHash: ingestionReceipts.payloadHash,
      })
      .from(epochSelection)
      .innerJoin(
        ingestionReceipts,
        and(
          eq(ingestionReceipts.receiptId, epochSelection.receiptId),
          eq(ingestionReceipts.nodeId, epochSelection.nodeId)
        )
      )
      .where(eq(epochSelection.epochId, epochId));
    return rows.map((r) => ({
      receiptId: r.receiptId,
      userId: r.userId,
      source: r.source,
      eventType: r.eventType,
      included: r.included,
      weightOverrideMilli: r.weightOverrideMilli,
      metadata: r.metadata,
      payloadHash: r.payloadHash,
    }));
  }

  async getSelectedReceiptsForAttribution(
    epochId: bigint
  ): Promise<SelectedReceiptForAttribution[]> {
    await this.resolveEpochScoped(epochId);
    const rows = await this.db
      .select({
        receiptId: epochSelection.receiptId,
        userId: epochSelection.userId,
        source: ingestionReceipts.source,
        eventType: ingestionReceipts.eventType,
        included: epochSelection.included,
        weightOverrideMilli: epochSelection.weightOverrideMilli,
        platformUserId: ingestionReceipts.platformUserId,
        platformLogin: ingestionReceipts.platformLogin,
        artifactUrl: ingestionReceipts.artifactUrl,
        eventTime: ingestionReceipts.eventTime,
        payloadHash: ingestionReceipts.payloadHash,
      })
      .from(epochSelection)
      .innerJoin(
        ingestionReceipts,
        and(
          eq(ingestionReceipts.receiptId, epochSelection.receiptId),
          eq(ingestionReceipts.nodeId, epochSelection.nodeId)
        )
      )
      .where(eq(epochSelection.epochId, epochId));

    return rows.map((r) => ({
      receiptId: r.receiptId,
      userId: r.userId,
      source: r.source,
      eventType: r.eventType,
      included: r.included,
      weightOverrideMilli: r.weightOverrideMilli,
      platformUserId: r.platformUserId,
      platformLogin: r.platformLogin,
      artifactUrl: r.artifactUrl,
      eventTime: r.eventTime,
      payloadHash: r.payloadHash,
    }));
  }

  // ── Allocation computation ──────────────────────────────────

  async getSelectedReceiptsForAllocation(
    epochId: bigint
  ): Promise<SelectedReceiptForAllocation[]> {
    await this.resolveEpochScoped(epochId);
    const rows = await this.db
      .select({
        receiptId: epochSelection.receiptId,
        userId: epochSelection.userId,
        source: ingestionReceipts.source,
        eventType: ingestionReceipts.eventType,
        included: epochSelection.included,
        weightOverrideMilli: epochSelection.weightOverrideMilli,
      })
      .from(epochSelection)
      .innerJoin(
        ingestionReceipts,
        and(
          eq(ingestionReceipts.receiptId, epochSelection.receiptId),
          eq(ingestionReceipts.nodeId, epochSelection.nodeId)
        )
      )
      .where(eq(epochSelection.epochId, epochId));
    return rows.map((r) => ({
      receiptId: r.receiptId,
      userId: r.userId,
      source: r.source,
      eventType: r.eventType,
      included: r.included,
      weightOverrideMilli: r.weightOverrideMilli,
    }));
  }

  // ── Ingestion receipts ─────────────────────────────────────

  async insertIngestionReceipts(
    receipts: InsertReceiptParams[]
  ): Promise<void> {
    if (receipts.length === 0) return;
    await this.db
      .insert(ingestionReceipts)
      .values(
        receipts.map((e) => ({
          nodeId: e.nodeId,
          receiptId: e.receiptId,
          source: e.source,
          eventType: e.eventType,
          platformUserId: e.platformUserId,
          platformLogin: e.platformLogin ?? null,
          artifactUrl: e.artifactUrl ?? null,
          metadata: e.metadata ?? null,
          payloadHash: e.payloadHash,
          producer: e.producer,
          producerVersion: e.producerVersion,
          eventTime: e.eventTime,
          retrievedAt: e.retrievedAt,
        }))
      )
      .onConflictDoNothing();
  }

  async getReceiptsForWindow(
    nodeId: string,
    since: Date,
    until: Date
  ): Promise<IngestionReceipt[]> {
    // RECEIPT_SCOPE_AGNOSTIC: no scope filter — returns all receipts for node in window
    const rows = await this.db
      .select()
      .from(ingestionReceipts)
      .where(
        and(
          eq(ingestionReceipts.nodeId, nodeId),
          gte(ingestionReceipts.eventTime, since),
          lte(ingestionReceipts.eventTime, until)
        )
      )
      .orderBy(ingestionReceipts.eventTime);
    return rows.map(toIngestionReceipt);
  }

  async getAllReceipts(nodeId: string): Promise<IngestionReceipt[]> {
    const rows = await this.db
      .select()
      .from(ingestionReceipts)
      .where(eq(ingestionReceipts.nodeId, nodeId))
      .orderBy(ingestionReceipts.eventTime);
    return rows.map(toIngestionReceipt);
  }

  async getReceiptsForEpoch(
    nodeId: string,
    epochId: bigint
  ): Promise<IngestionReceipt[]> {
    await this.resolveEpochScoped(epochId);
    const rows = await this.db
      .select({ receipt: ingestionReceipts })
      .from(ingestionReceipts)
      .innerJoin(
        epochSelection,
        eq(epochSelection.receiptId, ingestionReceipts.receiptId)
      )
      .where(
        and(
          eq(ingestionReceipts.nodeId, nodeId),
          eq(epochSelection.epochId, epochId)
        )
      )
      .orderBy(ingestionReceipts.eventTime);
    return rows.map((r) => toIngestionReceipt(r.receipt));
  }

  // ── Selection ────────────────────────────────────────────────

  async upsertSelection(params: UpsertSelectionParams[]): Promise<void> {
    if (params.length === 0) return;
    await this.validateEpochIds(params.map((p) => p.epochId));
    for (const p of params) {
      await this.db
        .insert(epochSelection)
        .values({
          nodeId: p.nodeId,
          epochId: p.epochId,
          receiptId: p.receiptId,
          userId: p.userId ?? null,
          included: p.included ?? true,
          weightOverrideMilli: p.weightOverrideMilli ?? null,
          note: p.note ?? null,
        })
        .onConflictDoUpdate({
          target: [epochSelection.epochId, epochSelection.receiptId],
          set: {
            userId: p.userId ?? null,
            included: p.included ?? true,
            weightOverrideMilli: p.weightOverrideMilli ?? null,
            note: p.note ?? null,
            updatedAt: new Date(),
          },
        });
    }
  }

  async insertSelectionDoNothing(
    params: InsertSelectionAutoParams[]
  ): Promise<void> {
    if (params.length === 0) return;
    await this.validateEpochIds(params.map((p) => p.epochId));
    for (const p of params) {
      await this.db
        .insert(epochSelection)
        .values({
          nodeId: p.nodeId,
          epochId: p.epochId,
          receiptId: p.receiptId,
          userId: p.userId ?? null,
          included: p.included,
        })
        .onConflictDoNothing({
          target: [epochSelection.epochId, epochSelection.receiptId],
        });
    }
  }

  async getSelectionForEpoch(epochId: bigint): Promise<AttributionSelection[]> {
    await this.resolveEpochScoped(epochId);
    const rows = await this.db
      .select()
      .from(epochSelection)
      .where(eq(epochSelection.epochId, epochId));
    return rows.map(toSelection);
  }

  async getUnresolvedSelection(
    epochId: bigint
  ): Promise<AttributionSelection[]> {
    await this.resolveEpochScoped(epochId);
    const rows = await this.db
      .select()
      .from(epochSelection)
      .where(
        and(eq(epochSelection.epochId, epochId), isNull(epochSelection.userId))
      );
    return rows.map(toSelection);
  }

  // ── User projections ────────────────────────────────────────

  async insertUserProjections(
    params: InsertUserProjectionParams[]
  ): Promise<void> {
    if (params.length === 0) return;
    await this.validateEpochIds(params.map((a) => a.epochId));
    await this.db.insert(epochUserProjections).values(
      params.map((a) => ({
        nodeId: a.nodeId,
        epochId: a.epochId,
        userId: a.userId,
        projectedUnits: a.projectedUnits,
        receiptCount: a.receiptCount,
      }))
    );
  }

  async upsertUserProjections(
    params: InsertUserProjectionParams[]
  ): Promise<void> {
    if (params.length === 0) return;
    await this.validateEpochIds(params.map((a) => a.epochId));
    for (const a of params) {
      await this.db
        .insert(epochUserProjections)
        .values({
          nodeId: a.nodeId,
          epochId: a.epochId,
          userId: a.userId,
          projectedUnits: a.projectedUnits,
          receiptCount: a.receiptCount,
        })
        .onConflictDoUpdate({
          target: [epochUserProjections.epochId, epochUserProjections.userId],
          set: {
            projectedUnits: sql`EXCLUDED.projected_units`,
            receiptCount: sql`EXCLUDED.receipt_count`,
            updatedAt: new Date(),
          },
        });
    }
  }

  async deleteStaleUserProjections(
    epochId: bigint,
    activeUserIds: string[]
  ): Promise<void> {
    await this.resolveEpochScoped(epochId);
    if (activeUserIds.length === 0) return;
    await this.db
      .delete(epochUserProjections)
      .where(
        and(
          eq(epochUserProjections.epochId, epochId),
          notInArray(epochUserProjections.userId, activeUserIds)
        )
      );
  }

  async getUserProjectionsForEpoch(
    epochId: bigint
  ): Promise<EpochUserProjection[]> {
    await this.resolveEpochScoped(epochId);
    const rows = await this.db
      .select()
      .from(epochUserProjections)
      .where(eq(epochUserProjections.epochId, epochId));
    return rows.map(toUserProjection);
  }

  async replaceFinalClaimantAllocations(
    epochId: bigint,
    allocations: readonly InsertFinalClaimantAllocationParams[]
  ): Promise<void> {
    await this.resolveEpochScoped(epochId);
    await this.db.transaction(async (tx) => {
      await tx
        .delete(epochFinalClaimantAllocations)
        .where(eq(epochFinalClaimantAllocations.epochId, epochId));

      if (allocations.length === 0) return;

      await tx.insert(epochFinalClaimantAllocations).values(
        allocations.map((allocation) => ({
          nodeId: allocation.nodeId,
          epochId: allocation.epochId,
          claimantKey: allocation.claimantKey,
          claimantJson: allocation.claimant,
          finalUnits: allocation.finalUnits,
          receiptIdsJson: [...allocation.receiptIds],
        }))
      );
    });
  }

  async getFinalClaimantAllocationsForEpoch(
    epochId: bigint
  ): Promise<FinalClaimantAllocationRecord[]> {
    await this.resolveEpochScoped(epochId);
    const rows = await this.db
      .select()
      .from(epochFinalClaimantAllocations)
      .where(eq(epochFinalClaimantAllocations.epochId, epochId))
      .orderBy(epochFinalClaimantAllocations.claimantKey);
    return rows.map(toFinalClaimantAllocation);
  }

  // ── Cursors ─────────────────────────────────────────────────

  async upsertCursor(
    nodeId: string,
    scopeId: string,
    source: string,
    stream: string,
    sourceRef: string,
    cursorValue: string
  ): Promise<void> {
    await this.db
      .insert(ingestionCursors)
      .values({
        nodeId,
        scopeId,
        source,
        stream,
        sourceRef,
        cursorValue,
        retrievedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          ingestionCursors.nodeId,
          ingestionCursors.scopeId,
          ingestionCursors.source,
          ingestionCursors.stream,
          ingestionCursors.sourceRef,
        ],
        set: {
          cursorValue,
          retrievedAt: new Date(),
        },
      });
  }

  async getCursor(
    nodeId: string,
    scopeId: string,
    source: string,
    stream: string,
    sourceRef: string
  ): Promise<IngestionCursor | null> {
    const rows = await this.db
      .select()
      .from(ingestionCursors)
      .where(
        and(
          eq(ingestionCursors.nodeId, nodeId),
          eq(ingestionCursors.scopeId, scopeId),
          eq(ingestionCursors.source, source),
          eq(ingestionCursors.stream, stream),
          eq(ingestionCursors.sourceRef, sourceRef)
        )
      )
      .limit(1);
    return rows[0] ? toCursor(rows[0]) : null;
  }

  // ── Pool components ─────────────────────────────────────────

  async insertPoolComponent(
    params: InsertPoolComponentParams
  ): Promise<PoolComponentInsertResult> {
    const epoch = await this.resolveEpochScoped(params.epochId);
    // POOL_LOCKED_AT_REVIEW: reject pool component inserts after closeIngestion
    if (epoch.status !== "open") {
      throw new EpochNotOpenError(params.epochId.toString());
    }
    // Idempotent: ON CONFLICT DO NOTHING + SELECT fallback (matches adapter pattern)
    const [inserted] = await this.db
      .insert(epochPoolComponents)
      .values({
        nodeId: params.nodeId,
        epochId: params.epochId,
        componentId: params.componentId,
        algorithmVersion: params.algorithmVersion,
        inputsJson: params.inputsJson,
        amountCredits: params.amountCredits,
        evidenceRef: params.evidenceRef ?? null,
      })
      .onConflictDoNothing({
        target: [epochPoolComponents.epochId, epochPoolComponents.componentId],
      })
      .returning();
    if (inserted)
      return { component: toPoolComponent(inserted), created: true };
    // Conflict: row already exists — SELECT by unique key (epochId, componentId)
    const [existing] = await this.db
      .select()
      .from(epochPoolComponents)
      .where(
        and(
          eq(epochPoolComponents.epochId, params.epochId),
          eq(epochPoolComponents.componentId, params.componentId)
        )
      );
    if (!existing)
      throw new Error("insertPoolComponent: conflict but row not found");
    return { component: toPoolComponent(existing), created: false };
  }

  async getPoolComponentsForEpoch(
    epochId: bigint
  ): Promise<AttributionPoolComponent[]> {
    await this.resolveEpochScoped(epochId);
    const rows = await this.db
      .select()
      .from(epochPoolComponents)
      .where(eq(epochPoolComponents.epochId, epochId));
    return rows.map(toPoolComponent);
  }

  // ── Epoch statements ──────────────────────────────────────

  async insertEpochStatement(
    params: InsertStatementParams
  ): Promise<AttributionStatement> {
    await this.resolveEpochScoped(params.epochId);
    const [row] = await this.db
      .insert(epochStatements)
      .values({
        nodeId: params.nodeId,
        epochId: params.epochId,
        finalAllocationSetHash: params.finalAllocationSetHash,
        poolTotalCredits: params.poolTotalCredits,
        statementLinesJson: toStatementLinesJson(params.statementLines),
        reviewOverridesJson: params.reviewOverrides
          ? toReviewOverridesJson(params.reviewOverrides)
          : null,
        supersedesStatementId: params.supersedesStatementId ?? null,
      })
      .returning();
    if (!row) throw new Error("insertEpochStatement: INSERT returned no rows");
    return toStatement(row);
  }

  async getStatementForEpoch(
    epochId: bigint
  ): Promise<AttributionStatement | null> {
    await this.resolveEpochScoped(epochId);
    const rows = await this.db
      .select()
      .from(epochStatements)
      .where(eq(epochStatements.epochId, epochId))
      .limit(1);
    return rows[0] ? toStatement(rows[0]) : null;
  }

  // ── Distribution manifest ─────────────────────────────────

  /**
   * Upsert the merkle distribution manifest + its leaves for an epoch.
   * Atomic: replaces the manifest header and all leaf rows in one transaction
   * (idempotent re-runs overwrite). Scope-gated via the epoch.
   * DISTRIBUTION_READ_WRITE_ONLY: persists a prebuilt manifest; never builds the tree.
   */
  async upsertDistributionManifest(
    params: InsertDistributionManifestParams
  ): Promise<DistributionManifestRecord> {
    await this.resolveEpochScoped(params.epochId);
    return await this.db.transaction(async (tx) => {
      const [manifest] = await tx
        .insert(epochDistributionManifests)
        .values({
          nodeId: params.nodeId,
          scopeId: params.scopeId,
          epochId: params.epochId,
          distributionId: params.distributionId,
          statementHash: params.statementHash,
          merkleRoot: params.merkleRoot,
          chainId: BigInt(params.chainId),
          tokenAddress: params.tokenAddress,
          distributionAmount: params.distributionAmount,
          totalAllocated: params.totalAllocated,
          distributorAddress: params.distributorAddress ?? null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [
            epochDistributionManifests.nodeId,
            epochDistributionManifests.scopeId,
            epochDistributionManifests.epochId,
          ],
          set: {
            distributionId: params.distributionId,
            statementHash: params.statementHash,
            merkleRoot: params.merkleRoot,
            chainId: BigInt(params.chainId),
            tokenAddress: params.tokenAddress,
            distributionAmount: params.distributionAmount,
            totalAllocated: params.totalAllocated,
            distributorAddress: params.distributorAddress ?? null,
            updatedAt: new Date(),
          },
        })
        .returning();
      if (!manifest) {
        throw new Error("upsertDistributionManifest: UPSERT returned no rows");
      }

      // Replace leaves wholesale — manifest is the unit of idempotency.
      await tx
        .delete(epochDistributionLeaves)
        .where(eq(epochDistributionLeaves.manifestId, manifest.id));

      if (params.leaves.length > 0) {
        await tx.insert(epochDistributionLeaves).values(
          params.leaves.map((leaf) => ({
            nodeId: params.nodeId,
            manifestId: manifest.id,
            epochId: params.epochId,
            leafIndex: leaf.index,
            claimantKey: leaf.claimantKey,
            account: leaf.account,
            accountLower: leaf.account.toLowerCase(),
            amount: leaf.amount,
            leafHash: leaf.leafHash,
            proofJson: [...leaf.proof],
          }))
        );
      }

      return toDistributionManifest(manifest);
    });
  }

  async getDistributionManifestForEpoch(
    epochId: bigint
  ): Promise<DistributionManifestRecord | null> {
    await this.resolveEpochScoped(epochId);
    const rows = await this.db
      .select()
      .from(epochDistributionManifests)
      .where(eq(epochDistributionManifests.epochId, epochId))
      .limit(1);
    return rows[0] ? toDistributionManifest(rows[0]) : null;
  }

  async getDistributionClaimForAccount(
    epochId: bigint,
    account: string
  ): Promise<DistributionClaimRecord | null> {
    await this.resolveEpochScoped(epochId);
    const [manifestRow] = await this.db
      .select()
      .from(epochDistributionManifests)
      .where(eq(epochDistributionManifests.epochId, epochId))
      .limit(1);
    if (!manifestRow) return null;

    const [leafRow] = await this.db
      .select()
      .from(epochDistributionLeaves)
      .where(
        and(
          eq(epochDistributionLeaves.manifestId, manifestRow.id),
          eq(epochDistributionLeaves.accountLower, account.toLowerCase())
        )
      )
      .limit(1);
    if (!leafRow) return null;

    return {
      epochId: manifestRow.epochId,
      merkleRoot: manifestRow.merkleRoot,
      distributorAddress: manifestRow.distributorAddress,
      chainId: Number(manifestRow.chainId),
      tokenAddress: manifestRow.tokenAddress,
      leaf: toDistributionLeaf(leafRow),
    };
  }

  async getDistributionLeavesForEpoch(
    epochId: bigint
  ): Promise<readonly DistributionLeafRecord[]> {
    await this.resolveEpochScoped(epochId);
    const [manifestRow] = await this.db
      .select()
      .from(epochDistributionManifests)
      .where(eq(epochDistributionManifests.epochId, epochId))
      .limit(1);
    if (!manifestRow) return [];

    const leafRows = await this.db
      .select()
      .from(epochDistributionLeaves)
      .where(eq(epochDistributionLeaves.manifestId, manifestRow.id));
    return leafRows.map(toDistributionLeaf);
  }

  // ── Atomic finalize ────────────────────────────────────────

  async finalizeEpochAtomic(params: {
    epochId: bigint;
    poolTotal: bigint;
    finalClaimantAllocations: readonly InsertFinalClaimantAllocationParams[];
    statement: Omit<InsertStatementParams, "epochId">;
    signature: Omit<InsertSignatureParams, "statementId">;
    expectedFinalAllocationSetHash: string;
  }): Promise<{ epoch: AttributionEpoch; statement: AttributionStatement }> {
    return await this.db.transaction(async (tx) => {
      // 1. Load epoch with scope gate + row lock (prevents concurrent override writes)
      const epochRows = await tx
        .select()
        .from(epochs)
        .where(
          and(eq(epochs.id, params.epochId), eq(epochs.scopeId, this.scopeId))
        )
        .limit(1)
        .for("update");
      if (!epochRows[0]) {
        throw new EpochNotFoundError(params.epochId.toString());
      }

      const epochRow = epochRows[0];
      const status = epochRow.status as string;

      if (status === "open") {
        throw new EpochNotOpenError(params.epochId.toString());
      }

      let finalEpochRow: typeof epochs.$inferSelect;

      if (status === "review") {
        // 2a. Transition review → finalized (re-check status in WHERE for concurrency guard)
        const [updated] = await tx
          .update(epochs)
          .set({
            status: "finalized",
            poolTotalCredits: params.poolTotal,
            closedAt: new Date(),
          })
          .where(
            and(
              eq(epochs.id, params.epochId),
              eq(epochs.scopeId, this.scopeId),
              eq(epochs.status, "review")
            )
          )
          .returning();

        if (!updated) {
          // Concurrent finalize won — reload
          const [reloaded] = await tx
            .select()
            .from(epochs)
            .where(
              and(
                eq(epochs.id, params.epochId),
                eq(epochs.scopeId, this.scopeId)
              )
            )
            .limit(1);
          if (!reloaded || reloaded.status !== "finalized") {
            throw new Error(
              `finalizeEpochAtomic: concurrent state change for epoch ${params.epochId.toString()}`
            );
          }
          finalEpochRow = reloaded;
        } else {
          finalEpochRow = updated;
        }
      } else if (status === "finalized") {
        finalEpochRow = epochRow;
      } else {
        throw new Error(
          `finalizeEpochAtomic: unexpected epoch status '${status}'`
        );
      }

      // 2b/3a. Upsert statement — ON CONFLICT (node_id, epoch_id) DO NOTHING
      await tx
        .insert(epochStatements)
        .values({
          nodeId: params.statement.nodeId,
          epochId: params.epochId,
          finalAllocationSetHash: params.statement.finalAllocationSetHash,
          poolTotalCredits: params.statement.poolTotalCredits,
          statementLinesJson: toStatementLinesJson(
            params.statement.statementLines
          ),
          reviewOverridesJson: params.statement.reviewOverrides
            ? toReviewOverridesJson(params.statement.reviewOverrides)
            : null,
          supersedesStatementId: params.statement.supersedesStatementId ?? null,
        })
        .onConflictDoNothing({
          target: [epochStatements.nodeId, epochStatements.epochId],
        });

      // Fetch the statement (either just inserted or previously existing)
      const [statementRow] = await tx
        .select()
        .from(epochStatements)
        .where(
          and(
            eq(epochStatements.nodeId, params.statement.nodeId),
            eq(epochStatements.epochId, params.epochId)
          )
        )
        .limit(1);

      if (!statementRow) {
        throw new Error(
          `finalizeEpochAtomic: statement insert/select failed for epoch ${params.epochId.toString()}`
        );
      }

      // Hash assertion — if statement pre-existed, verify hash matches
      if (
        statementRow.finalAllocationSetHash !==
        params.expectedFinalAllocationSetHash
      ) {
        throw new Error(
          `finalizeEpochAtomic: finalAllocationSetHash mismatch — expected ${params.expectedFinalAllocationSetHash}, found ${statementRow.finalAllocationSetHash}`
        );
      }

      for (const allocation of params.finalClaimantAllocations) {
        await tx
          .insert(epochFinalClaimantAllocations)
          .values({
            nodeId: allocation.nodeId,
            epochId: allocation.epochId,
            claimantKey: allocation.claimantKey,
            claimantJson: allocation.claimant,
            finalUnits: allocation.finalUnits,
            receiptIdsJson: [...allocation.receiptIds],
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              epochFinalClaimantAllocations.epochId,
              epochFinalClaimantAllocations.claimantKey,
            ],
            set: {
              claimantJson: allocation.claimant,
              finalUnits: allocation.finalUnits,
              receiptIdsJson: [...allocation.receiptIds],
              updatedAt: new Date(),
            },
          });
      }

      // 2d/3b. Upsert signature — ON CONFLICT (statement_id, signer_wallet) DO NOTHING
      await tx
        .insert(epochStatementSignatures)
        .values({
          nodeId: params.signature.nodeId,
          statementId: statementRow.id,
          signerWallet: params.signature.signerWallet,
          signature: params.signature.signature,
          signedAt: params.signature.signedAt,
        })
        .onConflictDoNothing({
          target: [
            epochStatementSignatures.statementId,
            epochStatementSignatures.signerWallet,
          ],
        });

      // 2e/3c. Verify signature — if row exists with DIFFERENT signature text, throw
      const [sigRow] = await tx
        .select()
        .from(epochStatementSignatures)
        .where(
          and(
            eq(epochStatementSignatures.statementId, statementRow.id),
            eq(
              epochStatementSignatures.signerWallet,
              params.signature.signerWallet
            )
          )
        )
        .limit(1);

      if (sigRow && sigRow.signature !== params.signature.signature) {
        throw new Error(
          `finalizeEpochAtomic: signature divergence — signer ${params.signature.signerWallet} has different signature on statement ${statementRow.id}`
        );
      }

      return {
        epoch: toEpoch(finalEpochRow),
        statement: toStatement(statementRow),
      };
    });
  }

  // ── Statement signatures ───────────────────────────────────

  async insertStatementSignature(params: InsertSignatureParams): Promise<void> {
    await this.db
      .insert(epochStatementSignatures)
      .values({
        nodeId: params.nodeId,
        statementId: params.statementId,
        signerWallet: params.signerWallet,
        signature: params.signature,
        signedAt: params.signedAt,
      })
      .onConflictDoNothing({
        target: [
          epochStatementSignatures.statementId,
          epochStatementSignatures.signerWallet,
        ],
      });
  }

  async getSignaturesForStatement(
    statementId: string
  ): Promise<AttributionStatementSignature[]> {
    const rows = await this.db
      .select()
      .from(epochStatementSignatures)
      .where(eq(epochStatementSignatures.statementId, statementId));
    return rows.map(toStatementSignature);
  }

  // ── Subject overrides ────────────────────────────────────────

  async upsertReviewSubjectOverride(
    params: UpsertReviewSubjectOverrideParams
  ): Promise<ReviewSubjectOverrideRecord> {
    return await this.db.transaction(async (tx) => {
      const epoch = await this.resolveEpochScopedForUpdate(params.epochId, tx);
      if (epoch.status !== "review") {
        throw new EpochNotInReviewError(
          params.epochId.toString(),
          epoch.status
        );
      }

      const now = new Date();
      const [row] = await tx
        .insert(epochReviewSubjectOverrides)
        .values({
          nodeId: params.nodeId,
          epochId: params.epochId,
          subjectRef: params.subjectRef,
          overrideUnits: params.overrideUnits ?? null,
          overrideSharesJson: params.overrideSharesJson ?? null,
          overrideReason: params.overrideReason ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            epochReviewSubjectOverrides.epochId,
            epochReviewSubjectOverrides.subjectRef,
          ],
          set: {
            overrideUnits: params.overrideUnits ?? null,
            overrideSharesJson: params.overrideSharesJson ?? null,
            overrideReason: params.overrideReason ?? null,
            updatedAt: now,
          },
        })
        .returning();
      if (!row)
        throw new Error(
          "upsertReviewSubjectOverride: INSERT/UPDATE returned no rows"
        );
      return toReviewSubjectOverride(row);
    });
  }

  async batchUpsertReviewSubjectOverrides(
    paramsList: readonly UpsertReviewSubjectOverrideParams[]
  ): Promise<ReviewSubjectOverrideRecord[]> {
    const firstParams = paramsList[0];
    if (!firstParams) return [];
    return await this.db.transaction(async (tx) => {
      // Lock once for the batch — all params share the same epochId
      const epoch = await this.resolveEpochScopedForUpdate(
        firstParams.epochId,
        tx
      );
      if (epoch.status !== "review") {
        throw new EpochNotInReviewError(
          firstParams.epochId.toString(),
          epoch.status
        );
      }

      const results: ReviewSubjectOverrideRecord[] = [];
      const now = new Date();
      for (const params of paramsList) {
        const [row] = await tx
          .insert(epochReviewSubjectOverrides)
          .values({
            nodeId: params.nodeId,
            epochId: params.epochId,
            subjectRef: params.subjectRef,
            overrideUnits: params.overrideUnits ?? null,
            overrideSharesJson: params.overrideSharesJson ?? null,
            overrideReason: params.overrideReason ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              epochReviewSubjectOverrides.epochId,
              epochReviewSubjectOverrides.subjectRef,
            ],
            set: {
              overrideUnits: params.overrideUnits ?? null,
              overrideSharesJson: params.overrideSharesJson ?? null,
              overrideReason: params.overrideReason ?? null,
              updatedAt: now,
            },
          })
          .returning();
        if (!row)
          throw new Error(
            "batchUpsertReviewSubjectOverrides: INSERT/UPDATE returned no rows"
          );
        results.push(toReviewSubjectOverride(row));
      }
      return results;
    });
  }

  async deleteReviewSubjectOverride(
    epochId: bigint,
    subjectRef: string
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const epoch = await this.resolveEpochScopedForUpdate(epochId, tx);
      if (epoch.status !== "review") {
        throw new EpochNotInReviewError(epochId.toString(), epoch.status);
      }
      await tx
        .delete(epochReviewSubjectOverrides)
        .where(
          and(
            eq(epochReviewSubjectOverrides.epochId, epochId),
            eq(epochReviewSubjectOverrides.subjectRef, subjectRef)
          )
        );
    });
  }

  async getReviewSubjectOverridesForEpoch(
    epochId: bigint
  ): Promise<ReviewSubjectOverrideRecord[]> {
    await this.resolveEpochScoped(epochId);
    const rows = await this.db
      .select()
      .from(epochReviewSubjectOverrides)
      .where(eq(epochReviewSubjectOverrides.epochId, epochId))
      .orderBy(epochReviewSubjectOverrides.subjectRef);
    return rows.map(toReviewSubjectOverride);
  }

  // ── Identity resolution ───────────────────────────────────────

  async resolveIdentities(
    provider: "github",
    externalIds: string[]
  ): Promise<Map<string, string>> {
    if (externalIds.length === 0) return new Map();
    const uniqueIds = [...new Set(externalIds)];
    const rows = await this.db
      .select({
        externalId: userBindings.externalId,
        userId: userBindings.userId,
      })
      .from(userBindings)
      .where(
        and(
          eq(userBindings.provider, provider),
          inArray(userBindings.externalId, uniqueIds)
        )
      );
    return new Map(rows.map((r) => [r.externalId, r.userId]));
  }

  async getUserDisplayNames(userIds: string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const uniqueIds = [...new Set(userIds)];

    const [profiles, bindings] = await Promise.all([
      this.db
        .select({
          userId: userProfiles.userId,
          displayName: userProfiles.displayName,
        })
        .from(userProfiles)
        .where(
          and(
            inArray(userProfiles.userId, uniqueIds),
            isNotNull(userProfiles.displayName)
          )
        ),
      this.db
        .select({
          userId: userBindings.userId,
          providerLogin: userBindings.providerLogin,
        })
        .from(userBindings)
        .where(
          and(
            inArray(userBindings.userId, uniqueIds),
            isNotNull(userBindings.providerLogin)
          )
        ),
    ]);

    const names = new Map<string, string>();
    for (const row of profiles) {
      if (row.displayName) {
        names.set(row.userId, row.displayName);
      }
    }
    for (const row of bindings) {
      if (!names.has(row.userId) && row.providerLogin) {
        names.set(row.userId, row.providerLogin);
      }
    }

    return names;
  }

  async getSelectionCandidates(
    nodeId: string,
    epochId: bigint
  ): Promise<UnselectedReceipt[]> {
    await this.resolveEpochScoped(epochId);
    const rows = await this.db
      .select({
        receipt: ingestionReceipts,
        selectionId: epochSelection.id,
      })
      .from(ingestionReceipts)
      .leftJoin(
        epochSelection,
        and(
          eq(epochSelection.epochId, epochId),
          eq(epochSelection.receiptId, ingestionReceipts.receiptId)
        )
      )
      .where(
        and(
          eq(ingestionReceipts.nodeId, nodeId),
          or(
            isNull(epochSelection.id), // no selection row for this epoch
            isNull(epochSelection.userId) // selection exists but unresolved
          ),
          // Exclude receipts already selected in prior same-scope epochs.
          // RECEIPT_SCOPE_AGNOSTIC: cross-scope selection preserved — filter is same-scope only.
          sql`NOT EXISTS (
            SELECT 1 FROM epoch_selection es_prior
            JOIN epochs e_prior ON e_prior.id = es_prior.epoch_id
            WHERE es_prior.receipt_id = ${ingestionReceipts.receiptId}
              AND e_prior.node_id = ${nodeId}
              AND e_prior.scope_id = ${this.scopeId}
              AND es_prior.epoch_id != ${epochId}
          )`
        )
      )
      .orderBy(ingestionReceipts.eventTime);
    return rows.map((r) => ({
      receipt: toIngestionReceipt(r.receipt),
      hasExistingSelection: r.selectionId !== null,
    }));
  }

  async updateSelectionUserId(
    epochId: bigint,
    receiptId: string,
    userId: string
  ): Promise<void> {
    await this.resolveEpochScoped(epochId);
    await this.db
      .update(epochSelection)
      .set({ userId, updatedAt: new Date() })
      .where(
        and(
          eq(epochSelection.epochId, epochId),
          eq(epochSelection.receiptId, receiptId),
          isNull(epochSelection.userId)
        )
      );
  }

  async updateSelectionIncluded(
    epochId: bigint,
    receiptId: string,
    included: boolean
  ): Promise<void> {
    await this.validateEpochIds([epochId]);
    await this.db
      .update(epochSelection)
      .set({ included, updatedAt: new Date() })
      .where(
        and(
          eq(epochSelection.epochId, epochId),
          eq(epochSelection.receiptId, receiptId)
        )
      );
  }

  // -------------------------------------------------------------------------
  // Receipt claimants
  // -------------------------------------------------------------------------

  async upsertDraftClaimants(
    params: InsertReceiptClaimantsParams
  ): Promise<void> {
    await this.db
      .insert(epochReceiptClaimants)
      .values({
        nodeId: params.nodeId,
        epochId: params.epochId,
        receiptId: params.receiptId,
        status: "draft",
        resolverRef: params.resolverRef,
        algoRef: params.algoRef,
        inputsHash: params.inputsHash,
        claimantsJson: [...params.claimantKeys],
        createdBy: params.createdBy,
      })
      .onConflictDoUpdate({
        target: [
          epochReceiptClaimants.nodeId,
          epochReceiptClaimants.epochId,
          epochReceiptClaimants.receiptId,
        ],
        targetWhere: sql`${epochReceiptClaimants.status} = 'draft'`,
        set: {
          resolverRef: params.resolverRef,
          algoRef: params.algoRef,
          inputsHash: params.inputsHash,
          claimantsJson: [...params.claimantKeys],
          createdBy: params.createdBy,
        },
      });
  }

  async lockClaimantsForEpoch(epochId: bigint): Promise<number> {
    await this.resolveEpochScoped(epochId);

    const updated = await this.db
      .update(epochReceiptClaimants)
      .set({ status: "locked" })
      .where(
        and(
          eq(epochReceiptClaimants.epochId, epochId),
          eq(epochReceiptClaimants.status, "draft")
        )
      )
      .returning({ id: epochReceiptClaimants.id });

    return updated.length;
  }

  async loadLockedClaimants(
    epochId: bigint
  ): Promise<ReceiptClaimantsRecord[]> {
    await this.resolveEpochScoped(epochId);

    const rows = await this.db
      .select()
      .from(epochReceiptClaimants)
      .where(
        and(
          eq(epochReceiptClaimants.epochId, epochId),
          eq(epochReceiptClaimants.status, "locked")
        )
      );

    return rows.map((row) => ({
      id: row.id,
      nodeId: row.nodeId,
      epochId: row.epochId,
      receiptId: row.receiptId,
      status: row.status as "locked",
      resolverRef: row.resolverRef,
      algoRef: row.algoRef,
      inputsHash: row.inputsHash,
      claimantKeys: row.claimantsJson ?? [],
      createdAt: row.createdAt,
      createdBy: row.createdBy,
    }));
  }
}
