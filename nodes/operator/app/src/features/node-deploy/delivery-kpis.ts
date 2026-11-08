// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/delivery-kpis`
 * Purpose: The operator's node-local goal-metric calculators for delivery health (task.5442, story.5137):
 *   `deploy.serving-drift@1` (lanes not serving what was shipped), `deploy.release-success@1` (share of
 *   finished releases that activated, plus the raw finished count as its guardrail) and
 *   `deploy.lead-time@1` (p50/p90 minutes from release POST to first activation). Registered through
 *   `@cogni-dao/metrics` 0.4 `createGoalMetrics({ nodeCalculators })`.
 * Scope: Pure classification and the calculator objects. Reads go through `DeliveryKpiSourcePort`;
 *   this module does no IO itself.
 * Invariants:
 *   - RELEASE_STORE_ONLY: facts come from the operator Postgres release store and HTTP probes, never
 *     Prometheus (hub goal-metrics-vs-telemetry).
 *   - FINISHED_IS_AN_EVENT: a release finishes when it first activates (success) or the sequencer parks it
 *     (failure). The window counts finish instants in `[end - days, end)`. A release replaced before it
 *     finished (superseded) or still in flight counts as neither.
 *   - DURABLE_FINISH_INSTANTS: a failure is timed only by the write-once `attempts.parked_at` or the
 *     write-once admission refusal, never by the repeating `release_parked` step.
 *   - LEAD_TIME_IS_DURABLE: lead = `attempts.activated_at - releases.created_at`. A success without the
 *     write-once column is excluded and counted in evidence, never estimated.
 *   - UNKNOWN_IS_A_RESULT: zero lanes, zero finished releases, a truncated read or a probe that could not
 *     run yields an incomplete sample with a reason, never a pass and never zero.
 *   - EGRESS_CONTROL: drift probes the operator's own public `/livez` first. If that fails, or every
 *     probed lane gets no HTTP answer, the reading is unknown (`source_failed`), never N bad lanes.
 *   - IDS_USE_DASHES: calculator ids match `MetricSpecSchema.calculatorId` (no underscores).
 * Side-effects: none (calculators call the injected source)
 * Links: ports/delivery-kpi.port.ts, adapters/server/node-deploy/delivery-kpi-source.adapter.ts,
 *   bootstrap/capabilities/goal-metrics.ts, task.5442
 * @public
 */

import type {
  MetricCalculator,
  MetricSample,
} from "@cogni-dao/metrics/contracts";
import { z } from "zod";
import type {
  DeliveryKpiSourcePort,
  DeliveryLaneFacts,
  DeliveryProbeResult,
  DeliveryReleaseFacts,
  DeliveryScope,
} from "@/ports";

export const SERVING_DRIFT_ID = "deploy.serving-drift@1";
export const RELEASE_SUCCESS_ID = "deploy.release-success@1";
export const LEAD_TIME_ID = "deploy.lead-time@1";

/** Most lanes one drift reading probes; more is a truncated (unknown) reading. */
export const MAX_DRIFT_LANES = 64;
/** Most releases one window read returns; more is a truncated (unknown) reading. */
export const MAX_WINDOW_RELEASES = 5000;
/** Per-request probe bound. `/version` and `/readyz?deep=1` run in parallel per lane. */
export const PROBE_TIMEOUT_MS = 5000;
const PROBE_MAX_BYTES = 16384;
/** Evidence refs list at most this many bad lanes. */
const MAX_LANE_EVIDENCE = 20;

const scopeShape = {
  nodeId: z.uuid().optional(),
  env: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .optional(),
};
const daysSchema = z.number().int().min(1).max(28).default(7);

// ---------------------------------------------------------------------------------------------
// Release classification (KPIs 2 and 3)
// ---------------------------------------------------------------------------------------------

export type ReleaseOutcome =
  | { readonly kind: "success"; readonly at: Date; readonly leadMs?: number }
  | { readonly kind: "failure"; readonly at: Date }
  /**
   * Finished, but no durable instant: served with no activation column or step, or parked only by a
   * step from before the write-once `parked_at`. Excluded, counted.
   */
  | { readonly kind: "untimed" }
  /** Replaced by a newer release before it finished. */
  | { readonly kind: "superseded" }
  /** Still current and unfinished. */
  | { readonly kind: "in_flight" }
  /** Finished outside the window. */
  | { readonly kind: "outside" };

