// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-plugins`
 * Purpose: Built-in enricher/allocator implementations, profiles, and registry construction for the attribution pipeline.
 * Scope: Plugin implementations and profile data. Does not define contracts (those live in @cogni/attribution-pipeline-contracts).
 * Invariants:
 * - PLUGINS_OWN_ALL_IMPLEMENTATIONS: selection policies, enrichers, allocators, profiles live here — never in scheduler-worker or contracts.
 * - ENRICHER_DESCRIPTOR_PURE: descriptors are constants + pure functions.
 * - PROFILE_IS_DATA: profiles are plain readonly objects.
 * - FRAMEWORK_STABLE_PLUGINS_CHURN: this package churns; framework stays stable.
 * - PLUGIN_NO_LEDGER_CORE_LEAK: never imported by @cogni/attribution-ledger.
 * Side-effects: none
 * Links: docs/spec/plugin-attribution-pipeline.md
 * @public
 */

export { createEchoAdapter } from "./plugins/echo/adapter";
// Echo plugin
export {
  buildEchoPayload,
  ECHO_ALGO_REF,
  ECHO_DESCRIPTOR,
  ECHO_EVALUATION_REF,
  ECHO_SCHEMA_REF,
  EchoPayloadSchema,
} from "./plugins/echo/descriptor";
// Include-all selection policy
export {
  INCLUDE_ALL_SELECTION_POLICY,
  INCLUDE_ALL_SELECTION_POLICY_REF,
} from "./plugins/include-all-selection/descriptor";
export type { MainMergeSelectionConfig } from "./plugins/main-merge-selection/descriptor";
// Main-merge selection policy (direct-to-main: a PR merged to main is the contribution)
export {
  createMainMergeSelectionPolicy,
  MAIN_MERGE_SELECTION_POLICY,
  MAIN_MERGE_SELECTION_POLICY_REF,
} from "./plugins/main-merge-selection/descriptor";
export type { PromotionSelectionConfig } from "./plugins/promotion-selection/descriptor";
// Promotion selection policy
export {
  createPromotionSelectionPolicy,
  PROMOTION_SELECTION_POLICY,
  PROMOTION_SELECTION_POLICY_REF,
} from "./plugins/promotion-selection/descriptor";
// Weight-sum allocator
export {
  WEIGHT_SUM_ALGO_REF,
  WEIGHT_SUM_ALLOCATOR,
  WeightSumOutputSchema,
} from "./plugins/weight-sum/descriptor";

// Profiles
export { COGNI_V0_PROFILE } from "./profiles/cogni-v0.0";
export { COGNI_V0_1_PROFILE } from "./profiles/cogni-v0.1";

// Registry
export {
  createDefaultRegistries,
  type DefaultRegistries,
  type RegistryConfig,
} from "./registry";
