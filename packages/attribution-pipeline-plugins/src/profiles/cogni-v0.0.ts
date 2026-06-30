// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-pipeline-plugins/profiles/cogni-v0.0`
 * Purpose: Built-in pipeline profile for weekly activity attribution (cogni-v0.0).
 * Scope: Plain readonly data object. Does not perform I/O or contain logic.
 * Invariants:
 * - PROFILE_IS_DATA: plain readonly object — no classes, no methods, no I/O.
 * - PROFILE_IMMUTABLE_PUBLISH_NEW: a published profile is never mutated once epochs
 *   exist under it in a deployed environment. The one documented exception is this
 *   pre-release amendment: v0.0's selection was repointed from `promotion-selection`
 *   to `main-merge-selection` while it was still unused by any node and had produced
 *   zero claimants — publishing a parallel `cogni-v0.1` only to flip the schedule
 *   input was pure ceremony that blocked activation. Immutability applies from here.
 * - PROFILE_SELECTS_ENRICHERS: enricherRefs is sole authority for which enrichers run.
 * - PROFILE_SELECTS_ALLOCATOR: allocatorRef is sole authority for which allocator runs.
 * Side-effects: none
 * Links: docs/spec/plugin-attribution-pipeline.md
 * @public
 */

import type { PipelineProfile } from "@cogni/attribution-pipeline-contracts";

import { MAIN_MERGE_SELECTION_POLICY_REF } from "../plugins/main-merge-selection/descriptor";

/**
 * cogni-v0.0 profile — weekly activity attribution for a direct-to-main repo.
 * Runs echo as the only enricher. Uses `main-merge-selection`: a PR merged to `main`
 * IS the contribution (reviews on those PRs included for visibility; bots excluded).
 * Unresolved contributors are preserved as identity-claimants (IDENTITY_BEST_EFFORT)
 * and can claim via account linking later.
 *
 * The earlier `promotion-selection` modelled a staging→main promotion flow and
 * excluded every direct-to-main PR — yielding zero claimants on this repo, which
 * merges directly to `main` after canary/staging was retired.
 */
export const COGNI_V0_PROFILE: PipelineProfile = {
  profileId: "cogni-v0.0",
  label: "Cogni Weekly Activity v0.0",
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
