// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/_components/goals-host`
 * Purpose: This node's one Goals host for every mount of the published Goals capability (the Metrics page, the goal entry page, the evidence views).
 * Scope: A constant. The package-default cookie-session client at `/api/v1/metrics` and Next's `Link` for client navigation. A fork that needs another client, `init`, `queryKeyPrefix` or `hrefs` changes only this file.
 * Invariants: ONE_CACHE_ENTRY (every mount shares one client and one query-key prefix, so the goal read is one cache entry). Module-level so every provider shares the same identity.
 * Side-effects: none
 * Links: ../metrics/_components/MetricsMount.tsx, ../knowledge/_components/GoalsMount.tsx
 * @internal
 */

import type { GoalsHostOptions } from "@cogni/knowledge-base-ui/goals";
import Link from "next/link";

export const NODE_GOALS_HOST: GoalsHostOptions = { LinkComponent: Link };
