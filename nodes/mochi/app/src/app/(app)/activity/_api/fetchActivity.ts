// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/activity/_api/fetchActivity`
 * Purpose: Client-side fetch wrapper for activity data.
 * Scope: Calls /api/v1/activity with type-safe contract. Does not implement business logic.
 * Invariants: Returns typed ActivityData or throws
 * Side-effects: IO
 * Links: [ai.activity.v1.contract](../../../../contracts/ai.activity.v1.contract.ts)
 * @internal
 */

import type {
  ActivityGroupBy,
  ActivityScope,
  aiActivityOperation,
  TimeRange,
} from "@cogni/node-contracts";
import type { z } from "zod";

type ActivityData = z.infer<typeof aiActivityOperation.output>;

export interface FetchActivityParams {
  range: TimeRange;
  scope?: ActivityScope;
  groupBy?: ActivityGroupBy;
  cursor?: string;
  limit?: number;
}

export async function fetchActivity(
  params: FetchActivityParams
): Promise<ActivityData> {
  const searchParams = new URLSearchParams({
    range: params.range,
    ...(params.scope && { scope: params.scope }),
    ...(params.groupBy && { groupBy: params.groupBy }),
    ...(params.cursor && { cursor: params.cursor }),
    ...(params.limit && { limit: params.limit.toString() }),
  });

  const response = await fetch(`/api/v1/activity?${searchParams.toString()}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    cache: "no-store",
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to fetch activity data",
    }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}
