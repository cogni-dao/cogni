// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/ai-health/ai-kpis`
 * Purpose: The operator's node-local goal-metric calculator for fleet-wide AI errors (task.5468, story.5153):
 *   `ai.run-errors@1` reads the AI run and chat-turn outcomes every node writes to Grafana Cloud Loki and
 *   reports counts and error rates per env. Registered through `@cogni-dao/metrics` `createGoalMetrics({ nodeCalculators })`.
 * Scope: Pure query building, aggregation and the calculator object. The only IO is the injected
 *   `LokiReaderPort.queryInstant`, called through `ctx.read`.
 * Invariants:
 *   - ENV_FROM_ENUM: the LogQL env label and the window hours come only from the validated params (an enum and an
 *     integer). No free text reaches a query.
 *   - RUN_OUTCOME_IS_FINALIZED_LINE: a run is one `Finalized execution request` log line; it failed when `ok="false"`.
 *   - CHAT_OUTCOME_IS_CLOSE_OR_FINAL_ERROR: a chat turn is an `ai.chat_stream_closed` line; it failed when an
 *     `ai.chat_stream_final_error` line exists for it.
 *   - NO_SILENT_ZERO: a zero denominator, a failed Loki read or a missing reader is an incomplete sample with a
 *     reason (`zero_denominator`, `source_failed`, `calculator_unavailable` plus an `ai:source_unconfigured` evidence ref,
 *     because the package reason enum has no `source_unconfigured`), never 0%.
 *   - PERCENT_FLOORS: rates floor to three decimals in integer arithmetic, so rounding never turns a breach into a pass.
 *   - IDS_USE_DASHES: the calculator id matches `MetricSpecSchema.calculatorId` (no underscores).
 * Side-effects: none (the calculator calls the injected reader)
 * Links: ports/loki-reader.port.ts, bootstrap/capabilities/goal-metrics.ts, features/node-deploy/fleet-kpis.ts,
 *   story.5153, task.5468
 * @public
 */

import type {
  MetricCalculator,
  MetricSample,
} from "@cogni-dao/metrics/contracts";
import { z } from "zod";
import type { LokiInstantSample, LokiReaderPort } from "@/ports";

export const RUN_ERRORS_ID = "ai.run-errors@1";

/** Evidence lists at most this many nodes. */
const MAX_EVIDENCE = 20;
/** Most series one aggregation may return before the read counts as truncated. */
const MAX_SERIES = 2_000;

export const AI_ENVS = ["production", "preview", "candidate-a"] as const;
export const AI_OUTPUTS = [
  "run_error_rate",
  "runs",
  "run_failed",
  "chat_error_rate",
  "chat_turns",
] as const;
export type AiOutput = (typeof AI_OUTPUTS)[number];

const paramsSchema = z.strictObject({
  env: z.enum(AI_ENVS),
  output: z.enum(AI_OUTPUTS),
  hours: z.number().int().min(1).max(168),
});
type AiEnv = (typeof AI_ENVS)[number];

const isRate = (o: AiOutput) =>
  o === "run_error_rate" || o === "chat_error_rate";
const isChat = (o: AiOutput) => o === "chat_error_rate" || o === "chat_turns";

const unitOf = (o: AiOutput) =>
  isRate(o) ? "%" : isChat(o) ? "turns" : "runs";

/** `100 * numerator / denominator` floored to three decimals in integer arithmetic. */
export function percentFloor3(numerator: number, denominator: number): number {
  return Math.floor((100_000 * numerator) / denominator) / 1000;
}

/** LogQL for finished runs per node, outcome and error code. Inputs are the validated enum and integer only. */
export function runQuery(env: AiEnv, hours: number): string {
  return `sum by (node, ok, errorCode) (count_over_time({env="${env}",service=~"app.*|poly.*"} |= "Finalized execution request" | json ok="ok",errorCode="errorCode" [${hours}h]))`;
}

/** LogQL for chat-stream closes and final errors per node. */
export function chatQuery(env: AiEnv, hours: number): string {
  return `sum by (node, msg) (count_over_time({env="${env}",service=~"app.*|poly.*"} |~ "\\"msg\\":\\"ai.chat_(stream_closed|stream_final_error)\\"" | json msg="msg" [${hours}h]))`;
}

interface NodeTally {
  total: number;
  failed: number;
  codes: Map<string, number>;
}

const unknownSample = (
  unit: string,
  reason: NonNullable<MetricSample["reason"]>,
  asOf: string,
  evidenceRefs: string[]
): MetricSample => ({
  value: 0,
  unit,
  complete: false,
  reason,
  sourceWatermarks: [{ source: "loki", asOf }],
  evidenceRefs,
});

const nodeOf = (s: LokiInstantSample) => s.labels.node || "unknown";

const emptyTally = (): NodeTally => ({
  total: 0,
  failed: 0,
  codes: new Map<string, number>(),
});

