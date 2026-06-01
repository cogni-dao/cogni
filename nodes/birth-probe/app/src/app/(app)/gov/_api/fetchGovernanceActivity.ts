// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/_api/fetchGovernanceActivity`
 * Purpose: Client-side fetch wrapper for governance account activity data.
 * Scope: Calls /api/v1/governance/activity with type-safe contract. Does not implement business logic.
 * Invariants: Returns typed ActivityData or throws
 * Side-effects: IO
 * Links: [ai.activity.v1.contract](../../../../contracts/ai.activity.v1.contract.ts)
 * @internal
 */

import type {
  ActivityGroupBy,
  aiActivityOperation,
  TimeRange,
} from "@cogni/node-contracts";
import type { z } from "zod";

type ActivityData = z.infer<typeof aiActivityOperation.output>;

export interface FetchGovernanceActivityParams {
  range: TimeRange;
  groupBy?: ActivityGroupBy;
}

export async function fetchGovernanceActivity(
  params: FetchGovernanceActivityParams
): Promise<ActivityData> {
  const searchParams = new URLSearchParams({
    range: params.range,
    ...(params.groupBy && { groupBy: params.groupBy }),
  });

  const response = await fetch(
    `/api/v1/governance/activity?${searchParams.toString()}`,
    {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({
      error: "Failed to fetch governance activity data",
    }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}
