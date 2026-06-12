// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/goal-codec`
 * Purpose: Pure `tags ⇄ Goal` codec. A goal's threshold + loop budget ride the
 *   hypothesis row's `tags` (`string[]`) as `goal-<key>=<value>` strings; this
 *   module is the only place those wire strings are read/written, so the typed
 *   `Goal` / `LoopBudget` is what the rest of the controller consumes.
 * Scope: Pure encode/decode + the `Knowledge` row → `Goal` projection. No I/O.
 * Invariants:
 *   - GOAL_BUDGET_VIA_TAGS — target + budget live in `tags`, never new columns
 *     (docs/design/knowledge-goal-loop.md § Goal representation). LIKE-scannable,
 *     never touches Doltgres's broken JSONB operators.
 *   - CODEC_ROUND_TRIPS — `decodeGoalTags(encodeGoalTags(t, b))` === `{t, b}`.
 *   - GOAL_REQUIRES_METRIC_STRATEGY — `goalFromRow` only projects a row whose
 *     `resolution_strategy` is `metric:<kpi-id>` (else returns null).
 * Side-effects: none
 * Links: docs/design/knowledge-goal-loop.md, docs/spec/knowledge-syntropy.md
 * @public
 */

import {
  type Goal,
  GoalSchema,
  type LoopBudget,
  LoopBudgetSchema,
  kpiIdFromStrategy,
} from "./goal-loop.js";
import type { Knowledge } from "./schemas.js";

// ---------------------------------------------------------------------------
// Tag keys — the wire encoding of a goal's threshold + budget on `tags`.
// ---------------------------------------------------------------------------

export const GOAL_TAG_KEYS = {
  target: "goal-target",
  maxIterations: "goal-max-iterations",
  maxTokens: "goal-max-tokens",
  maxRecursionDepth: "goal-max-recursion-depth",
  maxStalledIterations: "goal-max-stalled",
} as const;

/** True for any `goal-…=` tag string this codec owns. */
export function isGoalTag(tag: string): boolean {
  return Object.values(GOAL_TAG_KEYS).some((k) => tag.startsWith(`${k}=`));
}

// ---------------------------------------------------------------------------
// Encode — `target` + `LoopBudget` → the five `goal-…=` tag strings.
// ---------------------------------------------------------------------------

/**
 * Encode a goal's target + loop budget as `goal-<key>=<value>` tag strings.
 * Validates inputs first (a malformed budget never reaches the wire). Returns
 * the five tags in a stable order; merge them with any non-goal tags caller-side.
 */
export function encodeGoalTags(target: number, budget: LoopBudget): string[] {
  const parsedTarget = GoalSchema.shape.target.parse(target);
  const b = LoopBudgetSchema.parse(budget);
  return [
    `${GOAL_TAG_KEYS.target}=${parsedTarget}`,
    `${GOAL_TAG_KEYS.maxIterations}=${b.maxIterations}`,
    `${GOAL_TAG_KEYS.maxTokens}=${b.maxTokens}`,
    `${GOAL_TAG_KEYS.maxRecursionDepth}=${b.maxRecursionDepth}`,
    `${GOAL_TAG_KEYS.maxStalledIterations}=${b.maxStalledIterations}`,
  ];
}

// ---------------------------------------------------------------------------
// Decode — `tags` → `{ target, budget }`.
// ---------------------------------------------------------------------------

export interface DecodedGoalTags {
  target: number;
  budget: LoopBudget;
}

function readNumericTag(tags: readonly string[], key: string): number | null {
  const prefix = `${key}=`;
  const hit = tags.find((t) => t.startsWith(prefix));
  if (hit === undefined) return null;
  const raw = hit.slice(prefix.length);
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Decode the `goal-…=` tags into a typed `{ target, budget }`. Throws if any
 * required tag is missing or malformed — a goal row that can't yield a valid
 * budget is a config error the controller must surface, not silently default.
 * (Per-tag defaulting belongs to the writer via `DEFAULT_LOOP_BUDGET`, not here.)
 */
export function decodeGoalTags(tags: readonly string[]): DecodedGoalTags {
  const target = readNumericTag(tags, GOAL_TAG_KEYS.target);
  if (target === null) {
    throw new Error(`goal tags missing/invalid '${GOAL_TAG_KEYS.target}'`);
  }
  const budget = LoopBudgetSchema.parse({
    maxIterations: readNumericTag(tags, GOAL_TAG_KEYS.maxIterations),
    maxTokens: readNumericTag(tags, GOAL_TAG_KEYS.maxTokens),
    maxRecursionDepth: readNumericTag(tags, GOAL_TAG_KEYS.maxRecursionDepth),
    maxStalledIterations: readNumericTag(
      tags,
      GOAL_TAG_KEYS.maxStalledIterations
    ),
  });
  return { target: GoalSchema.shape.target.parse(target), budget };
}

// ---------------------------------------------------------------------------
// Project a `hypothesis` knowledge row → `Goal`.
//
// This is the read seam the loop controller uses: a goal is a hypothesis row
// whose `resolution_strategy` is `metric:<kpi-id>` and whose `tags` encode the
// target + budget. Returns null for any row that is not a goal (no metric
// strategy, no evaluate_at, or no decodable target).
// ---------------------------------------------------------------------------

export interface GoalFromRow {
  goal: Goal;
  budget: LoopBudget;
}

export function goalFromRow(row: Knowledge): GoalFromRow | null {
  const kpiId = kpiIdFromStrategy(row.resolutionStrategy ?? null);
  if (kpiId === null) return null;
  if (!row.evaluateAt) return null;

  let decoded: DecodedGoalTags;
  try {
    decoded = decodeGoalTags(row.tags ?? []);
  } catch {
    return null;
  }

  const parsed = GoalSchema.safeParse({
    hypothesisId: row.id,
    domain: row.domain,
    kpiId,
    target: decoded.target,
    evaluateAt: row.evaluateAt,
  });
  if (!parsed.success) return null;

  return { goal: parsed.data, budget: decoded.budget };
}
