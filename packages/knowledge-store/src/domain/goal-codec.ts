// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/domain/goal-codec`
 * Purpose: Pure `tags ⇄ Goal` codec. A goal's threshold + loop budget ride the
 *   hypothesis row's `tags` (`string[]`) as `goal-<key>=<value>` strings; this
 *   module is the only place those wire strings are read/written, so the typed
 *   `Goal` / `LoopBudget` is what the rest of the controller consumes.
 * Scope: Pure encode/decode + the `Knowledge` row → `Goal` projection; does not do I/O.
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
  kpiIdFromStrategy,
  type LoopBudget,
  LoopBudgetSchema,
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

/**
 * Optional string-valued goal config carried on `tags`. Unlike the numeric
 * budget keys these are not part of `LoopBudget`; they parameterize the step
 * graph + the `metric:judge` reader (the goal's prose success sentence). v0
 * base64url-encodes the criterion so a free-text sentence survives the `tags`
 * `string[]` wire without colliding with the `=` delimiter or LIKE scans.
 */
export const GOAL_CONFIG_TAG_KEYS = {
  stepGraphId: "goal-step-graph",
  successCriterion: "goal-success-criterion-b64",
} as const;

/** True for any `goal-…=` tag string this codec owns (budget or config). */
export function isGoalTag(tag: string): boolean {
  return [
    ...Object.values(GOAL_TAG_KEYS),
    ...Object.values(GOAL_CONFIG_TAG_KEYS),
  ].some((k) => tag.startsWith(`${k}=`));
}

function encodeB64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeB64(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

// ---------------------------------------------------------------------------
// Encode — `target` + `LoopBudget` → the five `goal-…=` tag strings.
// ---------------------------------------------------------------------------

/** Optional non-budget goal config the encoder may also stamp onto `tags`. */
export interface GoalConfigInput {
  /** Graph the per-tick step runs (any registered graph id). */
  stepGraphId?: string;
  /** The goal's prose success sentence — consumed by the `metric:judge` reader. */
  successCriterion?: string;
}

/**
 * Encode a goal's target + loop budget (+ optional step-graph / success
 * criterion) as `goal-<key>=<value>` tag strings. Validates the numeric inputs
 * first (a malformed budget never reaches the wire). Returns the tags in a
 * stable order; merge them with any non-goal tags caller-side.
 */
export function encodeGoalTags(
  target: number,
  budget: LoopBudget,
  config: GoalConfigInput = {}
): string[] {
  const parsedTarget = GoalSchema.shape.target.parse(target);
  const b = LoopBudgetSchema.parse(budget);
  const tags = [
    `${GOAL_TAG_KEYS.target}=${parsedTarget}`,
    `${GOAL_TAG_KEYS.maxIterations}=${b.maxIterations}`,
    `${GOAL_TAG_KEYS.maxTokens}=${b.maxTokens}`,
    `${GOAL_TAG_KEYS.maxRecursionDepth}=${b.maxRecursionDepth}`,
    `${GOAL_TAG_KEYS.maxStalledIterations}=${b.maxStalledIterations}`,
  ];
  if (config.stepGraphId !== undefined && config.stepGraphId.length > 0) {
    tags.push(`${GOAL_CONFIG_TAG_KEYS.stepGraphId}=${config.stepGraphId}`);
  }
  if (
    config.successCriterion !== undefined &&
    config.successCriterion.length > 0
  ) {
    tags.push(
      `${GOAL_CONFIG_TAG_KEYS.successCriterion}=${encodeB64(config.successCriterion)}`
    );
  }
  return tags;
}

function readStringTag(tags: readonly string[], key: string): string | null {
  const prefix = `${key}=`;
  const hit = tags.find((t) => t.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
}

/** Read the optional `goal-step-graph` tag, or null. */
export function stepGraphIdFromTags(tags: readonly string[]): string | null {
  return readStringTag(tags, GOAL_CONFIG_TAG_KEYS.stepGraphId);
}

/** Read + decode the optional `goal-success-criterion-b64` tag, or null. */
export function successCriterionFromTags(
  tags: readonly string[]
): string | null {
  const raw = readStringTag(tags, GOAL_CONFIG_TAG_KEYS.successCriterion);
  if (raw === null) return null;
  try {
    return decodeB64(raw);
  } catch {
    return null;
  }
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