/** Tally run outcomes per node: every series counts toward total; `ok="false"` counts as failed. */
export function tallyRuns(samples: readonly LokiInstantSample[]) {
  const nodes = new Map<string, NodeTally>();
  for (const s of samples) {
    const n = nodes.get(nodeOf(s)) ?? emptyTally();
    n.total += s.value;
    if (s.labels.ok === "false") {
      n.failed += s.value;
      const code = s.labels.errorCode || "unknown";
      n.codes.set(code, (n.codes.get(code) ?? 0) + s.value);
    }
    nodes.set(nodeOf(s), n);
  }
  return nodes;
}

/** Tally chat turns per node: `total` = stream closes, `failed` = final errors. */
export function tallyChat(samples: readonly LokiInstantSample[]) {
  const nodes = new Map<string, NodeTally>();
  for (const s of samples) {
    const n = nodes.get(nodeOf(s)) ?? emptyTally();
    if (s.labels.msg === "ai.chat_stream_closed") n.total += s.value;
    else if (s.labels.msg === "ai.chat_stream_final_error") n.failed += s.value;
    nodes.set(nodeOf(s), n);
  }
  return nodes;
}

const sumOf = (nodes: Map<string, NodeTally>) => {
  let total = 0;
  let failed = 0;
  for (const n of nodes.values()) {
    total += n.total;
    failed += n.failed;
  }
  return { total, failed };
};

function nodeEvidence(nodes: Map<string, NodeTally>, chat: boolean): string[] {
  return [...nodes.entries()]
    .sort(
      ([ak, a], [bk, b]) =>
        b.failed - a.failed || b.total - a.total || (ak < bk ? -1 : 1)
    )
    .slice(0, MAX_EVIDENCE)
    .map(([id, n]) => {
      if (chat) return `node:${id}:final_error=${n.failed}/${n.total}`;
      const codes = [...n.codes.entries()]
        .sort(([ak, a], [bk, b]) => b - a || (ak < bk ? -1 : 1))
        .map(([c, k]) => `${c}=${k}`)
        .join("|");
      return `node:${id}:failed=${n.failed}/${n.total}:codes=${codes}`;
    });
}

export interface AiCalculatorOptions {
  /** The Grafana Cloud Loki reader; absent when the operator has no read credential. */
  readonly loki: LokiReaderPort | undefined | null;
}

export function createAiCalculators({
  loki,
}: AiCalculatorOptions): MetricCalculator[] {
  const runErrors: MetricCalculator = {
    id: RUN_ERRORS_ID,
    unit: "%",
    unitFor: (params) => unitOf(paramsSchema.parse(params).output),
    displayFor: (params) =>
      isRate(paramsSchema.parse(params).output) ? "slo" : "volume",
    paramsSchema,
    budget: {
      timeoutMs: 20_000,
      maxSourceCalls: 2,
      maxRows: MAX_SERIES,
      maxResponseBytes: 2_097_152,
    },
    async compute(params, ctx) {
      const p = paramsSchema.parse(params);
      const unit = unitOf(p.output);
      const chat = isChat(p.output);
      const head = `ai:env=${p.env},hours=${p.hours}`;
      const endMs = new Date(ctx.window.end).getTime();
      const asOf = new Date(endMs).toISOString();
      if (!loki)
        return unknownSample(unit, "calculator_unavailable", asOf, [
          head,
          "ai:source_unconfigured",
        ]);

      const query = chat ? chatQuery(p.env, p.hours) : runQuery(p.env, p.hours);
      let samples: LokiInstantSample[];
      try {
        samples = await ctx.read((signal) => {
          // The port takes no signal; honor an already-aborted call before the request goes out.
          signal.throwIfAborted();
          return loki.queryInstant({ query, timeNs: `${endMs}000000` });
        });
      } catch {
        return unknownSample(unit, "source_failed", asOf, [head]);
      }
      if (samples.length > MAX_SERIES)
        return unknownSample(unit, "incomplete_or_invalid_source", asOf, [
          head,
          `ai:series>${MAX_SERIES}`,
        ]);

      const nodes = chat ? tallyChat(samples) : tallyRuns(samples);
      const { total, failed } = sumOf(nodes);
      const evidence = [
        chat
          ? `${head},chat_turns=${total},final_error=${failed}`
          : `${head},runs=${total},failed=${failed}`,
        ...nodeEvidence(nodes, chat),
      ];

      const value = isRate(p.output)
        ? total === 0
          ? undefined
          : percentFloor3(failed, total)
        : p.output === "runs" || p.output === "chat_turns"
          ? total
          : failed;
      if (value === undefined)
        return unknownSample(unit, "zero_denominator", asOf, evidence);
      return {
        value,
        unit,
        complete: true,
        sourceWatermarks: [{ source: "loki", asOf }],
        evidenceRefs: evidence,
      };
    },
  };
  return [runErrors];
}
