// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tests/graphs/autoresearch/run-spec`
 * Purpose: Validate the autoresearch run spec and prompt drift guards.
 * Scope: Schema + prompt contract only; does not invoke an LLM.
 * Invariants:
 *   - RUN_SPEC_REQUIRED_FOR_COMPARABLE_FANOUT: objective, metric, memory, and budget are typed
 *   - PROMPT_ECHOES_REWARD_BOUNDARY: prompts require objective and reward metric in output
 * Side-effects: none
 * Links: packages/ai-core/src/configurable/autoresearch-run-spec.ts
 * @internal
 */

import {
  AutoresearchRunSpecSchema,
  GraphRunConfigSchema,
} from "@cogni/ai-core";
import { describe, expect, it } from "vitest";
import { buildAutoresearchSystemPrompt } from "../../../src/graphs/autoresearch/graph";
import {
  AUTORESEARCH_REGISTRY_SWARM_PROMPT,
  AUTORESEARCH_SINGLE_LANE_PROMPT,
  AUTORESEARCH_SYNTROPY_LOOP_PROMPT,
} from "../../../src/graphs/autoresearch/prompts";

const VALID_SPEC = {
  version: 1,
  mission: {
    objective: "Improve autoresearch inbox contribution quality.",
    question:
      "Which prompt variant yields the best accepted contribution rate?",
    targetGraphId: "langgraph:autoresearch-syntropy-loop",
    mutableSurface: "schedule_prompt",
    nonGoals: ["Do not change graph topology."],
  },
  rewardMetric: {
    name: "accepted_inbox_contribution_rate",
    kpi: "Accepted autoresearch contribution rate",
    direction: "increase",
    baseline: 0,
    targetDelta: 0.1,
    source: "human_feedback",
    formula: "thumbs_up / max(1, thumbs_up + thumbs_down)",
    measurement:
      "Human thumbs-up divided by total autoresearch inbox contributions.",
    keepThreshold: 0.6,
    revertThreshold: 0.3,
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
        query: "autoresearch KPI schedule feedback",
        topK: 5,
        required: true,
      },
      {
        layer: "repo",
        query: "autoresearch prompt graph catalog",
        topK: 8,
        required: true,
      },
    ],
    domains: ["meta"],
    recallQueries: ["autoresearch KPI schedule feedback"],
    confidenceFloor: 30,
    requiredCitations: 1,
    timePriority: "balanced",
    linkedInfoPolicy:
      "Prefer recent EDO outcomes, then high-confidence durable entries linked to the active hypothesis.",
  },
  budget: {
    maxCostUsd: 2,
    maxWallClockMinutes: 20,
    maxLlmCalls: 12,
    maxToolCalls: 30,
  },
  edo: {
    resolutionStrategy: "manual",
    evidenceForIds: [],
  },
  fanout: {
    variantIndex: 0,
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
      threshold: 0.6,
      metricName: "accepted_inbox_contribution_rate",
    },
    { criterion: "no_required_recall" },
  ],
  selectionPolicy: "pareto",
};

describe("AutoresearchRunSpecSchema", () => {
  it("accepts a bounded mission, reward metric, memory policy, and fanout budget", () => {
    const parsed = AutoresearchRunSpecSchema.parse(VALID_SPEC);
    expect(parsed.mission.objective).toContain("inbox contribution quality");
    expect(parsed.rewardMetric.name).toBe("accepted_inbox_contribution_rate");
    expect(parsed.rewardMetric.humanFeedbackFallback.positiveSignal).toBe(
      "thumbs_up"
    );
    expect(parsed.memory.layers[0]?.layer).toBe("knowledge_hub");
    expect(parsed.budget.maxWallClockMinutes).toBe(20);
    expect(parsed.stopCriteria.map((c) => c.criterion)).toContain(
      "reward_threshold"
    );
    expect(parsed.selectionPolicy).toBe("pareto");
  });

  it("requires evalCommand when eval_command is the reward source", () => {
    const result = AutoresearchRunSpecSchema.safeParse({
      ...VALID_SPEC,
      rewardMetric: {
        ...VALID_SPEC.rewardMetric,
        source: "eval_command",
      },
    });
    expect(result.success).toBe(false);
  });

  it("requires at least two variants for pareto selection", () => {
    const result = AutoresearchRunSpecSchema.safeParse({
      ...VALID_SPEC,
      fanout: {
        ...VALID_SPEC.fanout,
        variantsPerGraph: 1,
      },
    });
    expect(result.success).toBe(false);
  });

  it("travels through GraphRunConfig.configurable as JSON", () => {
    const parsed = GraphRunConfigSchema.parse({
      model: "devstral",
      runId: "run_1",
      billingAccountId: "acct_1",
      virtualKeyId: "vk_1",
      toolIds: ["knowledge_search"],
      autoresearch: VALID_SPEC,
    });

    expect(parsed.autoresearch?.mission.targetGraphId).toBe(
      "langgraph:autoresearch-syntropy-loop"
    );
  });
});

describe("autoresearch prompts", () => {
  it("bind every variant to the run spec, reward metric, and drift guard", () => {
    for (const prompt of [
      AUTORESEARCH_SINGLE_LANE_PROMPT,
      AUTORESEARCH_SYNTROPY_LOOP_PROMPT,
      AUTORESEARCH_REGISTRY_SWARM_PROMPT,
    ]) {
      expect(prompt).toContain("AUTORESEARCH_RUN_SPEC");
      expect(prompt).toContain("rewardMetric");
      expect(prompt).toContain("memory.layers");
      expect(prompt).toContain("budget.maxCostUsd");
      expect(prompt).toContain("driftGuard");
      expect(prompt).toContain("stopCriteria");
      expect(prompt).toContain("selectionPolicy");
      expect(prompt).toContain("fanout.maxKnowledgeSearches");
    }
  });

  it("renders a configured run spec into the system prompt", () => {
    const prompt = buildAutoresearchSystemPrompt("base prompt", VALID_SPEC);
    expect(prompt).toContain("AUTORESEARCH_RUN_SPEC");
    expect(prompt).toContain("accepted_inbox_contribution_rate");
    expect(prompt).toContain("Improve autoresearch inbox contribution quality");
    expect(prompt).toContain("humanFeedbackFallback");
    expect(prompt).toContain(
      "Do not substitute a generic autoresearch mission"
    );
    expect(prompt).toContain("runSpec");
  });

  it("does not add a user mission when no run spec is provided", () => {
    const prompt = buildAutoresearchSystemPrompt("base prompt");
    expect(prompt).toBe("base prompt");
  });
});
