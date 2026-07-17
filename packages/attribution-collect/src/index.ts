// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-collect`
 * Purpose: Shared attribution collect pipeline — the ledger + enrichment activity factories (consumed by the Temporal ledger worker) plus runCollectPass, the in-process twin of CollectEpochWorkflow that a node runs against its OWN ledger DB.
 * Scope: Deps-injected, framework-agnostic pipeline composition. Does not own Temporal wiring (that stays in the worker) and does not read repo-spec/env (callers inject deps + config).
 * Invariants:
 *   - PURE_FACTORIES: activity factories are pure over their injected deps.
 *   - WORKER_BEHAVIOR_UNCHANGED: the ledger worker imports the same factories from here — a pure move, no runtime change.
 * Side-effects: none (re-export barrel)
 * Links: docs/design/attribution-operator-gateway.md
 * @public
 */

export type {
  AttributionActivityDeps,
  ComputeAllocationsInput,
  ComputeAllocationsOutput,
  CollectFromSourceInput,
  CollectFromSourceOutput,
  EnsureEpochInput,
  EnsureEpochOutput,
  EnsurePoolComponentsInput,
  EnsurePoolComponentsOutput,
  FinalizeEpochInput,
  FinalizeEpochOutput,
  FindStaleOpenEpochInput,
  FindStaleOpenEpochOutput,
  InsertReceiptsInput,
  LedgerActivities,
  LoadCursorInput,
  MaterializeSelectionInput,
  MaterializeSelectionOutput,
  ResolveStreamsInput,
  ResolveStreamsOutput,
  SaveCursorInput,
  TransitionEpochForWindowInput,
  TransitionEpochForWindowOutput,
} from "./activities/ledger.js";
export { createAttributionActivities } from "./activities/ledger.js";

export type {
  BuildLockedEvaluationsInput,
  BuildLockedEvaluationsOutput,
  DeriveWeightConfigInput,
  DeriveWeightConfigOutput,
  EnrichmentActivities,
  EnrichmentActivityDeps,
  EvaluateEpochDraftInput,
  EvaluateEpochDraftOutput,
  UpsertEvaluationParamsWire,
} from "./activities/enrichment.js";
export { createEnrichmentActivities } from "./activities/enrichment.js";

export type { AttributionIngestRunV1 } from "./contract.js";

export type {
  CollectPassSummary,
  RunCollectPassDeps,
} from "./run-collect-pass.js";
export { runCollectPass } from "./run-collect-pass.js";
