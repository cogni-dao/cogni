// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/fleet-kpis`
 * Purpose: The operator's node-local goal-metric calculators for fleet uptime (task.5457, story.5146):
 *   `fleet.lanes-down@1` (lanes whose deep readyz is not good this tick, how many were probed, or the
 *   probed share of declared lanes),
 *   `fleet.substrate-reach@1` (share of known lanes that reach one shared dependency) and
 *   `fleet.uptime@1` (share of stored lane-probes that were good over a window). Registered through
 *   `@cogni-dao/metrics` 0.4 `createGoalMetrics({ nodeCalculators })`.
 * Scope: Pure classification and the calculator objects. Probes come from the shared per-tick snapshot
 *   (`fleet-probe-snapshot.ts`); stored readings come through `FleetObservationReaderPort`. This module
 *   does no IO itself.
 * Invariants:
 *   - GOOD_IS_READYZ_200: a lane is up when `GET /readyz?deep=1` answers 200 within the probe deadline.
 *     Anything else is down, with a bounded reason.
 *   - ONE_PROBER: `fleet.lanes-down@1` is the only calculator whose readings feed uptime. Reach reads the
 *     same snapshot; uptime probes nothing and writes nothing.
 *   - EGRESS_CONTROL: the snapshot probes the operator's own public `/livez` first. If that fails, the
 *     reading is unavailable (`source_failed`).
 *   - TOTAL_OUTAGE_IS_DOWN: control passes and every lane fails (an edge or DNS outage times out every lane)
 *     means every lane is down, never unknown. (Drift keeps its older all-unreachable rule; separate follow-up.)
 *   - UNBOUND_HOST_IS_NOT_PROBED: a lane whose declared host cannot be probed (invalid target) is declared,
 *     not probed and not down. `probed < declared` is the guardrail's signal.
 *   - REACH_IS_ATTRIBUTED: reach is read only through `readDeepReadiness` (@cogni-dao/substrate-health): a
 *     lane's `checks[dependency]` is reached/unreached, a lane that does not probe it is na, and anything
 *     else is unknown. na and unknown are excluded from numerator and denominator and counted. A body without
 *     `checks` counts as reached only on a healthy 200 and only for the four names every deep probe has
 *     always run (dated transition, story.0029). No free-text message parsing.
 *   - UPTIME_IS_STORED_FACTS: uptime = 100 x (1 - sum(down) / sum(probed)) over stored `ok` SCHEDULED lanes-down
 *     readings with the `fleet:declared=,probed=,down=` evidence, one per refresh slot. Gaps stay gaps. Under
 *     24 h of readings, or under half of the window's expected slots (definition cadence, else 300 s), is
 *     `insufficient_history`.
 *   - PERCENT_FLOORS: percents floor to three decimals in integer arithmetic, so rounding never turns a
 *     breach into a pass at a target such as 99.9.
 *   - UNKNOWN_IS_A_RESULT: zero lanes, a truncated read or no known lane yields an incomplete sample with a
 *     reason, never a pass and never zero.
 *   - IDS_USE_DASHES: calculator ids match `MetricSpecSchema.calculatorId` (no underscores).
 * Side-effects: none (calculators call the injected snapshots and reader)
 * Links: features/node-deploy/fleet-probe-snapshot.ts, ports/fleet-observation.port.ts,
 *   bootstrap/capabilities/goal-metrics.ts, story.5146, task.5457
 * @public
 */

import type {
  MetricCalculator,
  MetricSample,
} from "@cogni-dao/metrics/contracts";
import { readDeepReadiness } from "@cogni/substrate-health";
import { z } from "zod";
import type {
  DeliveryProbeResult,
  DeliveryScope,
  FleetObservationReaderPort,
} from "@/ports";
import {
  type FleetProbeSnapshot,
  type FleetProbeSnapshots,
  SNAPSHOT_BUDGET,
} from "./fleet-probe-snapshot";

export const LANES_DOWN_ID = "fleet.lanes-down@1";
export const SUBSTRATE_REACH_ID = "fleet.substrate-reach@1";
export const UPTIME_ID = "fleet.uptime@1";

/** Every dependency a lane's deep readyz can probe (the @cogni-dao/substrate-health probe names). */
export const REACH_DEPENDENCIES = [
  "postgres",
  "temporal",
  "scheduler-worker",
  "evm-rpc",
  "redis",
  "litellm-gateway",
  "doltgres",
] as const;
export type ReachDependency = (typeof REACH_DEPENDENCIES)[number];

/**
 * TRANSITION (story.0029, exit: every lane serves substrate-health >= 0.2.0): a lane without per-dependency
 * `checks` still reads as reached on an aggregate healthy 200, but only for the names every deep probe has
 * always covered. Any other name on such a lane is unknown, never a false green.
 */
