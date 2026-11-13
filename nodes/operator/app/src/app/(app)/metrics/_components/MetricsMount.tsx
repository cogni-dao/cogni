// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/metrics/_components/MetricsMount`
 * Purpose: This node's mount of the published Metrics view (`MetricsBoard`, story.0039).
 * Scope: Composition only, over the node's one Goals host (`(app)/_components/goals-host.ts`). A fork that needs another client, `hrefs` or `queryKeyPrefix` changes only that file.
 * Invariants: ONE_CACHE_ENTRY (the same host and query key as the goal entry page's board).
 * Side-effects: IO (via the package's GoalsClient)
 * Links: packages/knowledge-base-ui/AGENTS.md
 * @internal
 */

"use client";

import { MetricsBoard } from "@cogni/knowledge-base-ui/goals";
import type { GoalsProgress } from "@cogni-dao/metrics/contracts";
import { NODE_GOALS_HOST } from "../../_components/goals-host";

export function MetricsMount({
  initialData,
}: {
  readonly initialData?: GoalsProgress | undefined;
}) {
  return <MetricsBoard {...NODE_GOALS_HOST} initialData={initialData} />;
}
