// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/activities/sweep`
 * Purpose: Temporal Activities for scheduled-sweep agent roles.
 * Scope: Fetch work items via app HTTP API, log results. All I/O.
 * Invariants:
 *   - Per ACTIVITY_IDEMPOTENCY: read-only in v0 (no claim/release yet)
 *   - Per EXECUTION_VIA_SERVICE_API: calls app's REST API, never imports app code
 *   - LIFECYCLE_ORDER_FROM_HUB: fetched items rank closest-to-done first
 *     (needs_closeout > needs_merge > needs_implement …), then by priority
 * Side-effects: IO (HTTP to app API)
 * Links: docs/spec/agent-roles.md, docs/spec/temporal-patterns.md
 * @internal
 */

import type { SweepWorkItem } from "@cogni/temporal-workflows";

import { logWorkerEvent, WORKER_EVENT_NAMES } from "../observability/index.js";
import type { Logger } from "../observability/logger.js";

/**
 * Dependencies for sweep activities.
 */
export interface SweepActivityDeps {
  config: {
    /** Operator node URL — sweeps are operator-only for now. */
    operatorBaseUrl: string;
    schedulerApiToken: string;
  };
  logger: Logger;
}

/**
 * Create sweep activities with injected deps.
 */
export function createSweepActivities(deps: SweepActivityDeps) {
  const { config, logger } = deps;

  /**
   * Fetch work items from the app's REST API, filtered and sorted closest to
   * done first (status weight), then by priority.
   */
  async function fetchWorkItemsActivity(input: {
    statuses?: string[];
    labels?: string[];
    types?: string[];
  }): Promise<SweepWorkItem[]> {
    const url = new URL("/api/v1/work/items", config.operatorBaseUrl);

    if (input.statuses?.length) {
      url.searchParams.set("statuses", input.statuses.join(","));
    }
    if (input.types?.length) {
      url.searchParams.set("types", input.types.join(","));
    }

    // Agents only see AI-eligible work items (actor=ai matches "ai" + "either")
    url.searchParams.set("actor", "ai");

    logger.info(
      { event: "sweep.fetch_items", url: url.toString() },
      "Fetching work items for sweep"
    );

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${config.schedulerApiToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      logger.error(
        { event: "sweep.fetch_items_error", status: res.status },
        `Failed to fetch work items: ${res.status}`
      );
      return [];
    }

    const data = (await res.json()) as { items?: SweepWorkItem[] };
    const items = data.items ?? [];

    // Sort by status weight (closest to done first), then by priority
    // (lower = higher priority). Lifecycle order: needs_merge (review, flight,
    // validate) → needs_closeout (operator merge) → done.
    const STATUS_WEIGHTS: Record<string, number> = {
      needs_closeout: 6,
      needs_merge: 5,
      needs_implement: 4,
      needs_design: 3,
      needs_research: 2,
      needs_triage: 1,
    };

    items.sort((a, b) => {
      const wa = STATUS_WEIGHTS[a.status] ?? 0;
      const wb = STATUS_WEIGHTS[b.status] ?? 0;
      if (wb !== wa) return wb - wa; // Higher weight first
      return (a.priority ?? 99) - (b.priority ?? 99); // Lower priority number first
    });

    logger.info(
      { event: "sweep.items_fetched", count: items.length },
      `Fetched ${items.length} work items`
    );

    return items;
  }

  /**
   * Log sweep result. v0: just logs. Walk phase: post to Discord.
   */
  async function processSweepResultActivity(input: {
    roleId: string;
    itemId: string;
    itemTitle: string;
    outcome: "success" | "error" | "no_op";
    runId: string;
  }): Promise<void> {
    logWorkerEvent(
      logger,
      WORKER_EVENT_NAMES.ACTIVITY_SWEEP_RESULT ?? "sweep.result",
      {
        roleId: input.roleId,
        itemId: input.itemId,
        itemTitle: input.itemTitle,
        outcome: input.outcome,
        runId: input.runId,
      }
    );

    logger.info(
      {
        event: "sweep.result",
        roleId: input.roleId,
        itemId: input.itemId,
        outcome: input.outcome,
      },
      `Sweep ${input.roleId}: ${input.outcome} on ${input.itemId} (${input.itemTitle})`
    );
  }

  return {
    fetchWorkItemsActivity,
    processSweepResultActivity,
  };
}
