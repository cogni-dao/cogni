// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/GoalsMount`
 * Purpose: This node's mount of the Goals board published by `@cogni/knowledge-base-ui/goals` (story.0021, node-template task.0062).
 * Scope: Composition only. The package owns the board, chart, range control, evidence views, read client and poll contract. The node supplies one host (`NODE_GOALS_HOST` in `(app)/_components/goals-host.ts`: the package-default cookie-session client at `/api/v1/metrics`, Next's `Link` for client navigation), shared with the Metrics page and the work views so the goal read is one cache entry. A change of client, `init`, `queryKeyPrefix` or `hrefs` edits only `NODE_GOALS_HOST`.
 * Invariants: ONE_GOALS_PROVIDER (the board renders under one `GoalsProvider`), ONE_CACHE_ENTRY (the host is shared); no Goals markup, formatting or fetching lives in the app.
 * Side-effects: none beyond the package's GET reads
 * Links: story.0021, packages/knowledge-base-ui/AGENTS.md (node-template)
 * @internal
 */

"use client";

import {
  GoalsBoard,
  type GoalsBoardProps,
  GoalsProvider,
} from "@cogni/knowledge-base-ui/goals";
import { NODE_GOALS_HOST } from "../../_components/goals-host";

export function KnowledgeGoalsBoard(props: GoalsBoardProps) {
  return (
    <GoalsProvider {...NODE_GOALS_HOST}>
      <GoalsBoard {...props} />
    </GoalsProvider>
  );
}