const AGGREGATE_ONLY_DEPENDENCIES: ReadonlySet<string> = new Set([
  "postgres",
  "temporal",
  "scheduler-worker",
  "evm-rpc",
]);

/** Most stored readings one uptime reading integrates: 28 days at the 5-minute cadence is 8,064. */
export const MAX_UPTIME_READINGS = 12_000;
/** Uptime needs this much recorded history before it speaks. */
export const MIN_UPTIME_HISTORY_MS = 24 * 3_600_000;
/** Uptime needs at least this share of the window's expected scheduled readings. */
export const MIN_UPTIME_COVERAGE = 0.5;
/** The refresh cadence assumed when the stored definition has none. */
export const DEFAULT_CADENCE_SECONDS = 300;
/** Evidence lists at most this many lanes or readings. */
const MAX_EVIDENCE = 20;

const envSchema = z.string().regex(/^[a-z0-9-]{1,40}$/);
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

export type LaneReadiness =
  | { readonly kind: "up" }
  | { readonly kind: "down"; readonly reason: string }
  /** The declared host cannot be probed at all (invalid target): declared, not probed, not down. */
  | { readonly kind: "not_probed"; readonly reason: "invalid_target" };

/** Good = the deep readyz answered 200. A timeout, a network failure or any other status is down. */
export function classifyLaneReadiness(
  ready: DeliveryProbeResult
): LaneReadiness {
  if (ready.kind === "unreachable")
    return ready.code === "invalid_target"
      ? { kind: "not_probed", reason: "invalid_target" }
      : {
          kind: "down",
          reason:
            ready.code === "timeout"
              ? "unreachable/timeout"
              : "unreachable/network",
        };
  return ready.status === 200
    ? { kind: "up" }
    : { kind: "down", reason: `readyz_status/${ready.status}` };
}

export type ReachVerdict = "reached" | "unreached" | "na" | "unknown";

/**
 * Whether one lane reaches `dependency`, read only through `readDeepReadiness`. A lane that attributes its
 * checks answers reached, unreached or na (it does not probe that name). A timeout, another status or a body
 * without evidence for that name is unknown: it never counts as reachable or unreachable.
 */
export function classifyReach(
  ready: DeliveryProbeResult,
  dependency: ReachDependency
): ReachVerdict {
  if (ready.kind === "unreachable") return "unknown";
  let body: unknown = null;
  try {
    body = JSON.parse(ready.body);
  } catch {
    // Not JSON: no evidence.
  }
  const reading = readDeepReadiness(ready.status, body);
  const state = reading.dependencyState(dependency);
  if (state !== "unknown") return state;
  return reading.healthy && AGGREGATE_ONLY_DEPENDENCIES.has(dependency)
    ? "reached"
    : "unknown";
}

const EVIDENCE_LINE = /^fleet:declared=(\d+),probed=(\d+),down=(\d+)$/;

/** Parse a lanes-down reading's `fleet:declared=,probed=,down=` evidence line. */
export function parseLaneCounts(
  evidence: string
): { declared: number; probed: number; down: number } | undefined {
  const m = EVIDENCE_LINE.exec(evidence);
  if (!m) return undefined;
  const declared = Number(m[1]);
  const probed = Number(m[2]);
  const down = Number(m[3]);
  // A reading that claims more down lanes than probed ones is corrupt: unusable, not clamped.
  return down <= probed && probed <= declared
    ? { declared, probed, down }
    : undefined;
}

