// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-ledger/store`
 * Purpose: Port interface for the epoch ledger store. Shared by app and scheduler-worker.
 * Scope: Type definitions only. Does not contain implementations or I/O.
 * Invariants:
 * - RECEIPT_APPEND_ONLY: insertIngestionReceipts never updates existing rows.
 * - SELECTION_FREEZE_ON_FINALIZE: upsertSelection rejects writes when epoch is finalized.
 * - SELECTION_AUTO_POPULATE: insertSelectionDoNothing + updateSelectionUserId never overwrite admin-set fields.
 * - IDENTITY_BEST_EFFORT: resolveIdentities is best-effort; unresolved receipts get userId=null.
 * - ONE_OPEN_EPOCH: createEpoch enforced by DB constraint.
 * - NODE_SCOPED: all operations are scoped to a node_id.
 * - RECEIPT_SCOPE_AGNOSTIC: receipts carry no scope_id; scope assigned at selection via epoch membership.
 * - EVALUATION_FINAL_ATOMIC: locked evaluation writes + artifacts_hash + epoch open→review in one transaction.
 * - EPOCH_CLOSE_ON_TRANSITION: transitionEpochForWindow closes stale open epoch + creates new epoch atomically. No grace period.
 * - STATEMENT_FROM_FINAL_ONLY: allocation for statements consumes only status='locked' evaluations and claimant records.
 * - CLAIMANT_RESOLUTION_REQUIRED: upsertDraftClaimants, lockClaimantsForEpoch, loadLockedClaimants manage the epoch_receipt_claimants lifecycle.
 * - SELECTION_POLICY_AUTHORITY: getSelectionCandidates excludes receipts already selected in prior same-scope epochs but has no time-window filter — the selection policy decides epoch membership within remaining candidates.
 * Side-effects: none
 * Links: docs/spec/attribution-ledger.md
 * @public
 */

import type { SelectedReceiptForAllocation } from "./allocation";
import type {
  AttributionClaimant,
  ClaimantShare,
  ReviewOverrideSnapshot,
  SelectedReceiptForAttribution,
  SubjectOverride,
} from "./claimant-shares";
import type { EpochStatus } from "./model";

// ---------------------------------------------------------------------------
// Domain record types (read-side)
// ---------------------------------------------------------------------------

export interface AttributionEpoch {
  readonly id: bigint;
  readonly nodeId: string;
  readonly scopeId: string;
  readonly status: EpochStatus;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly weightConfig: Record<string, number>;
  readonly poolTotalCredits: bigint | null;
  readonly approverSetHash: string | null;
  readonly approvers: readonly string[] | null;
  readonly allocationAlgoRef: string | null;
  readonly weightConfigHash: string | null;
  readonly artifactsHash: string | null;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly createdAt: Date;
}

export interface IngestionReceipt {
  readonly receiptId: string;
  readonly nodeId: string;
  readonly source: string;
  readonly eventType: string;
  readonly platformUserId: string;
  readonly platformLogin: string | null;
  readonly artifactUrl: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly payloadHash: string;
  readonly producer: string;
  readonly producerVersion: string;
  readonly eventTime: Date;
  readonly retrievedAt: Date;
  readonly ingestedAt: Date;
}

