// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/review/criteria-evaluator`
 * Purpose: Deterministic threshold evaluation for PR review success criteria.
 * Scope: Pure function — compares metric scores against thresholds. Does not call LLM or perform I/O.
 * Invariants: Comparison operators (gte, gt, lte, lt, eq) are exhaustive. Missing metrics handled via neutral_on_missing_metrics flag.
 * Side-effects: none
 * Links: task.0153, packages/repo-spec/src/schema.ts (SuccessCriteria)
 * @public
 */

import type { SuccessCriteria, ThresholdCriterion } from "@cogni/repo-spec";

import type { GateStatus } from "./types";

const OP_SYMBOLS: Record<string, string> = {
  gte: "\u2265",
  gt: ">",
  lte: "\u2264",
  lt: "<",
  eq: "=",
};

/**
 * Format a threshold criterion as a human-readable string (e.g., "≥ 0.80").
 * Returns undefined if the threshold has no recognised operator.
 */
export function formatThreshold(
  threshold: ThresholdCriterion
): string | undefined {
  for (const op of Object.keys(OP_SYMBOLS)) {
    if (
      op in threshold &&
      typeof (threshold as Record<string, unknown>)[op] === "number"
    ) {
      const value = (threshold as Record<string, unknown>)[op] as number;
      return `${OP_SYMBOLS[op]} ${value.toFixed(2)}`;
    }
  }
  return undefined;
}

/**
 * Look up the requirement string for a given metric across all criteria.
 * Appends "(all)" for require[] or "(any)" for any_of[] group context.
 */
export function findRequirement(
  metricName: string,
  criteria: SuccessCriteria
): string | undefined {
  const reqMatch = (criteria.require ?? []).find(
    (t) => t.metric === metricName
  );
  if (reqMatch) {
    const formatted = formatThreshold(reqMatch);
    return formatted ? `${formatted} (all)` : undefined;
  }

  const anyMatch = (criteria.any_of ?? []).find((t) => t.metric === metricName);
  if (anyMatch) {
    const formatted = formatThreshold(anyMatch);
    return formatted ? `${formatted} (any)` : undefined;
  }

  return undefined;
}

/**
 * Evaluate metric scores against success criteria.
 * Returns "pass", "fail", or "neutral".
 */
export function evaluateCriteria(
  scores: ReadonlyMap<string, number>,
  criteria: SuccessCriteria
): GateStatus {
  const { require, any_of, neutral_on_missing_metrics } = criteria;

  // If require[] is present, ALL must pass
  if (require && require.length > 0) {
    for (const threshold of require) {
      const result = evaluateThreshold(
        scores,
        threshold,
        neutral_on_missing_metrics
      );
      if (result === "fail") return "fail";
      if (result === "neutral") return "neutral";
    }
  }

  // If any_of[] is present, AT LEAST ONE must pass
  if (any_of && any_of.length > 0) {
    let hasPass = false;
    let hasNeutral = false;
    for (const threshold of any_of) {
      const result = evaluateThreshold(
        scores,
        threshold,
        neutral_on_missing_metrics
      );
      if (result === "pass") {
        hasPass = true;
        break;
      }
      if (result === "neutral") hasNeutral = true;
    }
    if (!hasPass) {
      return hasNeutral ? "neutral" : "fail";
    }
  }

  return "pass";
}

/**
 * Evaluate a single threshold criterion against scores.
 */
function evaluateThreshold(
  scores: ReadonlyMap<string, number>,
  threshold: Record<string, unknown>,
  neutralOnMissing: boolean
): GateStatus {
  const metric = threshold.metric as string;
  const score = scores.get(metric);

  if (score === undefined) {
    return neutralOnMissing ? "neutral" : "fail";
  }

  // Find the comparison operator
  if ("gte" in threshold && typeof threshold.gte === "number") {
    return score >= threshold.gte ? "pass" : "fail";
  }
  if ("gt" in threshold && typeof threshold.gt === "number") {
    return score > threshold.gt ? "pass" : "fail";
  }
  if ("lte" in threshold && typeof threshold.lte === "number") {
    return score <= threshold.lte ? "pass" : "fail";
  }
  if ("lt" in threshold && typeof threshold.lt === "number") {
    return score < threshold.lt ? "pass" : "fail";
  }
  if ("eq" in threshold && typeof threshold.eq === "number") {
    return Math.abs(score - threshold.eq) < 0.001 ? "pass" : "fail";
  }

  // No operator found — treat as neutral
  return "neutral";
}
