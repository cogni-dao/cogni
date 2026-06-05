import type { ModelRef } from "@cogni/ai-core";
import type { ScheduleCreateInput } from "@cogni/node-contracts";

export const AUTORESEARCH_PARETO_SCHEDULE_COUNT = 6;

const AUTORESEARCH_GRAPHS = [
  {
    graphId: "langgraph:autoresearch-single-lane",
    variant: "single-lane",
    cronBaseHourUtc: 13,
    mission:
      "Find one small prompt, tool-policy, or eval-rubric improvement for an existing Cogni graph.",
    objective:
      "Produce one falsifiable experiment packet that a follow-up implementation agent can apply or reject.",
    comparableMetric: {
      name: "net_experiment_value",
      direction: "maximize",
      unit: "0_to_100_score",
      definition:
        "judge_score + expected_metric_delta + evidence_quality - complexity_penalty - drift_penalty",
    },
  },
  {
    graphId: "langgraph:autoresearch-syntropy-loop",
    variant: "syntropy-loop",
    cronBaseHourUtc: 15,
    mission:
      "Use knowledge recall to identify one durable, low-entropy improvement opportunity.",
    objective:
      "Return an experiment plan and a file-back decision that prefers refining existing knowledge over adding new entries.",
    comparableMetric: {
      name: "syntropy_adjusted_value",
      direction: "maximize",
      unit: "0_to_100_score",
      definition:
        "eval_quality + recall_bonus + citation_bonus - complexity_penalty - knowledge_sprawl_penalty",
    },
  },
  {
    graphId: "langgraph:autoresearch-registry-swarm",
    variant: "registry-swarm",
    cronBaseHourUtc: 17,
    mission:
      "Compare bounded autoresearch lanes and promote only a registry-ready winner.",
    objective:
      "Return comparable lane plans with one promotion criterion, rollback path, and descriptor-update recommendation.",
    comparableMetric: {
      name: "tournament_score",
      direction: "maximize",
      unit: "0_to_100_score",
      definition:
        "0.50*eval_quality + 0.20*confidence_delta + 0.15*attention_alignment + 0.10*cost_efficiency + 0.05*latency_efficiency - complexity_penalty",
    },
  },
] as const;

const PROMPT_VARIATIONS = [
  {
    id: "pareto-exploit",
    label: "Pareto exploit",
    dayOfWeekUtc: 1,
    priority: "P1",
    instruction:
      "Prefer the highest-confidence small change already implied by linked work, specs, recent PRs, or knowledge.",
  },
  {
    id: "pareto-explore",
    label: "Pareto explore",
    dayOfWeekUtc: 4,
    priority: "P2",
    instruction:
      "Prefer a neglected high-upside linked lead where the evidence is thin but the measurable payoff could be large.",
  },
] as const;

interface BuildAutoresearchParetoSchedulesParams {
  modelRef: ModelRef;
  timezone: string;
  now?: Date;
}

function cronFor(graphIndex: number, variationIndex: number): string {
  const graph = AUTORESEARCH_GRAPHS[graphIndex];
  const variation = PROMPT_VARIATIONS[variationIndex];
  if (!graph || !variation) {
    throw new Error("Invalid autoresearch Pareto preset index");
  }

  const minute = variationIndex * 30;
  const hour = (graph.cronBaseHourUtc + variationIndex) % 24;
  return `${minute} ${hour} * * ${variation.dayOfWeekUtc}`;
}

function buildLinkedInfoInstruction(params: {
  launchedAtIso: string;
  priority: string;
}): string {
  return [
    `Run timestamp: ${params.launchedAtIso}.`,
    `First retrieve linked information by priority ${params.priority}, then by recency.`,
    "Prioritize active work items, project specs, recent PR/CI state, and knowledge entries directly linked to the target graph or metric.",
    "If linked evidence conflicts, keep the newest source and cite the conflict instead of averaging it away.",
  ].join(" ");
}

function buildRecurringPrompt(params: {
  mission: string;
  objective: string;
  comparableMetricName: string;
  comparableMetricDefinition: string;
  linkedInfoInstruction: string;
  promptVariationLabel: string;
  promptVariationInstruction: string;
}) {
  return [
    "Run this recurring autoresearch Pareto preset.",
    "",
    `Mission: ${params.mission}`,
    `Objective: ${params.objective}`,
    `Comparable metric: ${params.comparableMetricName} (${params.comparableMetricDefinition}).`,
    `Linked info instruction: ${params.linkedInfoInstruction}`,
    `Prompt variation: ${params.promptVariationLabel}. ${params.promptVariationInstruction}`,
    "",
    "Return one compact JSON object with the fields requested by this graph variant, including the metric value needed to compare this run against the paired variation.",
  ].join("\n");
}

export function buildAutoresearchParetoSchedules({
  modelRef,
  timezone,
  now = new Date(),
}: BuildAutoresearchParetoSchedulesParams): ScheduleCreateInput[] {
  const launchedAtIso = now.toISOString();

  return AUTORESEARCH_GRAPHS.flatMap((graph, graphIndex) =>
    PROMPT_VARIATIONS.map((variation, variationIndex) => {
      const linkedInfoInstruction = buildLinkedInfoInstruction({
        launchedAtIso,
        priority: variation.priority,
      });
      const recurringPrompt = buildRecurringPrompt({
        mission: graph.mission,
        objective: graph.objective,
        comparableMetricName: graph.comparableMetric.name,
        comparableMetricDefinition: graph.comparableMetric.definition,
        linkedInfoInstruction,
        promptVariationLabel: variation.label,
        promptVariationInstruction: variation.instruction,
      });

      return {
        graphId: graph.graphId,
        cron: cronFor(graphIndex, variationIndex),
        timezone,
        input: {
          messages: [{ role: "user", content: recurringPrompt }],
          modelRef,
          recurringPrompt,
          linkedInfoInstruction,
          mission: graph.mission,
          objective: graph.objective,
          comparableMetric: graph.comparableMetric,
          paretoPreset: {
            id: "node-template-autoresearch-pareto",
            graphVariant: graph.variant,
            promptVariationId: variation.id,
            promptVariationLabel: variation.label,
            launchedAt: launchedAtIso,
            priority: variation.priority,
          },
        },
      };
    })
  );
}