const within = (at: Date, from: Date, to: Date) =>
  at.getTime() >= from.getTime() && at.getTime() < to.getTime();

/** Classify one release against the half-open window `[from, to)`. */
export function classifyRelease(
  r: DeliveryReleaseFacts,
  from: Date,
  to: Date
): ReleaseOutcome {
  // First activation wins: it is the moment the deploy finished, whatever happened after.
  const activated = r.activatedAt ?? r.activatedStepAt;
  if (activated) {
    if (!within(activated, from, to)) return { kind: "outside" };
    return r.activatedAt
      ? {
          kind: "success",
          at: activated,
          leadMs: Math.max(0, r.activatedAt.getTime() - r.createdAt.getTime()),
        }
      : { kind: "success", at: activated };
  }
  if (r.served) return { kind: "untimed" };
  // Only the write-once park instant (or the write-once admission refusal) times a failure; the
  // repeating `release_parked` step does not (it drifts once the first one leaves the timeline).
  if (r.parkedAt)
    return within(r.parkedAt, from, to)
      ? { kind: "failure", at: r.parkedAt }
      : { kind: "outside" };
  if (r.parkStepSeen) return { kind: "untimed" };
  return r.current ? { kind: "in_flight" } : { kind: "superseded" };
}

export interface ReleaseWindowSummary {
  readonly success: number;
  readonly failure: number;
  readonly superseded: number;
  readonly inFlight: number;
  readonly untimed: number;
  /** Lead times (ms) of successes that carry the write-once column. */
  readonly leadMs: readonly number[];
  /** Successes without the column: excluded from lead time. */
  readonly missingActivatedAt: number;
}

export function summarizeReleases(
  rows: readonly DeliveryReleaseFacts[],
  from: Date,
  to: Date
): ReleaseWindowSummary {
  let success = 0;
  let failure = 0;
  let superseded = 0;
  let inFlight = 0;
  let untimed = 0;
  let missingActivatedAt = 0;
  const leadMs: number[] = [];
  for (const r of rows) {
    const o = classifyRelease(r, from, to);
    if (o.kind === "success") {
      success++;
      if (o.leadMs === undefined) missingActivatedAt++;
      else leadMs.push(o.leadMs);
    } else if (o.kind === "failure") failure++;
    // Neither-bucket counts speak about releases recorded inside the window only.
    else if (r.createdAt.getTime() >= from.getTime()) {
      if (o.kind === "superseded") superseded++;
      else if (o.kind === "in_flight") inFlight++;
      else if (o.kind === "untimed") untimed++;
    }
  }
  return {
    success,
    failure,
    superseded,
    inFlight,
    untimed,
    leadMs,
    missingActivatedAt,
  };
}

