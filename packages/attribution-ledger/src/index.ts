// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-ledger`
 * Purpose: Pure domain logic for the epoch ledger — shared between app and scheduler-worker.
 * Scope: Re-exports model types, payout computation, hashing, store port, and errors. Does not contain I/O or infrastructure code.
 * Invariants: No imports from src/ or services/. Pure domain logic only.
 * Side-effects: none
 * Links: docs/spec/attribution-ledger.md
 * @public
 */

// Allocation algorithm framework (pure, deterministic)
export {
  computeProposedAllocations,
  computeReceiptWeights,
  deriveAllocationAlgoRef,
  type ProposedAllocation,
  type ReceiptForWeighting,
  type ReceiptUnitWeight,
  type SelectedReceiptForAllocation,
  validateWeightConfig,
} from "./allocation";

// Evaluation envelope validation
export {
  validateEvaluationEnvelope,
  validateEvaluationRef,
} from "./artifact-envelope";
// Claimant types, receipt-weight pipeline, and statement computation
export {
  type AttributionClaimant,
  type AttributionStatementLine,
  applyReceiptWeightOverrides,
  buildReceiptWeightOverrideSnapshots,
  CLAIMANT_SHARE_DENOMINATOR_PPM,
  CLAIMANT_SHARES_ALGO_REF,
  CLAIMANT_SHARES_EVALUATION_REF,
  type ClaimantShare,
  claimantKey,
  computeAttributionStatementLines,
  explodeToClaimants,
  type FinalClaimantAllocation,
  type ReviewOverrideSnapshot,
  type SelectedReceiptForAttribution,
  type SubjectOverride,
} from "./claimant-shares";
// Enricher inputs hash
export { computeEnricherInputsHash } from "./enricher-inputs";

// Epoch window computation (pure, deterministic — safe in Temporal workflow code)
export {
  computeEpochWindowV1,
  type EpochWindow,
  type EpochWindowParams,
} from "./epoch-window";

// Errors
export {
  AllocationNotFoundError,
  EpochAlreadyFinalizedError,
  EpochNotFoundError,
  EpochNotInReviewError,
  EpochNotOpenError,
  isAllocationNotFoundError,
  isEpochAlreadyFinalizedError,
  isEpochNotFoundError,
  isEpochNotInReviewError,
  isEpochNotOpenError,
  isPoolComponentMissingError,
  PoolComponentMissingError,
} from "./errors";

// Hashing
export {
  canonicalJsonStringify,
  computeAllocationSetHash,
  computeArtifactsHash,
  computeFinalClaimantAllocationSetHash,
  computeWeightConfigHash,
  sha256OfCanonicalJson,
} from "./hashing";

// Model types and enums
export type {
  AllocationAlgoRef,
  EpochStatus,
  FinalizedAllocation,
  StatementLineItem,
} from "./model";
export { EPOCH_STATUSES } from "./model";

// Pool estimation (pure, deterministic)
export {
  estimatePoolComponentsV0,
  POOL_COMPONENT_ALLOWLIST,
  type PoolComponentEstimate,
  type PoolComponentId,
  validatePoolComponentId,
} from "./pool";

// Rules
export { computeStatementItems } from "./rules";

// Signing
export {
  ATTRIBUTION_STATEMENT_TYPES,
  buildCanonicalMessage,
  buildEIP712TypedData,
  type CanonicalMessageParams,
  computeApproverSetHash,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  type EIP712TypedData,
  type EIP712TypedDataParams,
} from "./signing";

// Store port interface + types
export type {
  AttributionEpoch,
  AttributionEvaluation,
  AttributionPoolComponent,
  AttributionSelection,
  AttributionStatement,
  AttributionStatementLineRecord,
  AttributionStatementSignature,
  AttributionStore,
  ClaimantStore,
  CloseIngestionWithEvaluationsParams,
  CursorStore,
  DistributionClaimRecord,
  DistributionLeafRecord,
  DistributionManifestRecord,
  DistributionManifestStore,
  EpochReader,
  EpochUserProjection,
  EpochWriter,
  EvaluationStore,
  FinalAllocationStore,
  FinalClaimantAllocationRecord,
  IdentityResolver,
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
  OverrideStore,
  PoolComponentInsertResult,
  PoolStore,
  ProjectionStore,
  ReceiptClaimantsRecord,
  ReceiptStore,
  ReviewSubjectOverrideRecord,
  SelectedReceiptWithMetadata,
  SelectionReader,
  SelectionStore,
  SelectionWriter,
  StatementStore,
  TransitionEpochForWindowParams,
  TransitionEpochForWindowResult,
  UnselectedReceipt,
  UpsertEvaluationParams,
  UpsertReviewSubjectOverrideParams,
  UpsertSelectionParams,
} from "./store";
export { toReviewSubjectOverrides } from "./store";

// Validated store wrapper
export { createValidatedAttributionStore } from "./validated-store";
