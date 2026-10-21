# attribution-ledger · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @Cogni-DAO
- **Status:** draft

## Purpose

Pure domain logic for the attribution ledger — shared between the Next.js app (`src/`) and the Temporal `scheduler-worker` service. Contains model types, attribution statement line computation (BIGINT, largest-remainder), hashing (allocation sets, weight configs, artifacts), versioned allocation algorithm framework, pool estimation, artifact envelope validation, enricher inputs hashing, validated store wrapper, port interface (`AttributionStore`), and domain error classes.

## Pointers

- [Attribution Ledger Spec](../../docs/spec/attribution-ledger.md)
- [Packages Architecture](../../docs/spec/packages-architecture.md)

## Boundaries

```json
{
  "layer": "packages",
  "may_import": ["packages"],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services"
  ]
}
```

**External deps:** none (pure TypeScript, Node `crypto` for SHA-256).

## Public Surface

- **Exports:**
  - `EPOCH_STATUSES` — Enum array
  - `EpochStatus` — Canonical epoch status type
  - `FinalizedAllocation`, `StatementLineItem` — Legacy user-only compatibility types retained while app/core barrels still re-export them
  - `AttributionStore` — Composed port interface for ledger persistence
  - `EpochReader`, `EpochWriter`, `ReceiptStore`, `SelectionReader`, `SelectionWriter`, `SelectionStore`, `EvaluationStore`, `ProjectionStore`, `ClaimantStore`, `CursorStore`, `PoolStore`, `StatementStore`, `OverrideStore`, `FinalAllocationStore`, `IdentityResolver` — Narrow ledger store sub-interfaces for scoped consumers
  - `AttributionEpoch`, `IngestionReceipt`, `EpochUserProjection`, `FinalClaimantAllocationRecord`, `IngestionCursor`, `AttributionPoolComponent`, `AttributionStatement`, `AttributionStatementSignature`, `AttributionEvaluation`, `ReviewSubjectOverrideRecord` — Read-side record types
  - `InsertReceiptParams`, `InsertUserProjectionParams`, `InsertFinalClaimantAllocationParams`, `InsertPoolComponentParams`, `InsertStatementParams`, `InsertSignatureParams`, `UpsertReviewSubjectOverrideParams`, `UpsertEvaluationParams`, `CloseIngestionWithEvaluationsParams` — Write-side param types
  - `PoolComponentInsertResult` — Return type for idempotent `insertPoolComponent` (`{ component, created }`)
  - `computeEpochWindowV1()` — Pure, deterministic epoch window computation (Monday-aligned UTC). Safe in Temporal workflow code.
  - `EpochWindow`, `EpochWindowParams` — Types for epoch window computation
  - `computeStatementItems()` — Legacy user-only statement helper retained for compatibility
  - `computeAttributionStatementLines()` — Canonical claimant-aware statement line computation
  - `computeAllocationSetHash()` — Legacy user-only allocation-set hash retained for compatibility
  - claimant-aware allocation-set hash helper — canonical hash for claimant-scoped signed units
  - `computeWeightConfigHash()` — SHA-256 of canonical weight config JSON (key-sorted)
  - `computeReceiptWeights()` — Per-receipt weight allocation dispatch (V0: `weight-sum-v0`)
  - `computeProposedAllocations()` — Legacy user-scoped allocation dispatch (retained for compatibility)
  - `validateWeightConfig()` — Rejects floats, NaN, Infinity, unsafe integers
  - `deriveAllocationAlgoRef()` — Maps `attribution_pipeline` to internal algorithm ref
  - `ReceiptForWeighting`, `ReceiptUnitWeight` — Receipt-scoped allocation input/output types
  - `SelectedReceiptForAllocation`, `ProposedAllocation` — Legacy user-scoped allocation types (retained)
  - `AllocationAlgoRef` — Type alias for algorithm version string
  - `estimatePoolComponentsV0()` — Pool component estimation from config (V0: base_issuance only)
  - `PoolComponentEstimate`, `PoolComponentId`, `POOL_COMPONENT_ALLOWLIST` — Pool types and validation
  - `validatePoolComponentId()` — V0 allowlist validation
  - `EpochNotOpenError`, `EpochAlreadyFinalizedError`, `PoolComponentMissingError`, `ActorBeneficiaryPolicyRejectedError` — Domain errors with type guards
  - `buildEIP712TypedData()` — Canonical EIP-712 typed-data builder for statement signing
  - `parseEIP712DeploymentEnvironment()`, `EIP712_DEPLOYMENT_ENVIRONMENTS`, `EIP712DeploymentEnvironment` — Fail-closed protocol environment validation for deployment-bound EIP-712 v2 signatures
  - `buildCanonicalMessage()` — Deprecated EIP-191 compatibility helper retained for one release cycle
  - `computeApproverSetHash()` — Deterministic approver-set hash pinned at review
  - `computeArtifactsHash()` — SHA-256 of sorted locked artifact tuples
  - `validateArtifactRef()`, `validateArtifactEnvelope()` — Artifact metadata/hash validation (pure)
  - `computeEnricherInputsHash()` — Deterministic inputs hash for enrichers (base shape + extensions)
  - `createValidatedAttributionStore()` — Wraps `AttributionStore` with envelope validation on artifact writes
  - `explodeToClaimants()` — Joins receipt weights × locked claimant records → FinalClaimantAllocation[]
  - `computeAttributionStatementLines()` — Canonical claimant-aware statement line computation
  - `CLAIMANT_SHARE_DENOMINATOR_PPM` — Claimant-share constant (1,000,000 PPM)
  - `AttributionClaimant`, `ClaimantShare`, `FinalClaimantAllocation`, `AttributionStatementLine` — Claimant domain types
  - `SelectedReceiptForAttribution` — Receipt type for attribution reads (includes platform identity fields)
  - `SelectedReceiptWithMetadata` — Receipt-with-metadata type for evaluation inputs

