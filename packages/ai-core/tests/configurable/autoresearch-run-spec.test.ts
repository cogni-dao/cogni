// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-core/tests/configurable/autoresearch-run-spec`
 * Purpose: Cover the typed autoresearch run contract at the package boundary.
 * Scope: Schema validation only; does NOT invoke graph or app execution.
 * Invariants:
 *   - Comparable fanout requires one objective, one metric, bounded memory, and bounded budget.
 *   - GraphRunConfig carries the parsed contract through RunnableConfig.configurable.
 * Side-effects: none
 * Links: packages/ai-core/src/configurable/autoresearch-run-spec.ts
 * @internal
 */

import { describe, expect, it } from "vitest";
import {
  AUTORESEARCH_RUN_SPEC_VERSION,
  AutoresearchRunSpecSchema,
} from "../../src/configurable/autoresearch-run-spec";
import { GraphRunConfigSchema } from "../../src/configurable/graph-run-config";

const VALID_SPEC = {
  version: AUTORESEARCH_RUN_SPEC_VERSION,
  mission: {
    objective: "Increase accepted autoresearch inbox contributions.",
    question: "Which bounded graph variant improves acceptance rate?",
    targetGraphId: "langgraph:autoresearch-single-lane",
    mutableSurface: "prompt",
    nonGoals: ["Do not add app routes."],
  },
  rewardMetric: {
    name: "accepted_inbox_contribution_rate",
    kpi: "Accepted contribution rate",
    direction: "increase",
    baseline: 0.4,
    targetDelta: 0.1,
    source: "human_feedback",
    formula: "thumbs_up / max(1, thumbs_up + thumbs_down)",
    measurement: "Human feedback on inbox contribution cards.",
    keepThreshold: 0.65,
    revertThreshold: 0.35,
    humanFeedbackFallback: {
      enabled: true,
      positiveSignal: "thumbs_up",
      negativeSignal: "thumbs_down",
      aggregation: "thumbs_ratio",
      appliesWhen: "metric_unavailable",
    },
  },
  memory: {
    layers: [
      {
        layer: "knowledge_hub",
        query: "autoresearch accepted contribution feedback",
        topK: 5,
        required: true,
      },
    ],
    domains: ["meta"],
    recallQueries: ["autoresearch accepted contribution feedback"],
    confidenceFloor: 30,
    requiredCitations: 1,
    timePriority: "balanced",
    linkedInfoPolicy:
      "Prefer current EDO outcomes, then durable knowledge linked to the active metric.",
  },
  budget: {
    maxCostUsd: 2,
    maxWallClockMinutes: 20,
    maxLlmCalls: 12,
    maxToolCalls: 30,
  },
  edo: {
    hypothesisId: "hyp.autoresearch.acceptance",
    resolutionStrategy: "manual",
    evidenceForIds: ["edo.accepted-contribution-rate"],
  },
  fanout: {
    variantIndex: 1,
    variantsPerGraph: 2,
    maxLanes: 2,
    maxKnowledgeSearches: 4,
    maxWebSearches: 1,
    maxRepoReads: 6,
    maxTurns: 8,
  },
  driftGuard: {
    allowedPaths: ["packages/langgraph-graphs/src/graphs/autoresearch"],
    forbiddenPaths: ["infra"],
    stopIfNoMetric: true,
    stopIfNoKnowledgeRecall: true,
    stopIfNoEdoLink: false,
  },
  stopCriteria: [
    { criterion: "max_turns", threshold: 8 },
    {
      criterion: "reward_threshold",
      threshold: 0.65,
      metricName: "accepted_inbox_contribution_rate",
    },
  ],
  selectionPolicy: "pareto",
};

