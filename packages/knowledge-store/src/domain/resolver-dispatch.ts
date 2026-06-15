// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/resolver-dispatch`
 * Purpose: Pure router that classifies a pending hypothesis's `resolution_strategy` into the resolver that should handle it; a `metric:<kpi-id>` row routes to the goal-loop controller (GoalLoopWorkflow), everything else to the generic `agent`/manual path.
 * Scope: Pure classification only; does not touch Temporal or I/O — the cron
 *   consumes this to pick a handler. Unit-testable without any orchestration plane.
 * Invariants:
 *   - METRIC_ROUTES_TO_GOAL_LOOP — `metric:<id>` ⇒ `goal_loop`; `agent` ⇒
 *     `agent`; null/manual ⇒ `manual` (cron skips); anything else ⇒ `unknown`.
 *   - DISPATCH_IS_TOTAL — every input maps to exactly one target.
 * Side-effects: none
 * Links: docs/design/knowledge-goal-loop.md § resolver dispatch
 * @public
 */

import { kpiIdFromStrategy, METRIC_STRATEGY_PREFIX } from "./goal-loop.js";

export const AGENT_STRATEGY = "agent" as const;

/** Where a pending hypothesis's resolution is dispatched. */
export type ResolverTarget =
  | { kind: "goal_loop"; kpiId: string }
  | { kind: "agent" }
  | { kind: "manual" }
  | { kind: "unknown"; strategy: string };

/**
 * Classify a `resolution_strategy` value into its resolver. The cron uses the
 * `kind` to pick a handler:
 *   - `goal_loop` → start/advance the GoalLoopWorkflow for this hypothesis.
 *   - `agent`     → hand off to the generic agent resolver graph.
 *   - `manual`    → skip (null/`manual`); a human files the outcome.
 *   - `unknown`   → a namespaced strategy with no registered resolver; skip + log.
 */
export function classifyResolutionStrategy(
  strategy: string | null | undefined
): ResolverTarget {
  if (strategy === null || strategy === undefined || strategy === "manual") {
    return { kind: "manual" };
  }
  if (strategy.startsWith(METRIC_STRATEGY_PREFIX)) {
    const kpiId = kpiIdFromStrategy(strategy);
    // `metric:` with no kpi id is malformed → not dispatchable to the loop.
    return kpiId === null
      ? { kind: "unknown", strategy }
      : { kind: "goal_loop", kpiId };
  }
  if (strategy === AGENT_STRATEGY) {
    return { kind: "agent" };
  }
  return { kind: "unknown", strategy };
}
