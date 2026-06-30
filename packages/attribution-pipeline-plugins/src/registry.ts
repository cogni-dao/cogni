// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-plugins/registry`
 * Purpose: Default registry construction — assembles built-in enrichers, allocators, and profiles.
 * Scope: Registry factory function. Does not perform I/O or contain side effects.
 * Invariants:
 * - ENRICHER_ORDER_EXPLICIT: profile enricher ordering validated at construction.
 * - FRAMEWORK_STABLE_PLUGINS_CHURN: plugins package owns registry construction; framework stays stable.
 * Side-effects: none
 * Links: docs/spec/plugin-attribution-pipeline.md
 * @public
 */

import type {
  AllocatorRegistry,
  EnricherAdapterRegistry,
  ProfileRegistry,
  SelectionPolicyRegistry,
} from "@cogni/attribution-pipeline-contracts";

import { createEchoAdapter } from "./plugins/echo/adapter";
import { INCLUDE_ALL_SELECTION_POLICY } from "./plugins/include-all-selection/descriptor";
import { createMainMergeSelectionPolicy } from "./plugins/main-merge-selection/descriptor";
import { createPromotionSelectionPolicy } from "./plugins/promotion-selection/descriptor";
import { WEIGHT_SUM_ALLOCATOR } from "./plugins/weight-sum/descriptor";
import { COGNI_V0_PROFILE } from "./profiles/cogni-v0.0";

/**
 * Result from createDefaultRegistries.
 */
export interface DefaultRegistries {
  readonly profiles: ProfileRegistry;
  readonly enrichers: EnricherAdapterRegistry;
  readonly allocators: AllocatorRegistry;
  readonly selectionPolicies: SelectionPolicyRegistry;
}

/**
 * Optional configuration for registry construction.
 */
export interface RegistryConfig {
  readonly excludedLogins?: readonly string[];
}

/**
 * Create the default registries with all built-in plugins and profiles.
 * Returns immutable maps keyed by ref strings.
 */
export function createDefaultRegistries(
  config?: RegistryConfig
): DefaultRegistries {
  const echoAdapter = createEchoAdapter();

  const profiles: ProfileRegistry = new Map([
    [COGNI_V0_PROFILE.profileId, COGNI_V0_PROFILE],
  ]);

  const enrichers: EnricherAdapterRegistry = new Map([
    [echoAdapter.descriptor.evaluationRef, echoAdapter],
  ]);

  const allocators: AllocatorRegistry = new Map([
    [WEIGHT_SUM_ALLOCATOR.algoRef, WEIGHT_SUM_ALLOCATOR],
  ]);

  const promotionPolicy = createPromotionSelectionPolicy({
    excludedLogins: config?.excludedLogins,
  });
  const mainMergePolicy = createMainMergeSelectionPolicy({
    excludedLogins: config?.excludedLogins,
  });
  const selectionPolicies: SelectionPolicyRegistry = new Map([
    [promotionPolicy.policyRef, promotionPolicy],
    [mainMergePolicy.policyRef, mainMergePolicy],
    [INCLUDE_ALL_SELECTION_POLICY.policyRef, INCLUDE_ALL_SELECTION_POLICY],
  ]);

  return { profiles, enrichers, allocators, selectionPolicies };
}
