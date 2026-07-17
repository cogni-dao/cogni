// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-collect/contract`
 * Purpose: Versioned domain envelope for one attribution collect pass — the sole input contract shared by the in-process runCollectPass and the Temporal CollectEpochWorkflow.
 * Scope: Type declarations only. Does not import framework/adapter code so both the workflow-bundle build and the node app can consume it. Structurally identical to CollectEpochWorkflow's AttributionIngestRunV1 (kept in sync by hand — the workflow bundle stays free of this package's viem/pino graph).
 * Invariants:
 *   - CONTRACT_STABLE: fields are serializable; bigint values carried as decimal strings.
 * Side-effects: none
 * Links: docs/design/attribution-operator-gateway.md, packages/temporal-workflows/src/workflows/collect-epoch.workflow.ts
 * @public
 */

/** Versioned domain envelope — sole contract for a collect pass. */
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
