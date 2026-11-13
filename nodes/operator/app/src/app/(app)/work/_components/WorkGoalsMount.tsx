// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/work/_components/WorkGoalsMount`
 * Purpose: This node's mount of the work goal resolver published by `@cogni/knowledge-base-ui/goals` (task.0112): the table's Goal column, the board's goal pointer and the detail's Moves block all read goal titles through it.
 * Scope: Composition only. Uses the node's one Goals host (`NODE_GOALS_HOST`) so the goals read is the same cache entry the Metrics page uses; no per-row reads.
 * Invariants: ONE_CACHE_ENTRY (shares the host's client and key prefix with every other Goals mount).
 * Side-effects: none beyond the package's GET read of `/api/v1/metrics/goals`
 * Links: task.0112, packages/knowledge-base-ui/src/goals/work-goals-scope.tsx
 * @internal
 */

"use client";

import { GoalsProvider, WorkGoalsScope } from "@cogni/knowledge-base-ui/goals";
import type { ReactNode } from "react";
import { NODE_GOALS_HOST } from "../../_components/goals-host";

export function WorkGoalsMount({ children }: { readonly children: ReactNode }) {
  return (
    <GoalsProvider {...NODE_GOALS_HOST}>
      <WorkGoalsScope>{children}</WorkGoalsScope>
    </GoalsProvider>
  );
}
