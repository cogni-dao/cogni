// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-plugins/profiles/cogni-v0.1`
 * Purpose: Built-in pipeline profile for weekly activity attribution (cogni-v0.1).
 * Scope: Plain readonly data object. Does not perform I/O or contain logic.
 * Invariants:
 * - PROFILE_IS_DATA: plain readonly object — no classes, no methods, no I/O.
 * - PROFILE_IMMUTABLE_PUBLISH_NEW: once published, never mutated.
 * - PROFILE_SELECTS_ENRICHERS: enricherRefs is sole authority for which enrichers run.
 * - PROFILE_SELECTS_ALLOCATOR: allocatorRef is sole authority for which allocator runs.
 * Side-effects: none
 * Links: docs/spec/plugin-attribution-pipeline.md, docs/spec/attribution-ledger.md
 *
 * Difference from cogni-v0.0: selection switches from `promotion-selection.v0`
 * (staging→main promotion model, which excludes every direct-to-main PR and
 * yields zero claimants) to `main-merge-selection.v0` (a PR merged to `main` IS
 * the contribution). This matches the repo's direct-to-main workflow after
 * canary/staging was retired. Enricher, allocator, and weights are unchanged.
 * @public
 */

import type { PipelineProfile } from "@cogni/attribution-pipeline-contracts";

import { MAIN_MERGE_SELECTION_POLICY_REF } from "../plugins/main-merge-selection/descriptor";

/**
 * cogni-v0.1 profile — weekly activity attribution for a direct-to-main repo.
 * A PR merged to `main` is a contribution; reviews on those PRs are included for
 * visibility. Unresolved contributors are preserved as identity-claimants
 * (IDENTITY_BEST_EFFORT) and can claim via account linking later.
 */
export const COGNI_V0_1_PROFILE: PipelineProfile = {
  profileId: "cogni-v0.1",
  label: "Cogni Weekly Activity v0.1",
  enricherRefs: [{ enricherRef: "cogni.echo.v0", dependsOnEvaluations: [] }],
  allocatorRef: "weight-sum-v0",
  selectionPolicyRef: MAIN_MERGE_SELECTION_POLICY_REF,
  epochKind: "activity",
  defaultWeightConfig: {
    "github:pr_merged": 1000,
    "github:review_submitted": 0,
    "github:issue_closed": 0,
  },
};
