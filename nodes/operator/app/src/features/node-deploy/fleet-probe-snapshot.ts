// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/fleet-probe-snapshot`
 * Purpose: One shared per-tick probe snapshot of a scope's serving lanes (task.5457, story.5146). Drift
 *   (`deploy.serving-drift@1`), lanes-down (`fleet.lanes-down@1`) and substrate-reach
 *   (`fleet.substrate-reach@1`) all classify the same snapshot, so a lane's `/version` and
 *   `/readyz?deep=1` are probed once per tick, not once per metric.
 * Scope: Lane read, the control probe and the per-lane probes behind one bounded in-process cache. The
 *   classification of what the probes mean stays in the calculators.
 * Invariants:
 *   - ONE_PROBE_PER_TICK: a snapshot is reused for `SNAPSHOT_TTL_MS` per scope key (`node`, `env`). Concurrent
 *     callers share one in-flight build.
 *   - FAILURE_IS_NEVER_CACHED: a build that throws (budget, abort, store error) or finds the egress
 *     unverified is evicted, so the next caller probes again instead of inheriting the failure.
 *   - EGRESS_CONTROL: the operator's own public `/livez` is probed first. If it fails, no lane is probed and
 *     the snapshot says `egressUnverified`, so no calculator turns an operator-side outage into lane verdicts.
 *   - LANE_PROBE_ERROR_IS_A_LANE_RESULT: a probe that throws for a lane while the caller is still live is
 *     that lane's `unreachable/network`, never a failure of the whole snapshot. A caller abort still throws.
 *   - LANES_ARE_ALL_PROBED: every lane read is probed (its active-attempt state is the calculator's concern),
 *     so lanes-down sees lanes that drift skips.
 *   - UNKNOWN_IS_A_RESULT: truncated and empty lane reads are recorded as such, never as zero bad lanes.
 * Side-effects: IO through the injected source only
 * Links: ports/delivery-kpi.port.ts, features/node-deploy/delivery-kpis.ts, features/node-deploy/fleet-kpis.ts
 * @public
 */

import type { CalculatorContext } from "@cogni-dao/metrics/contracts";
import type {
  DeliveryKpiSourcePort,
  DeliveryLaneFacts,
  DeliveryProbeResult,
  DeliveryScope,
} from "@/ports";

/** Most lanes one reading probes; more is a truncated (unknown) reading. */
export const MAX_DRIFT_LANES = 64;
/** Per-request probe bound. `/version` and `/readyz?deep=1` run in parallel per lane. */
export const PROBE_TIMEOUT_MS = 5000;
export const PROBE_MAX_BYTES = 16384;
/** How long one snapshot answers every metric of the tick (the cadence floor is 60 s). */
export const SNAPSHOT_TTL_MS = 60_000;

/**
 * The budget every snapshot consumer declares: one lane read, one control probe, then one read per
 * lane (its two probes run inside it). The first caller of a tick pays it; later callers read the cache.
 */
export const SNAPSHOT_BUDGET = {
  timeoutMs: 2 * PROBE_TIMEOUT_MS + 7000,
  maxSourceCalls: 2 + MAX_DRIFT_LANES,
  maxRows: MAX_DRIFT_LANES,
  maxResponseBytes: PROBE_MAX_BYTES,
} as const;

export interface ProbedLane {
  readonly lane: DeliveryLaneFacts;
  readonly version: DeliveryProbeResult;
  readonly ready: DeliveryProbeResult;
}

export interface FleetProbeSnapshot {
  /** The instant the snapshot was taken (`cb=` value of its `/version` probes). */
  readonly takenAtMs: number;
  /** When the lane read happened. */
  readonly lanesAsOf: Date;
  /** The lane read hit `maxRows`: the lane list is incomplete. */
  readonly truncated: boolean;
  /** Lanes the store declares for the scope (0 when none). */
  readonly laneCount: number;
  /**
   * Set when the operator could not verify its own egress (no control host, or its own `/livez` failed).
   * `lanes` is empty then: nothing was probed.
   */
  readonly egressUnverified: string | undefined;
  readonly lanes: readonly ProbedLane[];
}

/** Append a query parameter. The `cb` buster defeats an edge cache that could hide drift. */
export function withQuery(path: string, query: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${query}`;
}

export interface FleetProbeSnapshots {
  /**
   * The scope's snapshot: the cached one when it is younger than `SNAPSHOT_TTL_MS`, else a fresh build
   * under `ctx` (its source-call budget and abort signal). A build that throws is not cached.
   */
  get(
    scope: DeliveryScope,
    ctx: CalculatorContext
  ): Promise<FleetProbeSnapshot>;
}

export interface FleetProbeSnapshotOptions {
  /**
   * The operator's own public host (from `APP_BASE_URL`). Undefined = egress is never verifiable, so a
   * snapshot always says `egressUnverified: "no_control_host"`.
   */
  readonly controlHost: string | undefined;
  readonly now?: () => number;
  readonly ttlMs?: number;
}

export function createFleetProbeSnapshots(
  source: DeliveryKpiSourcePort,
  options: FleetProbeSnapshotOptions
): FleetProbeSnapshots {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? SNAPSHOT_TTL_MS;
  const cache = new Map<
    string,
    { readonly at: number; readonly snapshot: Promise<FleetProbeSnapshot> }
  >();

  async function build(
    scope: DeliveryScope,
    ctx: CalculatorContext
  ): Promise<FleetProbeSnapshot> {
    const takenAtMs = now();
    const read = await ctx.read((signal, budget) =>
      source.servingLanes({ scope, maxRows: budget.maxRows, signal })
    );
    const base = {
      takenAtMs,
      lanesAsOf: read.asOf,
      truncated: read.truncated,
      laneCount: read.lanes.length,
    };
    // Nothing to judge, so nothing to probe (and no control probe: an empty fleet needs no egress proof).
    if (read.truncated || read.lanes.length === 0)
      return { ...base, egressUnverified: undefined, lanes: [] };
    const controlHost = options.controlHost;
    if (!controlHost)
      return { ...base, egressUnverified: "no_control_host", lanes: [] };
    const control = await ctx.read((signal, budget) =>
      source.probe({
        host: controlHost,
        path: withQuery("/livez", `cb=${takenAtMs}`),
        timeoutMs: PROBE_TIMEOUT_MS,
        maxBytes: budget.maxResponseBytes,
        signal,
      })
    );
    if (control.kind === "unreachable")
      return {
        ...base,
        egressUnverified: `control_${control.code}`,
        lanes: [],
      };
    if (control.status !== 200)
      return {
        ...base,
        egressUnverified: `control_status_${control.status}`,
        lanes: [],
      };
    const lanes = await Promise.all(
      read.lanes.map(async (lane): Promise<ProbedLane> => {
        // A caller abort or an exhausted budget throws out of `ctx.read` or the probe: the whole snapshot fails
        // and is not cached. Any other probe error belongs to this lane only.
        const laneProbe = async (
          path: string,
          signal: AbortSignal,
          maxBytes: number
        ): Promise<DeliveryProbeResult> => {
          try {
            return await source.probe({
              host: lane.host,
              path,
              timeoutMs: PROBE_TIMEOUT_MS,
              maxBytes,
              signal,
            });
          } catch (error) {
            if (signal.aborted) throw error;
            return { kind: "unreachable", code: "network" };
          }
        };
        const [version, ready] = await ctx.read((signal, budget) =>
          Promise.all([
            // Cache-buster: an edge-cached /version body could hide drift.
            laneProbe(
              withQuery(lane.versionPath, `cb=${takenAtMs}`),
              signal,
              budget.maxResponseBytes
            ),
            laneProbe(
              withQuery(lane.readyPath, "deep=1"),
              signal,
              budget.maxResponseBytes
            ),
          ])
        );
        return { lane, version, ready };
      })
    );
    return { ...base, egressUnverified: undefined, lanes };
  }

  return {
    get(scope, ctx) {
      const key = `${scope.nodeId ?? "*"}/${scope.env ?? "*"}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.snapshot;
      const entry = { at: now(), snapshot: build(scope, ctx) };
      cache.set(key, entry);
      // FAILURE_IS_NEVER_CACHED. The rejection still reaches every caller awaiting this build. An
      // unverified egress is a failure too: the next caller re-runs the control probe.
      const evict = () => {
        if (cache.get(key) === entry) cache.delete(key);
      };
      entry.snapshot.then((s) => {
        if (s.egressUnverified) evict();
      }, evict);
      return entry.snapshot;
    },
  };
}
