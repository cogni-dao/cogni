// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/GoalsMount`
 * Purpose: This node's mount of the Goals board published by `@cogni/knowledge-base-ui/goals` (story.0021, node-template task.0062).
 * Scope: Composition only. The package owns the board, chart, range control, evidence views, read client and poll contract. The node supplies one host (`NODE_GOALS_HOST`: the package-default cookie-session client at `/api/v1/metrics`, Next's `Link` for client navigation). A change of client, `init`, `queryKeyPrefix` or `hrefs` edits only `NODE_GOALS_HOST`.
 * Invariants: ONE_GOALS_PROVIDER (the board renders under one `GoalsProvider`); no Goals markup, formatting or fetching lives in the app.
 * Side-effects: none beyond the package's GET reads
 * Links: story.0021, packages/knowledge-base-ui/AGENTS.md (node-template)
 * @internal
 */

"use client";

import {
  GoalsBoard,
  type GoalsBoardProps,
  type GoalsHostOptions,
  GoalsProvider,
} from "@cogni/knowledge-base-ui/goals";
import Link from "next/link";

/** The node's single Goals host. Module-level so every provider shares the same identity. */
export const NODE_GOALS_HOST: GoalsHostOptions = { LinkComponent: Link };

export function KnowledgeGoalsBoard(props: GoalsBoardProps) {
  return (
    <GoalsProvider {...NODE_GOALS_HOST}>
      <GoalsBoard {...props} />
    </GoalsProvider>
  );
}