describe("AutoresearchRunSpecSchema", () => {
  it("parses a complete objective, metric, memory policy, fanout, and drift guard", () => {
    const parsed = AutoresearchRunSpecSchema.parse(VALID_SPEC);

    expect(parsed.version).toBe(AUTORESEARCH_RUN_SPEC_VERSION);
    expect(parsed.mission.targetGraphId).toBe(
      "langgraph:autoresearch-single-lane"
    );
    expect(parsed.rewardMetric.name).toBe("accepted_inbox_contribution_rate");
    expect(parsed.memory.layers[0]?.required).toBe(true);
    expect(parsed.fanout.variantsPerGraph).toBe(2);
    expect(parsed.selectionPolicy).toBe("pareto");
  });

  it("applies defaults to optional mission, EDO, and drift path fields", () => {
    const parsed = AutoresearchRunSpecSchema.parse({
      ...VALID_SPEC,
      mission: {
        objective: VALID_SPEC.mission.objective,
        question: VALID_SPEC.mission.question,
        targetGraphId: VALID_SPEC.mission.targetGraphId,
        mutableSurface: "schedule_prompt",
      },
      edo: {},
      driftGuard: {
        stopIfNoMetric: true,
        stopIfNoKnowledgeRecall: true,
        stopIfNoEdoLink: true,
      },
      selectionPolicy: "best_reward",
      fanout: {
        ...VALID_SPEC.fanout,
        variantsPerGraph: 1,
      },
    });

    expect(parsed.mission.nonGoals).toEqual([]);
    expect(parsed.edo.resolutionStrategy).toBe("manual");
    expect(parsed.edo.evidenceForIds).toEqual([]);
    expect(parsed.driftGuard.allowedPaths).toEqual([]);
    expect(parsed.driftGuard.forbiddenPaths).toEqual([]);
  });

  it("requires evalCommand only for eval-command reward metrics", () => {
    expect(
      AutoresearchRunSpecSchema.safeParse({
        ...VALID_SPEC,
        rewardMetric: {
          ...VALID_SPEC.rewardMetric,
          source: "eval_command",
        },
      }).success
    ).toBe(false);

    const parsed = AutoresearchRunSpecSchema.parse({
      ...VALID_SPEC,
      rewardMetric: {
        ...VALID_SPEC.rewardMetric,
        source: "eval_command",
        evalCommand: "pnpm test:packages:local",
      },
    });

    expect(parsed.rewardMetric.evalCommand).toBe("pnpm test:packages:local");
  });

  it("requires multiple variants for pareto selection", () => {
    expect(
      AutoresearchRunSpecSchema.safeParse({
        ...VALID_SPEC,
        fanout: {
          ...VALID_SPEC.fanout,
          variantsPerGraph: 1,
        },
      }).success
    ).toBe(false);

    const parsed = AutoresearchRunSpecSchema.parse({
      ...VALID_SPEC,
      fanout: {
        ...VALID_SPEC.fanout,
        variantsPerGraph: 1,
      },
      selectionPolicy: "judge_then_reward",
    });

    expect(parsed.selectionPolicy).toBe("judge_then_reward");
  });

  it("rejects unbounded memory, missing recall, and impossible budgets", () => {
    expect(
      AutoresearchRunSpecSchema.safeParse({
        ...VALID_SPEC,
        memory: {
          ...VALID_SPEC.memory,
          layers: [
            {
              layer: "knowledge_hub",
              query: "too many",
              topK: 51,
              required: true,
            },
          ],
        },
      }).success
    ).toBe(false);

    expect(
      AutoresearchRunSpecSchema.safeParse({
        ...VALID_SPEC,
        memory: {
          ...VALID_SPEC.memory,
          recallQueries: [],
        },
      }).success
    ).toBe(false);

    expect(
      AutoresearchRunSpecSchema.safeParse({
        ...VALID_SPEC,
        budget: {
          ...VALID_SPEC.budget,
          maxWallClockMinutes: 0,
        },
      }).success
    ).toBe(false);
  });
});

describe("GraphRunConfigSchema", () => {
  it("carries the autoresearch contract and defaults attempts", () => {
    const parsed = GraphRunConfigSchema.parse({
      model: "gpt-4o-mini",
      runId: "run.autoresearch.1",
      billingAccountId: "acct.operator",
      virtualKeyId: "vk.operator",
      traceId: "trace.autoresearch.1",
      toolIds: ["knowledge_search", "edo_create_hypothesis"],
      autoresearch: VALID_SPEC,
    });

    expect(parsed.attempt).toBe(0);
    expect(parsed.autoresearch?.mission.question).toContain("acceptance rate");
    expect(parsed.toolIds).toEqual([
      "knowledge_search",
      "edo_create_hypothesis",
    ]);
  });

  it("rejects malformed nested autoresearch config", () => {
    const result = GraphRunConfigSchema.safeParse({
      model: "gpt-4o-mini",
      runId: "run.autoresearch.2",
      billingAccountId: "acct.operator",
      virtualKeyId: "vk.operator",
      autoresearch: {
        ...VALID_SPEC,
        selectionPolicy: "pareto",
        fanout: {
          ...VALID_SPEC.fanout,
          variantsPerGraph: 1,
        },
      },
    });

    expect(result.success).toBe(false);
  });
});