export interface AttributionSelection {
  readonly id: string;
  readonly nodeId: string;
  readonly epochId: bigint;
  readonly receiptId: string;
  readonly userId: string | null;
  readonly included: boolean;
  readonly weightOverrideMilli: bigint | null;
  readonly note: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface EpochUserProjection {
  readonly id: string;
  readonly nodeId: string;
  readonly epochId: bigint;
  readonly userId: string;
  readonly projectedUnits: bigint;
  readonly receiptCount: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface FinalClaimantAllocationRecord {
  readonly id: string;
  readonly nodeId: string;
  readonly epochId: bigint;
  readonly claimantKey: string;
  readonly claimant: AttributionClaimant;
  readonly finalUnits: bigint;
  readonly receiptIds: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface IngestionCursor {
  readonly nodeId: string;
  readonly scopeId: string;
  readonly source: string;
  readonly stream: string;
  readonly sourceRef: string;
  readonly cursorValue: string;
  readonly retrievedAt: Date;
}

export interface AttributionPoolComponent {
  readonly id: string;
  readonly nodeId: string;
  readonly epochId: bigint;
  readonly componentId: string;
  readonly algorithmVersion: string;
  readonly inputsJson: Record<string, unknown>;
  readonly amountCredits: bigint;
  readonly evidenceRef: string | null;
  readonly computedAt: Date;
}

export interface AttributionStatement {
  readonly id: string;
  readonly nodeId: string;
  readonly epochId: bigint;
  readonly finalAllocationSetHash: string;
  readonly poolTotalCredits: bigint;
  readonly statementLines: AttributionStatementLineRecord[];
  readonly reviewOverrides: ReviewOverrideSnapshot[] | null;
  readonly supersedesStatementId: string | null;
  readonly createdAt: Date;
}

export interface AttributionStatementLineRecord {
  readonly claimant_key: string;
  readonly claimant: AttributionClaimant;
  readonly final_units: string;
  readonly pool_share: string;
  readonly credit_amount: string;
  readonly receipt_ids: readonly string[];
}

export interface AttributionStatementSignature {
  readonly id: string;
  readonly nodeId: string;
  readonly statementId: string;
  readonly signerWallet: string;
  readonly signature: string;
  readonly signedAt: Date;
}

export interface AttributionEvaluation {
  readonly id: string;
  readonly nodeId: string;
  readonly epochId: bigint;
  readonly evaluationRef: string;
  readonly status: "draft" | "locked";
  readonly algoRef: string;
  readonly inputsHash: string;
  readonly payloadHash: string;
  readonly payloadJson: Record<string, unknown> | null;
  readonly payloadRef: string | null;
  readonly createdAt: Date;
}

/** Selected receipt with raw receipt metadata, for enricher consumption. */
export interface SelectedReceiptWithMetadata
  extends SelectedReceiptForAllocation {
  readonly metadata: Record<string, unknown> | null;
  readonly payloadHash: string;
}

// ---------------------------------------------------------------------------
// Write-side parameter types
// ---------------------------------------------------------------------------

export interface InsertReceiptParams {
  readonly receiptId: string;
  readonly nodeId: string;
  readonly source: string;
  readonly eventType: string;
  readonly platformUserId: string;
  readonly platformLogin?: string | null;
  readonly artifactUrl?: string | null;
  readonly metadata?: Record<string, unknown> | null;
  readonly payloadHash: string;
  readonly producer: string;
  readonly producerVersion: string;
  readonly eventTime: Date;
  readonly retrievedAt: Date;
}

export interface UpsertSelectionParams {
  readonly nodeId: string;
  readonly epochId: bigint;
  readonly receiptId: string;
  readonly userId?: string | null;
  readonly included?: boolean;
  readonly weightOverrideMilli?: bigint | null;
  readonly note?: string | null;
}

export interface InsertUserProjectionParams {
  readonly nodeId: string;
  readonly epochId: bigint;
  readonly userId: string;
  readonly projectedUnits: bigint;
  readonly receiptCount: number;
}

export interface InsertFinalClaimantAllocationParams {
  readonly nodeId: string;
  readonly epochId: bigint;
  readonly claimantKey: string;
  readonly claimant: AttributionClaimant;
  readonly finalUnits: bigint;
  readonly receiptIds: readonly string[];
}

export interface InsertPoolComponentParams {
  readonly nodeId: string;
  readonly epochId: bigint;
  readonly componentId: string;
  readonly algorithmVersion: string;
  readonly inputsJson: Record<string, unknown>;
  readonly amountCredits: bigint;
  readonly evidenceRef?: string | null;
}

export interface InsertStatementParams {
  readonly nodeId: string;
  readonly epochId: bigint;
  readonly finalAllocationSetHash: string;
  readonly poolTotalCredits: bigint;
  readonly statementLines: AttributionStatementLineRecord[];
  readonly reviewOverrides?: ReviewOverrideSnapshot[] | null;
  readonly supersedesStatementId?: string | null;
}

export interface InsertSignatureParams {
  readonly nodeId: string;
  readonly statementId: string;
  readonly signerWallet: string;
  readonly signature: string;
  readonly signedAt: Date;
}

export interface UpsertEvaluationParams {
  readonly nodeId: string;
  readonly epochId: bigint;
  readonly evaluationRef: string;
  readonly status: "draft" | "locked";
  readonly algoRef: string;
  readonly inputsHash: string;
  readonly payloadHash: string;
  readonly payloadJson: Record<string, unknown>;
}

export interface CloseIngestionWithEvaluationsParams {
  readonly epochId: bigint;
  readonly approvers: string[];
  readonly approverSetHash: string;
  readonly allocationAlgoRef: string;
  readonly weightConfigHash: string;
  readonly evaluations: ReadonlyArray<UpsertEvaluationParams>;
  readonly artifactsHash: string;
}

/** Params for the atomic epoch transition: close stale open epoch + create epoch for a new window. */
export interface TransitionEpochForWindowParams {
  readonly nodeId: string;
  readonly scopeId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly weightConfig: Record<string, number>;
  /** Close payload for the stale epoch. Always required — this method is only called when a stale epoch exists. */
  readonly closeParams: CloseIngestionWithEvaluationsParams;
}

/** Result from transitionEpochForWindow. */
export interface TransitionEpochForWindowResult {
  readonly epoch: AttributionEpoch;
  readonly isNew: boolean;
  /** ID of the stale epoch that was closed during this transition. */
  readonly closedStaleEpochId: bigint;
}

/**
 * Narrowed params for auto-population INSERT (SELECTION_AUTO_POPULATE).
 * Intentionally excludes weightOverrideMilli and note to prevent accidental overwrites.
 */
export interface InsertSelectionAutoParams {
  readonly nodeId: string;
  readonly epochId: bigint;
  readonly receiptId: string;
  readonly userId: string | null;
  readonly included: boolean;
}

// ---------------------------------------------------------------------------
// Subject override types
// ---------------------------------------------------------------------------

export interface ReviewSubjectOverrideRecord {
  readonly id: string;
  readonly nodeId: string;
  readonly epochId: bigint;
  readonly subjectRef: string;
  readonly overrideUnits: bigint | null;
  readonly overrideSharesJson: ClaimantShare[] | null;
  readonly overrideReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UpsertReviewSubjectOverrideParams {
  readonly nodeId: string;
  readonly epochId: bigint;
  readonly subjectRef: string;
  readonly overrideUnits?: bigint | null;
  readonly overrideSharesJson?: ClaimantShare[] | null;
  readonly overrideReason?: string | null;
}

/**
 * Convert store records to pure domain SubjectOverride[].
 * Use this instead of inline .map() — keeps the mapping in one place.
 */
export function toReviewSubjectOverrides(
  records: readonly ReviewSubjectOverrideRecord[]
): SubjectOverride[] {
  return records.map((r) => ({
    subjectRef: r.subjectRef,
    overrideUnits: r.overrideUnits,
    overrideShares: r.overrideSharesJson,
    overrideReason: r.overrideReason,
  }));
}

// ---------------------------------------------------------------------------
// Receipt claimants types
// ---------------------------------------------------------------------------

export interface ReceiptClaimantsRecord {
  readonly id: string;
  readonly nodeId: string;
  readonly epochId: bigint;
  readonly receiptId: string;
  readonly status: "draft" | "locked";
  readonly resolverRef: string;
  readonly algoRef: string;
  readonly inputsHash: string;
  readonly claimantKeys: readonly string[];
  readonly createdAt: Date;
  readonly createdBy: string | null;
}

export interface InsertReceiptClaimantsParams {
  readonly nodeId: string;
  readonly epochId: bigint;
  readonly receiptId: string;
  readonly resolverRef: string;
  readonly algoRef: string;
  readonly inputsHash: string;
  readonly claimantKeys: readonly string[];
  readonly createdBy: string | null;
}

// ---------------------------------------------------------------------------
// Distribution manifest types (DAO token merkle claim persistence)
// ---------------------------------------------------------------------------

/**
 * A single persisted merkle leaf + proof for one claimant account.
 * Mirrors the claim-relevant subset of `DaoTokenMerkleLeaf` from
 * `@cogni/aragon-osx/token-distribution` — index, account, amount, proof.
 */
export interface DistributionLeafRecord {
  readonly index: number;
  readonly claimantKey: string;
  readonly account: string;
  readonly amount: bigint;
  readonly leafHash: string;
  readonly proof: readonly string[];
}

/**
 * Persisted `DaoTokenMerkleDistribution` header — the manifest minus the leaves.
 * `distributorAddress` is null until the on-chain MerkleDistributor is deployed.
 */
export interface DistributionManifestRecord {
  readonly id: string;
  readonly nodeId: string;
  readonly scopeId: string;
  readonly epochId: bigint;
  readonly distributionId: string;
  readonly statementHash: string;
  readonly merkleRoot: string;
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly distributionAmount: bigint;
  readonly totalAllocated: bigint;
  readonly distributorAddress: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A single claimant's leaf joined with its manifest's claim parameters. */
export interface DistributionClaimRecord {
  readonly epochId: bigint;
  readonly merkleRoot: string;
  readonly distributorAddress: string | null;
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly leaf: DistributionLeafRecord;
}

export interface InsertDistributionManifestParams {
  readonly nodeId: string;
  readonly scopeId: string;
  readonly epochId: bigint;
  readonly distributionId: string;
  readonly statementHash: string;
  readonly merkleRoot: string;
  readonly chainId: number;
  readonly tokenAddress: string;
  readonly distributionAmount: bigint;
  readonly totalAllocated: bigint;
  readonly distributorAddress?: string | null;
  readonly leaves: readonly DistributionLeafRecord[];
}

/**
 * Persistence + read surface for the DAO token merkle distribution manifest.
 * Write the manifest (header + leaves) and read one claimant's leaf+proof.
 * DISTRIBUTION_READ_WRITE_ONLY: this store only persists and serves the
 * manifest — it never builds the merkle tree (that is the distribution service).
 */
export interface DistributionManifestStore {
  /**
   * Upsert a manifest + its leaves atomically (ON CONFLICT on the
   * (node_id, scope_id, epoch_id) unique key — replaces existing leaves).
   * Returns the persisted manifest header.
   */
  upsertDistributionManifest(
    params: InsertDistributionManifestParams
  ): Promise<DistributionManifestRecord>;

  /** Read the manifest header for an epoch (null if none persisted). */
  getDistributionManifestForEpoch(
    epochId: bigint
  ): Promise<DistributionManifestRecord | null>;

  /**
   * Read one claimant's leaf + proof for an epoch, by account address
   * (case-insensitive). Returns null if the epoch has no manifest or the
   * account has no leaf in it.
   */
  getDistributionClaimForAccount(
    epochId: bigint,
    account: string
  ): Promise<DistributionClaimRecord | null>;

  /**
   * Read ALL persisted leaves for an epoch's manifest (empty if no manifest).
   * Used to read the prior cumulative balances (per-account `amount`) when
   * folding the next epoch's deltas into a new cumulative root (R3).
   */
  getDistributionLeavesForEpoch(
    epochId: bigint
  ): Promise<readonly DistributionLeafRecord[]>;
}

// ---------------------------------------------------------------------------
// Identity resolution types
// ---------------------------------------------------------------------------

/**
 * A receipt that needs selection work — either no selection row exists,
 * or the selection row has user_id IS NULL (unresolved).
 */
export interface UnselectedReceipt {
  readonly receipt: IngestionReceipt;
  /** true = selection row exists with userId=NULL; false = no selection row */
  readonly hasExistingSelection: boolean;
}

// ---------------------------------------------------------------------------
// Port sub-interfaces
// ---------------------------------------------------------------------------

export interface EpochReader {
  getOpenEpoch(
    nodeId: string,
    scopeId: string
  ): Promise<AttributionEpoch | null>;
  getEpochByWindow(
    nodeId: string,
    scopeId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<AttributionEpoch | null>;
  getEpoch(id: bigint): Promise<AttributionEpoch | null>;
  listEpochs(nodeId: string): Promise<AttributionEpoch[]>;
}

export interface EpochWriter {
  createEpoch(params: {
    nodeId: string;
    scopeId: string;
    periodStart: Date;
    periodEnd: Date;
    weightConfig: Record<string, number>;
  }): Promise<AttributionEpoch>;

  /** Transition epoch open → review (INGESTION_STOPS_AT_REVIEW).
   *  Pins approvers, approverSetHash, allocationAlgoRef, and weightConfigHash. */
  closeIngestion(
    epochId: bigint,
    approvers: string[],
    approverSetHash: string,
    allocationAlgoRef: string,
    weightConfigHash: string
  ): Promise<AttributionEpoch>;

  /** Transition epoch review → finalized. Sets poolTotalCredits and closedAt. */
  finalizeEpoch(epochId: bigint, poolTotal: bigint): Promise<AttributionEpoch>;

  /** Transition epoch open → review with locked evaluations in a single transaction (EVALUATION_FINAL_ATOMIC).
   *  Inserts locked evaluations + sets artifacts_hash + pins approverSetHash, allocationAlgoRef, weightConfigHash.
   *  Rejects if epoch is not open. */
  closeIngestionWithEvaluations(
    params: CloseIngestionWithEvaluationsParams
  ): Promise<AttributionEpoch>;

  /**
   * Atomic epoch transition: close stale open epoch + create epoch for a new window.
   * Single DB transaction eliminates race window between close and create.
   * Only called when findStaleOpenEpoch detected a stale epoch blocking the new window.
   *
   * Behavior:
   * - If an epoch already exists for this window → return it (idempotent rerun).
   * - Otherwise → close stale epoch (open → review) + create new epoch, atomically.
   *
   * Invariants: ONE_OPEN_EPOCH, EPOCH_WINDOW_UNIQUE, EVALUATION_FINAL_ATOMIC.
   */
  transitionEpochForWindow(
    params: TransitionEpochForWindowParams
  ): Promise<TransitionEpochForWindowResult>;

  /**
   * Atomic finalize: epoch transition + statement upsert + signature upsert in one DB transaction.
   * Handles all states:
   * - review → finalized: insert statement + signature, return both
   * - already finalized: repair missing statement/signature, assert hash match
   * - open or missing: throw domain error
   * Uses ON CONFLICT for retry safety.
   */
  finalizeEpochAtomic(params: {
    epochId: bigint;
    poolTotal: bigint;
    finalClaimantAllocations: readonly InsertFinalClaimantAllocationParams[];
    statement: Omit<InsertStatementParams, "epochId">;
    signature: Omit<InsertSignatureParams, "statementId">;
    expectedFinalAllocationSetHash: string;
  }): Promise<{ epoch: AttributionEpoch; statement: AttributionStatement }>;
}

export interface ReceiptStore {
  insertIngestionReceipts(receipts: InsertReceiptParams[]): Promise<void>;
  getReceiptsForWindow(
    nodeId: string,
    since: Date,
    until: Date
  ): Promise<IngestionReceipt[]>;
  /** Return all receipts for a node regardless of time window. Used for cross-epoch promotion matching. */
  getAllReceipts(nodeId: string): Promise<IngestionReceipt[]>;
  /** Return all receipts that have a selection row for the given epoch (includes cross-epoch). */
  getReceiptsForEpoch(
    nodeId: string,
    epochId: bigint
  ): Promise<IngestionReceipt[]>;
}

/** Read-only selection queries — safe for enrichers and allocation consumers. */
export interface SelectionReader {
  /**
   * Returns selected receipts with resolved user IDs for allocation computation.
   * Joined query: epoch_selection JOIN ingestion_receipts, filtered to userId IS NOT NULL.
   */
  getSelectedReceiptsForAllocation(
    epochId: bigint
  ): Promise<SelectedReceiptForAllocation[]>;

  /** Get selected receipts with raw metadata and payload hash for enricher consumption. */
  getSelectedReceiptsWithMetadata(
    epochId: bigint
  ): Promise<SelectedReceiptWithMetadata[]>;

  /** Get selected receipts including unresolved platform identities for canonical attribution construction. */
  getSelectedReceiptsForAttribution(
    epochId: bigint
  ): Promise<SelectedReceiptForAttribution[]>;

  getSelectionForEpoch(epochId: bigint): Promise<AttributionSelection[]>;
  getUnresolvedSelection(epochId: bigint): Promise<AttributionSelection[]>;
}

/** Selection writes + identity materialization — used by activities, not enrichers. */
export interface SelectionWriter {
  upsertSelection(params: UpsertSelectionParams[]): Promise<void>;

  /**
   * Insert selection rows with ON CONFLICT DO NOTHING semantics.
   * Used by auto-population (SELECTION_AUTO_POPULATE) to avoid overwriting
   * admin-set fields if a row is created between getSelectionCandidates and insert.
   */
  insertSelectionDoNothing(params: InsertSelectionAutoParams[]): Promise<void>;

  /**
   * Returns receipts that need selection work for the given epoch:
   * - No selection row exists (new receipts)
   * - Selection row exists but user_id IS NULL (unresolved)
   * No time-window filter — the selection policy decides what belongs in the epoch.
   */
  getSelectionCandidates(
    nodeId: string,
    epochId: bigint
  ): Promise<UnselectedReceipt[]>;

  /**
   * Update user_id on a selection row ONLY when existing user_id IS NULL.
   * Never touches included, weight_override_milli, or note (SELECTION_AUTO_POPULATE).
   */
  updateSelectionUserId(
    epochId: bigint,
    receiptId: string,
    userId: string
  ): Promise<void>;

  /** Update ONLY the policy-owned `included` flag on an existing selection row. Never touches userId/weight/note (SELECTION_AUTO_POPULATE). No-op if no row exists. */
  updateSelectionIncluded(
    epochId: bigint,
    receiptId: string,
    included: boolean
  ): Promise<void>;
}

/** Full selection surface — combines read and write. */
export interface SelectionStore extends SelectionReader, SelectionWriter {}

export interface EvaluationStore {
  /** Upsert draft evaluation — overwrites on (epoch_id, evaluation_ref, status='draft'). */
  upsertDraftEvaluation(params: UpsertEvaluationParams): Promise<void>;

  /** Get all evaluations for an epoch, optionally filtered by status. */
  getEvaluationsForEpoch(
    epochId: bigint,
    status?: "draft" | "locked"
  ): Promise<AttributionEvaluation[]>;

  /** Get single evaluation by ref and optional status. */
  getEvaluation(
    epochId: bigint,
    evaluationRef: string,
    status?: "draft" | "locked"
  ): Promise<AttributionEvaluation | null>;
}

export interface ProjectionStore {
  insertUserProjections(
    projections: InsertUserProjectionParams[]
  ): Promise<void>;

  /**
   * Upsert user projections — ON CONFLICT (epoch_id, user_id) UPDATE projected_units and receipt_count.
   */
  upsertUserProjections(
    projections: InsertUserProjectionParams[]
  ): Promise<void>;

  /**
   * Delete projection rows where user_id NOT IN activeUserIds.
   */
  deleteStaleUserProjections(
    epochId: bigint,
    activeUserIds: string[]
  ): Promise<void>;
  getUserProjectionsForEpoch(epochId: bigint): Promise<EpochUserProjection[]>;
}

export interface ClaimantStore {
  /** Upsert a draft claimant row. ON CONFLICT (draft_uniq) → UPDATE. */
  upsertDraftClaimants(params: InsertReceiptClaimantsParams): Promise<void>;

  /** Lock all draft claimant rows for an epoch. Returns count locked. */
  lockClaimantsForEpoch(epochId: bigint): Promise<number>;

  /** Load all locked claimant rows for an epoch. */
  loadLockedClaimants(epochId: bigint): Promise<ReceiptClaimantsRecord[]>;
}

export interface CursorStore {
  upsertCursor(
    nodeId: string,
    scopeId: string,
    source: string,
    stream: string,
    sourceRef: string,
    cursorValue: string
  ): Promise<void>;
  getCursor(
    nodeId: string,
    scopeId: string,
    source: string,
    stream: string,
    sourceRef: string
  ): Promise<IngestionCursor | null>;
}

/** Result of an idempotent pool component insert (ON CONFLICT DO NOTHING). */
export interface PoolComponentInsertResult {
  component: AttributionPoolComponent;
  /** true if a new row was inserted; false if the component already existed. */
  created: boolean;
}

export interface PoolStore {
  insertPoolComponent(
    params: InsertPoolComponentParams
  ): Promise<PoolComponentInsertResult>;
  getPoolComponentsForEpoch(
    epochId: bigint
  ): Promise<AttributionPoolComponent[]>;
}

export interface StatementStore {
  insertEpochStatement(
    params: InsertStatementParams
  ): Promise<AttributionStatement>;
  getStatementForEpoch(epochId: bigint): Promise<AttributionStatement | null>;
  insertStatementSignature(params: InsertSignatureParams): Promise<void>;
  getSignaturesForStatement(
    statementId: string
  ): Promise<AttributionStatementSignature[]>;
}

export interface OverrideStore {
  /** Upsert a subject override. Acquires epoch row lock and verifies status='review'. */
  upsertReviewSubjectOverride(
    params: UpsertReviewSubjectOverrideParams
  ): Promise<ReviewSubjectOverrideRecord>;

  /** Atomically upsert multiple subject overrides in a single transaction. */
  batchUpsertReviewSubjectOverrides(
    paramsList: readonly UpsertReviewSubjectOverrideParams[]
  ): Promise<ReviewSubjectOverrideRecord[]>;

  /** Delete a subject override by epoch + subjectRef. */
  deleteReviewSubjectOverride(
    epochId: bigint,
    subjectRef: string
  ): Promise<void>;

  /** Get all subject overrides for an epoch. */
  getReviewSubjectOverridesForEpoch(
    epochId: bigint
  ): Promise<ReviewSubjectOverrideRecord[]>;
}

export interface FinalAllocationStore {
  replaceFinalClaimantAllocations(
    epochId: bigint,
    allocations: readonly InsertFinalClaimantAllocationParams[]
  ): Promise<void>;
  getFinalClaimantAllocationsForEpoch(
    epochId: bigint
  ): Promise<FinalClaimantAllocationRecord[]>;
}

export interface IdentityResolver {
  /**
   * Resolves platform IDs to user UUIDs via user_bindings.
   * V0: GitHub only. Extend provider union for discord etc.
   */
  resolveIdentities(
    provider: "github",
    externalIds: string[]
  ): Promise<Map<string, string>>;

  /**
   * Resolves current public-facing display names for linked users.
   * Fallback policy is implementation-defined, but must never expose raw user IDs.
   */
  getUserDisplayNames(userIds: string[]): Promise<Map<string, string>>;
}

// ---------------------------------------------------------------------------
// Composed port interface
// ---------------------------------------------------------------------------

export interface AttributionStore
  extends EpochReader,
    EpochWriter,
    ReceiptStore,
    SelectionStore,
    EvaluationStore,
    ProjectionStore,
    ClaimantStore,
    CursorStore,
    PoolStore,
    StatementStore,
    OverrideStore,
    FinalAllocationStore,
    DistributionManifestStore,
    IdentityResolver {}