/** `100 * numerator / denominator` floored to three decimals in integer arithmetic. */
export function percentFloor3(numerator: number, denominator: number): number {
  return Math.floor((100_000 * numerator) / denominator) / 1000;
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

const scopeRef = (scope: DeliveryScope) => `scope:env=${scope.env ?? "*"}`;

const laneRef = (
  l: { nodeId: string; env: string; workload: string },
  what: string
) => `lane:${l.nodeId}/${l.env}/${l.workload}:${what}`;

const snapshotWatermarks = (snap: FleetProbeSnapshot) => [
  { source: "node_workload_desired", asOf: snap.lanesAsOf.toISOString() },
];

const probeWatermark = (snap: FleetProbeSnapshot) => ({
  source: "http_probe",
  asOf: new Date(snap.takenAtMs).toISOString(),
});

export interface FleetCalculatorOptions {
  /** Shared with `createDeliveryCalculators`, so a lane is probed once per tick. */
  readonly snapshots: FleetProbeSnapshots;
  /** Stored lanes-down readings for `fleet.uptime@1`. */
  readonly observations: FleetObservationReaderPort;
}

/** The sample of a snapshot that cannot be judged (truncated, empty, egress unverified), else undefined. */
function unjudgeable(
  snap: FleetProbeSnapshot,
  unit: string,
  evidence: string[]
): MetricSample | undefined {
  const watermarks = snapshotWatermarks(snap);
  if (snap.truncated)
    return unknownSample(unit, "incomplete_or_invalid_source", watermarks, [
      ...evidence,
      `fleet:declared>${snap.laneCount}`,
    ]);
  if (snap.laneCount === 0)
    return unknownSample(unit, "zero_denominator", watermarks, [
      ...evidence,
      "fleet:declared=0",
    ]);
  // EGRESS_CONTROL: an operator that cannot reach its own public host cannot judge anyone else's.
  if (snap.egressUnverified)
    return unknownSample(unit, "source_failed", watermarks, [
      ...evidence,
      `fleet:egress_unverified:${snap.egressUnverified}`,
    ]);
  return undefined;
}

export function createFleetCalculators(
  options: FleetCalculatorOptions
): MetricCalculator[] {
  const { snapshots, observations } = options;

  // ---- fleet.lanes-down: lanes not good this tick, or lanes probed --------------------------
  const lanesDownParams = z.strictObject({
    env: envSchema,
    output: z.enum(["down", "probed", "coverage"]),
  });
  const lanesDown: MetricCalculator = {
    id: LANES_DOWN_ID,
    unit: "lanes",
    // `coverage` is a percent (probed / declared), so it binds as an SLO ("= 100").
    unitFor: (params) =>
      lanesDownParams.parse(params).output === "coverage" ? "%" : "lanes",
    displayFor: (params) => {
      const { output } = lanesDownParams.parse(params);
      return output === "down"
        ? "progress"
        : output === "coverage"
          ? "slo"
          : "volume";
    },
    paramsSchema: lanesDownParams,
    budget: SNAPSHOT_BUDGET,
    async compute(params, ctx) {
      const p = lanesDownParams.parse(params);
      const scope: DeliveryScope = { env: p.env };
      const snap = await snapshots.get(scope, ctx);
      const head = [scopeRef(scope)];
      const unit = p.output === "coverage" ? "%" : "lanes";
      const early = unjudgeable(snap, unit, head);
      if (early) return early;
      const outcomes = snap.lanes.map(({ lane, ready }) => ({
        lane,
        outcome: classifyLaneReadiness(ready),
      }));
      const probed = outcomes.filter((o) => o.outcome.kind !== "not_probed");
      const down = outcomes.filter((o) => o.outcome.kind === "down");
      // Declared but nothing probable: there is no fleet to call up, so "0 down" would be a false pass.
      if (p.output === "down" && probed.length === 0)
        return unknownSample(
          unit,
          "zero_denominator",
          snapshotWatermarks(snap),
          [...head, `fleet:declared=${snap.laneCount},probed=0,down=0`]
        );
      return {
        value:
          p.output === "down"
            ? down.length
            : p.output === "probed"
              ? probed.length
              : percentFloor3(probed.length, snap.laneCount),
        unit,
        complete: true,
        sourceWatermarks: [...snapshotWatermarks(snap), probeWatermark(snap)],
        evidenceRefs: [
          ...head,
          // The line `fleet.uptime@1` integrates. Keep its shape in step with `parseLaneCounts`.
          `fleet:declared=${snap.laneCount},probed=${probed.length},down=${down.length}`,
          ...outcomes
            .filter((o) => o.outcome.kind !== "up")
            .slice(0, MAX_EVIDENCE)
            .map(({ lane, outcome }) =>
              laneRef(
                lane,
                outcome.kind === "up"
                  ? "up"
                  : outcome.kind === "down"
                    ? outcome.reason
                    : `not_probed/${outcome.reason}`
              )
            ),
        ],
      };
    },
  };

  // ---- fleet.substrate-reach: % of known lanes that reach one dependency --------------------
  const reachParams = z.strictObject({
    env: envSchema,
    dependency: z.enum(REACH_DEPENDENCIES),
  });
  const substrateReach: MetricCalculator = {
    id: SUBSTRATE_REACH_ID,
    unit: "%",
    display: "slo",
    paramsSchema: reachParams,
    budget: SNAPSHOT_BUDGET,
    async compute(params, ctx) {
      const p = reachParams.parse(params);
      const scope: DeliveryScope = { env: p.env };
      const snap = await snapshots.get(scope, ctx);
      const head = [scopeRef(scope), `fleet:dependency=${p.dependency}`];
      const early = unjudgeable(snap, "%", head);
      if (early) return early;
      const verdicts = snap.lanes.map(({ lane, ready }) => ({
        lane,
        reach: classifyReach(ready, p.dependency),
      }));
      const reached = verdicts.filter((v) => v.reach === "reached").length;
      const unreached = verdicts.filter((v) => v.reach === "unreached");
      const unknown = verdicts.filter((v) => v.reach === "unknown").length;
      const na = verdicts.filter((v) => v.reach === "na").length;
      const known = reached + unreached.length;
      const evidence = [
        ...head,
        `fleet:declared=${snap.laneCount},known=${known},reached=${reached},unknown=${unknown},na=${na}`,
        ...unreached
          .slice(0, MAX_EVIDENCE)
          .map(({ lane }) => laneRef(lane, `unreachable/${p.dependency}`)),
      ];
      if (known === 0)
        return unknownSample(
          "%",
          "zero_denominator",
          [...snapshotWatermarks(snap), probeWatermark(snap)],
          evidence
        );
      return {
        value: percentFloor3(reached, known),
        unit: "%",
        complete: true,
        sourceWatermarks: [...snapshotWatermarks(snap), probeWatermark(snap)],
        evidenceRefs: evidence,
      };
    },
  };

  // ---- fleet.uptime: stored lanes-down readings, integrated ---------------------------------
  const uptimeParams = z.strictObject({
    env: envSchema,
    days: z.number().int().min(1).max(28).default(7),
  });
  const uptime: MetricCalculator = {
    id: UPTIME_ID,
    historicalWindows: true,
    unit: "%",
    display: "slo",
    windowSeconds: (params) =>
      uptimeParams.parse(params).days * (DAY_MS / 1000),
    paramsSchema: uptimeParams,
    budget: {
      timeoutMs: 8000,
      maxSourceCalls: 1,
      maxRows: MAX_UPTIME_READINGS,
      maxResponseBytes: 2_097_152,
    },
    async compute(params, ctx) {
      const p = uptimeParams.parse(params);
      const from = new Date(ctx.window.start);
      const to = new Date(ctx.window.end);
      const read = await ctx.read((signal, budget) =>
        observations.lanesDown({
          env: p.env,
          from,
          to,
          maxRows: budget.maxRows,
          signal,
        })
      );
      const watermarks = [
        { source: "metric_observations", asOf: read.asOf.toISOString() },
      ];
      const head = [`scope:env=${p.env}`];
      if (read.truncated)
        return unknownSample("%", "incomplete_or_invalid_source", watermarks, [
          ...head,
          `fleet:readings>${read.rows.length}`,
        ]);
      let probed = 0;
      let down = 0;
      let readings = 0;
      let unparseable = 0;
      let duplicates = 0;
      let cadenceSeconds: number | undefined;
      let first: Date | undefined;
      let last: Date | undefined;
      const slots = new Set<number>();
      const worst: string[] = [];
      for (const r of read.rows) {
        const c = parseLaneCounts(r.evidence);
        if (!c) {
          unparseable++;
          continue;
        }
        // One reading per refresh slot: a second definition or a retry of a slot never counts twice.
        if (slots.has(r.scheduledFor.getTime())) {
          duplicates++;
          continue;
        }
        slots.add(r.scheduledFor.getTime());
        if (r.cadenceSeconds && r.cadenceSeconds > 0)
          cadenceSeconds = r.cadenceSeconds;
        readings++;
        probed += c.probed;
        down += c.down;
        first ??= r.at;
        last = r.at;
        if (c.down > 0 && worst.length < MAX_EVIDENCE)
          worst.push(`obs:${r.observationId}:down=${c.down}/${c.probed}`);
      }
      const history = first ? to.getTime() - first.getTime() : 0;
      const cadence = cadenceSeconds ?? DEFAULT_CADENCE_SECONDS;
      const expected = Math.floor(
        (to.getTime() - from.getTime()) / (cadence * 1000)
      );
      const evidence = [
        ...head,
        `fleet:readings=${readings},probed=${probed},down=${down},unparseable=${unparseable}`,
        `fleet:slots=${readings},expected=${expected},cadence_seconds=${cadence},duplicates=${duplicates}`,
        ...(first && last
          ? [
              `fleet:first=${first.toISOString()},last=${last.toISOString()},history_hours=${Math.floor(history / 3_600_000)}`,
            ]
          : []),
        ...worst,
      ];
      if (history < MIN_UPTIME_HISTORY_MS)
        return unknownSample("%", "insufficient_history", watermarks, [
          ...evidence,
          "fleet:min_history_hours=24",
        ]);
      // A window with most of its slots missing would read a few probes as the whole week.
      if (readings < expected * MIN_UPTIME_COVERAGE)
        return unknownSample("%", "insufficient_history", watermarks, [
          ...evidence,
          `fleet:min_coverage=${MIN_UPTIME_COVERAGE}`,
        ]);
      if (probed === 0)
        return unknownSample("%", "zero_denominator", watermarks, evidence);
      return {
        value: percentFloor3(probed - down, probed),
        unit: "%",
        complete: true,
        sourceWatermarks: watermarks,
        evidenceRefs: evidence,
      };
    },
  };

  return [lanesDown, substrateReach, uptime];
}