## Ports

- **Uses ports:** none
- **Implements ports:** none
- **Defines ports:** `AttributionStore` (implemented by `DrizzleAttributionAdapter` in `@cogni/db-client`) plus narrow sub-interfaces for scoped consumers. Includes identity resolution (`resolveIdentities`, `getSelectionCandidates`, `updateSelectionUserId`, `insertSelectionDoNothing`), claimant lifecycle (`upsertDraftClaimants`, `lockClaimantsForEpoch`, `loadLockedClaimants`), projection computation (`getSelectedReceiptsForAllocation`, `insertUserProjections`, `deleteStaleUserProjections`), canonical attribution reads (`getSelectedReceiptsForAttribution`, `getUserDisplayNames`, `getEvaluation`, `getReviewSubjectOverridesForEpoch`, `getFinalClaimantAllocationsForEpoch`), evaluation lifecycle (`upsertDraftEvaluation`, `closeIngestionWithEvaluations`, `getEvaluationsForEpoch`, `getSelectedReceiptsWithMetadata`), receipt display (`getReceiptsForEpoch` for cross-epoch selected receipts), and atomic epoch sealing (`finalizeEpochAtomic`).

## Responsibilities

- This directory **does**: Define ledger domain types, port interface, compute deterministic attribution statement lines, compute allocation set/config/artifact hashes, versioned allocation algorithm dispatch, pool estimation, artifact envelope validation, enricher inputs hashing, validated store wrapper, define domain errors
- This directory **does not**: Perform I/O, access databases, import from `src/` or `services/`, or ship concrete enricher plugin implementations

## Usage

```bash
pnpm --filter @cogni/attribution-ledger typecheck
pnpm --filter @cogni/attribution-ledger build
```

## Standards

- Pure functions and types only — no I/O, no framework deps
- ALL_MATH_BIGINT: No floating point in credit/unit calculations
- STATEMENT_DETERMINISTIC: Same inputs → byte-for-byte identical output

## Dependencies

- **Internal:** none (standalone package)
- **External:** none

## Change Protocol

- Update this file when public exports change
- Coordinate with attribution-ledger.md spec invariants

## Notes

- `src/core/attribution/public.ts` re-exports from this package so app code uses `@/core/attribution` unchanged
- Per PACKAGES_NO_SRC_IMPORTS: This package cannot import from `src/**`
- Package isolation enables `scheduler-worker` to import domain logic without Next.js deps