/** Nearest-rank percentile (q in 1..100) of a non-empty list. */
export function percentile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((q / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

// ---------------------------------------------------------------------------------------------
// Serving drift (KPI 1)
// ---------------------------------------------------------------------------------------------

export type LaneVerdict =
  | { readonly bad: false }
  | {
      readonly bad: true;
      readonly reason:
        | "no_active_attempt"
        | "stuck_release"
        | "unreachable/network"
        | "unreachable/timeout"
        | "unreachable/invalid_target"
        | "version_status"
        | "sha_mismatch"
        | "readyz_status";
    };

/** Lane verdict that needs no probe, or undefined when the lane must be probed. */
export function laneVerdictBeforeProbe(
  lane: DeliveryLaneFacts,
  nowMs: number,
  stuckMs: number
): LaneVerdict | undefined {
  if (!lane.activeReleaseId || !lane.expectedSha)
    return { bad: true, reason: "no_active_attempt" };
  // The desired release has had no active attempt for too long: the deploy is stuck.
  if (
    lane.desiredReleaseId !== lane.activeReleaseId &&
    nowMs - lane.desiredCreatedAt.getTime() > stuckMs
  )
    return { bad: true, reason: "stuck_release" };
  return undefined;
}

export function buildShaOf(body: string): string | undefined {
  try {
    const v = (JSON.parse(body) as { buildSha?: unknown }).buildSha;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Verdict from the two probes. A probe that could not run never reaches here (it throws). */
export function laneVerdictFromProbes(
  expectedSha: string,
  version: DeliveryProbeResult,
  ready: DeliveryProbeResult
): LaneVerdict {
  if (version.kind === "unreachable") return unreachable(version.code);
  if (version.status !== 200) return { bad: true, reason: "version_status" };
  if (buildShaOf(version.body) !== expectedSha)
    return { bad: true, reason: "sha_mismatch" };
  if (ready.kind === "unreachable") return unreachable(ready.code);
  if (ready.status !== 200) return { bad: true, reason: "readyz_status" };
  return { bad: false };
}

function unreachable(code: string): LaneVerdict {
  return {
    bad: true,
    reason:
      code === "timeout"
        ? "unreachable/timeout"
        : code === "invalid_target"
          ? "unreachable/invalid_target"
          : "unreachable/network",
  };
}

/** No HTTP answer at all (connect failure or timeout): what an operator egress outage looks like. */
export function isTransportFailure(v: LaneVerdict): boolean {
  return (
    v.bad &&
    (v.reason === "unreachable/network" || v.reason === "unreachable/timeout")
  );
}

/** Append a query parameter. The `cb` buster defeats an edge cache that could hide drift. */
function withQuery(path: string, query: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}

// ---------------------------------------------------------------------------------------------
// Calculators
// ---------------------------------------------------------------------------------------------

const unknownSample = (
  unit: string,
  reason: NonNullable<MetricSample["reason"]>,
  sourceWatermarks: MetricSample["sourceWatermarks"],
  evidenceRefs: string[]
): MetricSample => ({
  value: 0,
  unit,
  complete: false,
  reason,
  sourceWatermarks,
  evidenceRefs,
});

const scopeOf = (p: {
  nodeId?: string | undefined;
  env?: string | undefined;
}): DeliveryScope => ({
  ...(p.nodeId ? { nodeId: p.nodeId } : {}),
  ...(p.env ? { env: p.env } : {}),
});

const scopeRef = (s: DeliveryScope) =>
  `scope:node=${s.nodeId ?? "*"},env=${s.env ?? "*"}`;

export interface DeliveryCalculatorOptions {
  /**
   * The operator's own public host (from `APP_BASE_URL`). Each drift reading probes its `/livez` first:
   * when the operator cannot reach itself through the public edge, its egress is unverified and the
   * reading is unknown. Undefined = never verifiable, so drift is always unknown.
   */
  readonly controlHost: string | undefined;
  readonly now?: () => number;
}

export function createDeliveryCalculators(
  source: DeliveryKpiSourcePort,
  options: DeliveryCalculatorOptions
): MetricCalculator[] {
  const now = options.now ?? Date.now;
  // ---- KPI 1: serving drift ----------------------------------------------------------------
  const driftParams = z.strictObject({
    ...scopeShape,
    stuckMinutes: z.number().int().min(5).max(1440).default(30),
  });
  const servingDrift: MetricCalculator = {
    id: SERVING_DRIFT_ID,
    unit: "lanes",
    display: "progress",
    paramsSchema: driftParams,
    // One lane read, one control probe, then one read per probed lane (its two probes run inside it).
    budget: {
      timeoutMs: 2 * PROBE_TIMEOUT_MS + 7000,
      maxSourceCalls: 2 + MAX_DRIFT_LANES,
      maxRows: MAX_DRIFT_LANES,
      maxResponseBytes: PROBE_MAX_BYTES,
    },
    async compute(params, ctx) {
      const p = driftParams.parse(params);
      const scope = scopeOf(p);
      const read = await ctx.read((signal, budget) =>
        source.servingLanes({ scope, maxRows: budget.maxRows, signal })
      );
      const watermarks = [
        { source: "node_workload_desired", asOf: read.asOf.toISOString() },
      ];
      if (read.truncated)
        return unknownSample(
          "lanes",
          "incomplete_or_invalid_source",
          watermarks,
          [scopeRef(scope), `deploy:lanes>${read.lanes.length}`]
        );
      if (read.lanes.length === 0)
        return unknownSample("lanes", "zero_denominator", watermarks, [
          scopeRef(scope),
          "deploy:lanes=0",
        ]);
      // EGRESS_CONTROL: an operator that cannot reach its own public host cannot judge anyone else's
      // (hub starvation-not-a-verdict). Unknown, never N bad lanes.
      const egressUnverified = (detail: string) =>
        unknownSample("lanes", "source_failed", watermarks, [
          scopeRef(scope),
          `deploy:egress_unverified:${detail}`,
        ]);
      const controlHost = options.controlHost;
      if (!controlHost) return egressUnverified("no_control_host");
      const control = await ctx.read((signal, budget) =>
        source.probe({
          host: controlHost,
          path: withQuery("/livez", `cb=${now()}`),
          timeoutMs: PROBE_TIMEOUT_MS,
          maxBytes: budget.maxResponseBytes,
          signal,
        })
      );
      if (control.kind === "unreachable")
        return egressUnverified(`control_${control.code}`);
      if (control.status !== 200)
        return egressUnverified(`control_status_${control.status}`);
      const nowMs = now();
      const stuckMs = p.stuckMinutes * 60_000;
      const verdicts = await Promise.all(
        read.lanes.map(async (lane) => {
          const early = laneVerdictBeforeProbe(lane, nowMs, stuckMs);
          if (early) return { lane, verdict: early, probed: false };
          // A probe that cannot run (budget, abort) throws: the whole reading is unknown.
          const [version, ready] = await ctx.read((signal, budget) =>
            Promise.all([
              source.probe({
                host: lane.host,
                // Cache-buster: an edge-cached /version body could hide drift.
                path: withQuery(lane.versionPath, `cb=${nowMs}`),
                timeoutMs: PROBE_TIMEOUT_MS,
                maxBytes: budget.maxResponseBytes,
                signal,
              }),
              source.probe({
                host: lane.host,
                path: withQuery(lane.readyPath, "deep=1"),
                timeoutMs: PROBE_TIMEOUT_MS,
                maxBytes: budget.maxResponseBytes,
                signal,
              }),
            ])
          );
          return {
            lane,
            probed: true,
            verdict: laneVerdictFromProbes(
              lane.expectedSha as string,
              version,
              ready
            ),
          };
        })
      );
      const probed = verdicts.filter((v) => v.probed);
      // Every probed lane got no HTTP answer at all: an egress outage looks exactly like this, and the
      // control probe may have passed just before it. Unknown, never a fleet-wide red.
      if (
        probed.length > 0 &&
        probed.every((v) => isTransportFailure(v.verdict))
      )
        return egressUnverified(`all_${probed.length}_lanes_unreachable`);
      const bad = verdicts.filter((v) => v.verdict.bad);
      return {
        value: bad.length,
        unit: "lanes",
        complete: true,
        sourceWatermarks: [
          ...watermarks,
          { source: "http_probe", asOf: new Date(now()).toISOString() },
        ],
        evidenceRefs: [
          scopeRef(scope),
          `deploy:lanes=${read.lanes.length},bad=${bad.length}`,
          ...bad
            .slice(0, MAX_LANE_EVIDENCE)
            .map(
              ({ lane, verdict }) =>
                `lane:${lane.nodeId}/${lane.env}/${lane.workload}:${verdict.bad ? verdict.reason : "ok"}`
            ),
        ],
      };
    },
  };

  // Releases that finished in the window may have been recorded up to one window earlier.
  const readWindow = (
    scope: DeliveryScope,
    ctx: Parameters<MetricCalculator["compute"]>[1]
  ) => {
    const from = new Date(ctx.window.start);
    const to = new Date(ctx.window.end);
    const recordedFrom = new Date(
      from.getTime() - (to.getTime() - from.getTime())
    );
    return ctx
      .read((signal, budget) =>
        source.releases({
          recordedFrom,
          to,
          scope,
          maxRows: budget.maxRows,
          signal,
        })
      )
      .then((read) => ({
        read,
        summary: summarizeReleases(read.rows, from, to),
        watermarks: [
          { source: "node_workload_releases", asOf: read.asOf.toISOString() },
        ],
      }));
  };
  const windowBudget = {
    timeoutMs: 8000,
    maxSourceCalls: 1,
    maxRows: MAX_WINDOW_RELEASES,
    maxResponseBytes: 2_097_152,
  };

  // ---- KPI 2: release success (+ raw finished count guardrail) ------------------------------
  const successParams = z.strictObject({
    ...scopeShape,
    output: z.enum(["percent", "finished"]),
    days: daysSchema,
    /** Below this many finished releases the percent is unknown (`insufficient_history`). */
    minFinished: z.number().int().min(1).max(1000).default(30),
  });
  const releaseSuccess: MetricCalculator = {
    id: RELEASE_SUCCESS_ID,
    historicalWindows: true,
    unit: "%",
    unitFor: (params) =>
      successParams.parse(params).output === "percent" ? "%" : "releases",
    displayFor: (params) =>
      successParams.parse(params).output === "percent" ? "slo" : "volume",
    windowSeconds: (params) => successParams.parse(params).days * 86_400,
    paramsSchema: successParams,
    budget: windowBudget,
    async compute(params, ctx) {
      const p = successParams.parse(params);
      const scope = scopeOf(p);
      const unit = p.output === "percent" ? "%" : "releases";
      const { read, summary: s, watermarks } = await readWindow(scope, ctx);
      const finished = s.success + s.failure;
      const evidence = [
        scopeRef(scope),
        `deploy:success=${s.success},failure=${s.failure},finished=${finished}`,
        `deploy:superseded=${s.superseded},in_flight=${s.inFlight},untimed=${s.untimed}`,
      ];
      if (read.truncated)
        return unknownSample(
          unit,
          "incomplete_or_invalid_source",
          watermarks,
          evidence
        );
      if (p.output === "finished")
        return {
          value: finished,
          unit,
          complete: true,
          sourceWatermarks: watermarks,
          evidenceRefs: evidence,
        };
      if (finished === 0)
        return unknownSample(unit, "zero_denominator", watermarks, evidence);
      if (finished < p.minFinished)
        return unknownSample(unit, "insufficient_history", watermarks, [
          ...evidence,
          `deploy:min_finished=${p.minFinished}`,
        ]);
      return {
        value: Math.round((10_000 * s.success) / finished) / 100,
        unit,
        complete: true,
        sourceWatermarks: watermarks,
        evidenceRefs: evidence,
      };
    },
  };

  // ---- KPI 3: lead time ---------------------------------------------------------------------
  const leadParams = z.strictObject({
    ...scopeShape,
    quantile: z.union([z.literal(50), z.literal(90)]),
    days: daysSchema,
  });
  const leadTime: MetricCalculator = {
    id: LEAD_TIME_ID,
    historicalWindows: true,
    unit: "min",
    display: "progress",
    windowSeconds: (params) => leadParams.parse(params).days * 86_400,
    paramsSchema: leadParams,
    budget: windowBudget,
    async compute(params, ctx) {
      const p = leadParams.parse(params);
      const scope = scopeOf(p);
      const { read, summary: s, watermarks } = await readWindow(scope, ctx);
      const evidence = [
        scopeRef(scope),
        `deploy:lead_samples=${s.leadMs.length},missing_activated_at=${s.missingActivatedAt}`,
      ];
      if (read.truncated)
        return unknownSample(
          "min",
          "incomplete_or_invalid_source",
          watermarks,
          evidence
        );
      if (s.leadMs.length === 0)
        return unknownSample("min", "zero_denominator", watermarks, evidence);
      const minutes = percentile(s.leadMs, p.quantile) / 60_000;
      return {
        value: Math.round(minutes * 10) / 10,
        unit: "min",
        complete: true,
        sourceWatermarks: watermarks,
        evidenceRefs: evidence,
      };
    },
  };

  return [servingDrift, releaseSuccess, leadTime];
}
