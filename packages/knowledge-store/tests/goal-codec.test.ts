// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/goal-codec`
 * Purpose: Unit coverage for the pure `tags ⇄ Goal` codec — round-trip, the `goalFromRow` projection, and rejection of non-goal / malformed rows.
 * Scope: Pure codec only; does not touch Temporal or a DB.
 * Invariants: CODEC_ROUND_TRIPS, GOAL_REQUIRES_METRIC_STRATEGY
 * Side-effects: none
 * Links: src/domain/goal-codec.ts, docs/design/knowledge-goal-loop.md
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  decodeGoalTags,
  encodeGoalTags,
  GOAL_TAG_KEYS,
  goalFromRow,
  isGoalTag,
} from "../src/domain/goal-codec.js";
import { DEFAULT_LOOP_BUDGET } from "../src/domain/goal-loop.js";
import type { Knowledge } from "../src/domain/schemas.js";

const EVAL_AT = new Date("2026-12-31T00:00:00.000Z");

describe("encodeGoalTags / decodeGoalTags", () => {
  it("round-trips target + budget", () => {
    const tags = encodeGoalTags(80, DEFAULT_LOOP_BUDGET);
    expect(decodeGoalTags(tags)).toEqual({
      target: 80,
      budget: DEFAULT_LOOP_BUDGET,
    });
  });

  it("encodes the five canonical `goal-…=` keys", () => {
    const tags = encodeGoalTags(50, DEFAULT_LOOP_BUDGET);
    for (const key of Object.values(GOAL_TAG_KEYS)) {
      expect(tags.some((t) => t.startsWith(`${key}=`))).toBe(true);
      expect(tags.every(isGoalTag)).toBe(true);
    }
  });

  it("decodes regardless of tag order and ignores foreign tags", () => {
    const tags = [
      "oss-ai",
      `${GOAL_TAG_KEYS.maxTokens}=12345`,
      `${GOAL_TAG_KEYS.target}=42`,
      `${GOAL_TAG_KEYS.maxIterations}=3`,
      `${GOAL_TAG_KEYS.maxRecursionDepth}=0`,
      `${GOAL_TAG_KEYS.maxStalledIterations}=2`,
    ];
    expect(decodeGoalTags(tags)).toEqual({
      target: 42,
      budget: {
        maxIterations: 3,
        maxTokens: 12345,
        maxRecursionDepth: 0,
        maxStalledIterations: 2,
      },
    });
  });

  it("throws on a missing target tag", () => {
    const tags = encodeGoalTags(80, DEFAULT_LOOP_BUDGET).filter(
      (t) => !t.startsWith(`${GOAL_TAG_KEYS.target}=`)
    );
    expect(() => decodeGoalTags(tags)).toThrow();
  });

  it("throws on a malformed budget axis (zero iterations)", () => {
    const tags = [
      `${GOAL_TAG_KEYS.target}=80`,
      `${GOAL_TAG_KEYS.maxIterations}=0`,
      `${GOAL_TAG_KEYS.maxTokens}=1000`,
      `${GOAL_TAG_KEYS.maxRecursionDepth}=1`,
      `${GOAL_TAG_KEYS.maxStalledIterations}=2`,
    ];
    expect(() => decodeGoalTags(tags)).toThrow();
  });

  it("rejects a malformed budget at encode time", () => {
    expect(() =>
      encodeGoalTags(80, { ...DEFAULT_LOOP_BUDGET, maxTokens: -1 })
    ).toThrow();
  });
});

function goalRow(overrides: Partial<Knowledge> = {}): Knowledge {
  return {
    id: "goal-1",
    domain: "oss-ai",
    title: "a bounded loop can drive coverage >= 80",
    content: "…",
    entryType: "hypothesis",
    sourceType: "agent",
    resolutionStrategy: "metric:oss-frontier-coverage",
    tags: encodeGoalTags(80, DEFAULT_LOOP_BUDGET),
    evaluateAt: EVAL_AT,
    ...overrides,
  };
}

describe("goalFromRow — hypothesis row → Goal projection", () => {
  it("projects a well-formed goal row", () => {
    const res = goalFromRow(goalRow());
    expect(res).not.toBeNull();
    expect(res?.goal).toEqual({
      hypothesisId: "goal-1",
      domain: "oss-ai",
      kpiId: "oss-frontier-coverage",
      target: 80,
      evaluateAt: EVAL_AT,
    });
    expect(res?.budget).toEqual(DEFAULT_LOOP_BUDGET);
  });

  it("returns null when resolution_strategy is not `metric:`", () => {
    expect(goalFromRow(goalRow({ resolutionStrategy: "agent" }))).toBeNull();
    expect(goalFromRow(goalRow({ resolutionStrategy: null }))).toBeNull();
  });

  it("returns null when evaluate_at is absent", () => {
    expect(goalFromRow(goalRow({ evaluateAt: null }))).toBeNull();
  });

  it("returns null when the goal tags are undecodable", () => {
    expect(goalFromRow(goalRow({ tags: ["oss-ai"] }))).toBeNull();
  });
});
