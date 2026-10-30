// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/work/_components/WorkItemScoresRadar`
 * Purpose: Preserve the operator import path for the published Evaluation presenter.
 * Scope: Re-export only; presentation, Justification links and queue logic are shared.
 * Invariants: RADAR_FROM_IMMUTABLE_RELEASE.
 * Side-effects: none
 * Links: hub adopt-node-package-release, story.5111
 * @public
 */

export { hasScores, WorkItemScoresRadar } from "@cogni/knowledge-base-ui";
