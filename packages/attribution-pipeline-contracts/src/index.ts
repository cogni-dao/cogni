// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-contracts`
 * Purpose: Stable contracts for the attribution pipeline plugin architecture — interfaces, registries, dispatch, ordering, validation.
 * Scope: Types and pure functions only. Does not perform I/O or contain side effects (FRAMEWORK_NO_IO).
 * Invariants:
 * - FRAMEWORK_NO_IO: this package contains zero I/O, zero side effects, zero env reads.
 * - CONTRACTS_NO_IMPLEMENTATIONS: interfaces and dispatch only. No selection rules, no allocation formulas, no source-specific logic. Implementations live in @cogni/attribution-pipeline-plugins.
 * - PROFILE_IS_DATA: profiles are plain readonly objects.
 * - ENRICHER_ORDER_EXPLICIT: enricher ordering validated at registration.
 * - EVALUATION_WRITE_VALIDATED: all required fields checked on every evaluation write.
 * - ALLOCATOR_NEEDS_DECLARED: required evaluations validated before compute().
 * - SELECTION_POLICY_PLUGGABLE: adding a new selection policy requires zero changes to this package.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-plugin-pipeline
 * @public
 */

// Allocator contracts + dispatch
export {
  type AllocationContext,
  type AllocatorDescriptor,
  type AllocatorRegistry,
  dispatchAllocator,
} from "./allocator";
// Enricher contracts
export type {
  EnricherAdapter,
  EnricherAdapterRegistry,
  EnricherContext,
  EnricherDescriptor,
  EnricherEvaluationResult,
  EnricherLogger,
} from "./enricher";
// Ordering validation
export { validateEnricherOrder } from "./ordering";
// Profile types + resolution
export {
  type EnricherRef,
  type PipelineProfile,
  type ProfileRegistry,
  resolveProfile,
} from "./profile";

// Selection policy contracts + dispatch
export {
  dispatchSelectionPolicy,
  type SelectionContext,
  type SelectionDecision,
  type SelectionPolicyDescriptor,
  type SelectionPolicyRegistry,
} from "./selection";

// Evaluation write validation
export { validateEvaluationWrite } from "./validation";
