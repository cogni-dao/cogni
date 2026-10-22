// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker/tests/sweep-activities.test`
 * Purpose: Unit tests for the sweep fetch activity's lifecycle ranking.
 * Scope: fetchWorkItemsActivity with a stubbed global fetch. No network.
 * Invariants:
 *   - LIFECYCLE_ORDER_FROM_HUB: the item closest to done ranks first —
 *     needs_closeout > needs_merge > needs_implement; priority breaks ties.
 * Side-effects: none
 * Links: src/activities/sweep.ts, task.5292
 * @internal
 */

import type { SweepWorkItem } from "@cogni/temporal-workflows";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSweepActivities } from "../src/activities/sweep.js";

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => mockLogger,
} as unknown as Parameters<typeof createSweepActivities>[0]["logger"];

function activitiesReturning(items: SweepWorkItem[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ items }), { status: 200 }))
  );
  return createSweepActivities({
    config: {
      operatorBaseUrl: "https://operator.test",
      schedulerApiToken: "token",
    },
    logger: mockLogger,
  });
}

describe("fetchWorkItemsActivity ranking", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("ranks needs_closeout above needs_merge above needs_implement, then by priority", async () => {
    const { fetchWorkItemsActivity } = activitiesReturning([
      {
        id: "task.1",
        title: "implement",
        status: "needs_implement",
        priority: 0,
      },
      { id: "task.2", title: "merge p2", status: "needs_merge", priority: 2 },
      {
        id: "task.3",
        title: "closeout",
        status: "needs_closeout",
        priority: 3,
      },
      { id: "task.4", title: "merge p1", status: "needs_merge", priority: 1 },
    ]);

    const items = await fetchWorkItemsActivity({});

    expect(items.map((item) => item.id)).toEqual([
      "task.3",
      "task.4",
      "task.2",
      "task.1",
    ]);
  });
});
