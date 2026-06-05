// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-core/configurable/autoresearch-run-spec`
 * Purpose: JSON-serializable run contract for drift-resistant autoresearch.
 * Scope: Defines objective, reward metric, memory policy, EDO linkage, fanout budget, and drift guard. Does not execute runs.
 * Invariants:
 *   - JSON-serializable only; no functions, commands are strings
 *   - One run spec owns one mission and one primary reward metric
 *   - Fanout is bounded before orchestration starts
 * Side-effects: none
 * Links: docs/spec/langgraph-patterns.md, docs/spec/graph-execution.md
 * @public
 */

import { z } from "zod";

export const AUTORESEARCH_RUN_SPEC_VERSION = 1 as const;

export const AutoresearchMutableSurfaceSchema = z.enum([
  "prompt",
  "tool_allowlist",
  "rubric",
  "topology",
  "memory_policy",
  "schedule_prompt",
]);

export const AutoresearchRewardSourceSchema = z.enum([
  "eval_command",
  "metrics_query",
  "manual_scorecard",
  "human_feedback",
]);

export const AutoresearchSelectionPolicySchema = z.enum([
  "best_reward",
  "pareto",
  "judge_then_reward",
]);

export const AutoresearchMemoryLayerSchema = z.enum([
  "knowledge_hub",
  "repo",
  "work_items",
  "prior_runs",
  "telemetry",
  "web",
]);

export const AutoresearchStopCriterionSchema = z.enum([
  "max_turns",
  "max_cost",
  "max_wall_clock",
  "reward_threshold",
  "no_metric",
  "no_required_recall",
  "human_stop",
]);

export const AutoresearchRunSpecSchema = z
  .object({
    version: z.literal(AUTORESEARCH_RUN_SPEC_VERSION),
    mission: z.object({
      objective: z.string().min(1).max(2_000),
      question: z.string().min(1).max(1_000),
      targetGraphId: z.string().min(1),
      mutableSurface: AutoresearchMutableSurfaceSchema,
      nonGoals: z.array(z.string().min(1).max(500)).max(12).default([]),
    }),
    rewardMetric: z.object({
      name: z.string().min(1).max(200),
      kpi: z.string().min(1).max(500),
      direction: z.enum(["increase", "decrease"]),
      baseline: z.number().finite().nullable(),
      targetDelta: z.number().finite(),
      source: AutoresearchRewardSourceSchema,
      formula: z.string().min(1).max(1_000),
      measurement: z.string().min(1).max(1_000),
      evalCommand: z.string().min(1).max(1_000).optional(),
      keepThreshold: z.number().finite(),
      revertThreshold: z.number().finite(),
      humanFeedbackFallback: z.object({
        enabled: z.boolean(),
        positiveSignal: z.literal("thumbs_up"),
        negativeSignal: z.literal("thumbs_down"),
        aggregation: z.enum(["net_thumbs", "thumbs_ratio", "latest_thumb"]),
        appliesWhen: z.enum(["metric_unavailable", "metric_tie", "always"]),
      }),
    }),
    memory: z.object({
      layers: z
        .array(
          z.object({
            layer: AutoresearchMemoryLayerSchema,
            query: z.string().min(1).max(500),
            topK: z.number().int().min(1).max(50),
            required: z.boolean(),
          })
        )
        .min(1)
        .max(12),
      domains: z.array(z.string().min(1).max(80)).min(1).max(8),
      recallQueries: z.array(z.string().min(1).max(500)).min(1).max(12),
      confidenceFloor: z.number().int().min(0).max(100),
      requiredCitations: z.number().int().min(0).max(12),
      timePriority: z.enum(["recent_first", "durable_first", "balanced"]),
      linkedInfoPolicy: z
        .string()
        .min(1)
        .max(1_000)
        .describe(
          "How the agent should select dynamically linked recall context."
        ),
    }),
    budget: z.object({
      maxCostUsd: z.number().finite().nonnegative(),
      maxWallClockMinutes: z
        .number()
        .int()
        .min(1)
        .max(24 * 60),
      maxLlmCalls: z.number().int().min(1).max(200),
      maxToolCalls: z.number().int().min(1).max(500),
    }),
    edo: z.object({
      hypothesisId: z.string().min(1).max(200).optional(),
      evaluateAt: z.string().datetime().optional(),
      resolutionStrategy: z.enum(["manual", "agent"]).default("manual"),
      evidenceForIds: z.array(z.string().min(1).max(200)).max(20).default([]),
    }),
    fanout: z.object({
      variantIndex: z.number().int().min(0).optional(),
      variantsPerGraph: z.number().int().min(1).max(10),
      maxLanes: z.number().int().min(1).max(3),
      maxKnowledgeSearches: z.number().int().min(0).max(20),
      maxWebSearches: z.number().int().min(0).max(10),
      maxRepoReads: z.number().int().min(0).max(30),
      maxTurns: z.number().int().min(1).max(20),
    }),
    driftGuard: z.object({
      allowedPaths: z.array(z.string().min(1).max(300)).max(30).default([]),
      forbiddenPaths: z.array(z.string().min(1).max(300)).max(30).default([]),
      stopIfNoMetric: z.boolean(),
      stopIfNoKnowledgeRecall: z.boolean(),
      stopIfNoEdoLink: z.boolean(),
    }),
    stopCriteria: z
      .array(
        z.object({
          criterion: AutoresearchStopCriterionSchema,
          threshold: z.number().finite().optional(),
          metricName: z.string().min(1).max(200).optional(),
        })
      )
      .min(1)
      .max(12),
    selectionPolicy: AutoresearchSelectionPolicySchema,
  })
  .superRefine((spec, ctx) => {
    if (
      spec.rewardMetric.source === "eval_command" &&
      !spec.rewardMetric.evalCommand
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rewardMetric", "evalCommand"],
        message: "evalCommand is required when reward source is eval_command",
      });
    }

    if (spec.selectionPolicy === "pareto" && spec.fanout.variantsPerGraph < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fanout", "variantsPerGraph"],
        message: "pareto selection requires at least two variants per graph",
      });
    }
  });

export type AutoresearchRunSpec = z.infer<typeof AutoresearchRunSpecSchema>;
