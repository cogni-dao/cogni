// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/goals/lib/api`
 * Purpose: Browser reads for the Goals tab: goal progress and ranged metric
 *   history.
 * Scope: Cookie-session GETs parsed with the shared metrics contracts. Never computes.
 * Invariants: ONE_WIRE_CONTRACT (zod schemas from @cogni-dao/metrics/contracts);
 *   READ_ONLY (no POST from the UI; agents and the clock refresh readings);
 *   BUCKETS_LE_400 (every history read is aligned and holds at most 400 buckets).
 * Side-effects: IO (GET /api/v1/metrics/goals, GET /api/v1/metrics/{id}/history)
 * Links: packages/metrics/src/contracts.ts, ./presentation.ts
 * @public
 */

import {
  type GoalsProgress,
  GoalsProgressSchema,
  type MetricHistory,
  MetricHistorySchema,
} from "@cogni-dao/metrics/contracts";

import type { HistoryWindow } from "./presentation";

export const GOALS_QUERY_KEY = ["goals", "progress"] as const;

/** A failed read with its HTTP status, so callers branch on status, not message text. */
export class GoalsReadError extends Error {
  constructor(
    readonly resource: "goals" | "history",
    readonly status: number
  ) {
    super(`${resource}_read_failed:${status}`);
    this.name = "GoalsReadError";
  }
}

export async function fetchGoalsProgress(): Promise<GoalsProgress> {
  const response = await fetch("/api/v1/metrics/goals", { cache: "no-store" });
  if (!response.ok) throw new GoalsReadError("goals", response.status);
  return GoalsProgressSchema.parse(await response.json());
}

async function readHistory(
  metricId: string,
  window: HistoryWindow
): Promise<MetricHistory> {
  const { from, to, step } = window;
  const qs = new URLSearchParams({ from, to, step }).toString();
  const response = await fetch(
    `/api/v1/metrics/${encodeURIComponent(metricId)}/history?${qs}`,
    { cache: "no-store" }
  );
  if (!response.ok) throw new GoalsReadError("history", response.status);
  return MetricHistorySchema.parse(await response.json());
}

/** One aligned window (see historyWindow): 1D/1W hourly, 1M/3M daily. */
export async function fetchMetricHistory(
  metricId: string,
  window: HistoryWindow
): Promise<MetricHistory> {
  return readHistory(metricId, window);
}
