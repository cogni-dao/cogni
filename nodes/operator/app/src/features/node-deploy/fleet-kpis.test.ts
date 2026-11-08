// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/fleet-kpis.test`
 * Purpose: Prove the fleet uptime calculators (task.5457) over in-memory sources: lanes-down (good = readyz
 *   200, a total outage behind a passing control is all-down, a failing control is unavailable), substrate
 *   reach (a 503 names its unreachable list or is unknown), uptime (the 2026-11-07 replay is about 99.62%,
 *   under 24 h of history is unavailable) and the one shared probe snapshot per tick.
 * Side-effects: none
 */

import type {
  CalculatorContext,
  MetricCalculator,
  MetricSample,
} from "@cogni-dao/metrics/contracts";
import { describe, expect, it } from "vitest";
import type {
  DeliveryKpiSourcePort,
  DeliveryLaneFacts,
  DeliveryProbeResult,
  FleetLanesDownReading,
  FleetObservationReaderPort,
} from "@/ports";
import { createDeliveryCalculators, SERVING_DRIFT_ID } from "./delivery-kpis";
import {
  classifyLaneReadiness,
  classifyReach,
  createFleetCalculators,
  LANES_DOWN_ID,
  MAX_UPTIME_READINGS,
  parseLaneCounts,
  percentFloor3,
  SUBSTRATE_REACH_ID,
  UPTIME_ID,
} from "./fleet-kpis";
import { createFleetProbeSnapshots } from "./fleet-probe-snapshot";

const NOW = Date.parse("2026-11-08T00:00:00.000Z");
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NODE = "11111111-1111-4111-8111-111111111111";
const SHA_A = "a".repeat(40);
const CONTROL = "cognidao.org";

/** The host of a recorded `host/path` probe. */
const hostOf = (probe: string) => probe.split("/")[0];

const ok = (body: unknown = {}): DeliveryProbeResult => ({
  kind: "response",
  status: 200,
  body: JSON.stringify(body),
});
const status = (code: number, body: unknown = {}): DeliveryProbeResult => ({
  kind: "response",
  status: code,
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const timeout: DeliveryProbeResult = { kind: "unreachable", code: "timeout" };

function lane(workload: string, over: Partial<DeliveryLaneFacts> = {}) {
  return {
    nodeId: NODE,
    env: "production",
    workload,
    host: `${workload}.cognidao.org`,
    versionPath: "/version",
    readyPath: "/readyz",
    desiredReleaseId: "r1",
    desiredCreatedAt: new Date(NOW - DAY),
    activeReleaseId: "r1",
    expectedSha: SHA_A,
    ...over,
  } satisfies DeliveryLaneFacts;
}

/** Readyz answers per lane host; the control host and `/version` default to 200. */
function source(input: {
  lanes?: DeliveryLaneFacts[];
  ready?: Record<string, DeliveryProbeResult>;
  control?: DeliveryProbeResult;
}): DeliveryKpiSourcePort & { probes: string[]; laneReads: number } {
  const probes: string[] = [];
  const src = {
    probes,
    laneReads: 0,
    releases: async () => ({ rows: [], truncated: false, asOf: new Date(NOW) }),
    servingLanes: async ({ maxRows }: { maxRows: number }) => {
      src.laneReads++;
      return {
        lanes: (input.lanes ?? []).slice(0, maxRows),
        truncated: (input.lanes ?? []).length > maxRows,
        asOf: new Date(NOW),
      };
    },
    probe: async ({ host, path }: { host: string; path: string }) => {
      probes.push(`${host}${path}`);
      if (host === CONTROL) return input.control ?? ok();
      if (path.startsWith("/readyz"))
        return input.ready?.[host] ?? ok({ status: "ready" });
      return ok({ buildSha: SHA_A });
    },
  };
  return src;
}

function observations(
  rows: FleetLanesDownReading[],
  truncated = false
): FleetObservationReaderPort & {
  calls: { env: string; from: Date; to: Date }[];
} {
  const calls: { env: string; from: Date; to: Date }[] = [];
  return {
    calls,
    lanesDown: async ({ env, from, to }) => {
      calls.push({ env, from, to });
      return { rows, truncated, asOf: new Date(NOW) };
    },
  };
}

function fleet(
  src: DeliveryKpiSourcePort,
  obs: FleetObservationReaderPort = observations([]),
  /** `null` = no control host (a default parameter would swallow `undefined`). */
  controlHost: string | null = CONTROL
) {
  const host = controlHost ?? undefined;
  const snapshots = createFleetProbeSnapshots(src, {
    controlHost: host,
    now: () => NOW,
  });
  return {
    snapshots,
    calcs: createFleetCalculators({ snapshots, observations: obs }),
    drift: () =>
      createDeliveryCalculators(src, {
        controlHost: host,
        now: () => NOW,
        snapshots,
      }),
  };
}

/** Run one calculator the way the engine does: parse params, bounded reads, the calculator's window. */
async function run(
  calcs: MetricCalculator[],
  id: string,
  params: Record<string, unknown>
): Promise<MetricSample> {
  const calc = calcs.find((c) => c.id === id) as MetricCalculator;
  const windowMs = (calc.windowSeconds?.(params) ?? 0) * 1000;
  const controller = new AbortController();
  let calls = 0;
  const ctx: CalculatorContext = {
    window: {
      start: new Date(NOW - windowMs).toISOString(),
      end: new Date(NOW).toISOString(),
    },
    signal: controller.signal,
    budget: calc.budget,
    async read(fn) {
      if (++calls > calc.budget.maxSourceCalls)
        throw new Error("source_call_budget");
      return fn(controller.signal, calc.budget);
    },
  };
  return calc.compute(calc.paramsSchema.parse(params), ctx);
}

const lanesDown = (
  output: "down" | "probed" | "coverage" = "down",
  env = "production"
) => ({
  env,
  output,
});

describe("classifyLaneReadiness", () => {
  it("good is readyz 200; a timeout, a network error or any other status is down", () => {
    expect(classifyLaneReadiness(ok())).toEqual({ kind: "up" });
    expect(classifyLaneReadiness(status(503))).toEqual({
      kind: "down",
      reason: "readyz_status/503",
    });
    expect(classifyLaneReadiness(status(404))).toMatchObject({ kind: "down" });
    expect(classifyLaneReadiness(timeout)).toEqual({
      kind: "down",
      reason: "unreachable/timeout",
    });
    expect(
      classifyLaneReadiness({ kind: "unreachable", code: "network" })
    ).toEqual({ kind: "down", reason: "unreachable/network" });
  });
  it("a host that cannot be probed is not probed, and not down", () => {
    expect(
      classifyLaneReadiness({ kind: "unreachable", code: "invalid_target" })
    ).toEqual({ kind: "not_probed", reason: "invalid_target" });
  });
});

describe(LANES_DOWN_ID, () => {
  it("0 down and every lane probed when all readyz answer 200; the readyz probe is deep", async () => {
    const src = source({ lanes: [lane("a"), lane("b")] });
    const { calcs } = fleet(src);
    const s = await run(calcs, LANES_DOWN_ID, lanesDown());
    expect(s).toMatchObject({ complete: true, unit: "lanes", value: 0 });
    expect(s.evidenceRefs).toContain("fleet:declared=2,probed=2,down=0");
    expect(src.probes).toContain("a.cognidao.org/readyz?deep=1");
    expect(src.probes[0]).toBe(`${CONTROL}/livez?cb=${NOW}`);
  });
  it("output probed returns the probed count over the same evidence", async () => {
    const { calcs } = fleet(
      source({ lanes: [lane("a"), lane("b"), lane("c")] })
    );
    const s = await run(calcs, LANES_DOWN_ID, lanesDown("probed"));
    expect(s).toMatchObject({ complete: true, unit: "lanes", value: 3 });
  });
  it("output coverage is the probed share of declared lanes, floored, in % (binds as = 100)", async () => {
    const all = await run(
      fleet(source({ lanes: [lane("a"), lane("b")] })).calcs,
      LANES_DOWN_ID,
      lanesDown("coverage")
    );
    expect(all).toMatchObject({ complete: true, unit: "%", value: 100 });
    // One of three declared hosts cannot be probed: 2 of 3 = 66.666, floored, never rounded up.
    const partial = await run(
      fleet(
        source({
          lanes: [lane("a"), lane("b"), lane("c", { host: "10.0.0.1" })],
          ready: {
            "10.0.0.1": { kind: "unreachable", code: "invalid_target" },
          },
        })
      ).calcs,
      LANES_DOWN_ID,
      lanesDown("coverage")
    );
    expect(partial).toMatchObject({ complete: true, unit: "%", value: 66.666 });
    // Nothing probable is a real 0 coverage (down and probed would be unknown or 0 lanes).
    const none = await run(
      fleet(
        source({
          lanes: [lane("c", { host: "10.0.0.1" })],
          ready: {
            "10.0.0.1": { kind: "unreachable", code: "invalid_target" },
          },
        })
      ).calcs,
      LANES_DOWN_ID,
      lanesDown("coverage")
    );
    expect(none).toMatchObject({ complete: true, unit: "%", value: 0 });
    // Same unjudgeable rules: a failing control is unavailable, in the percent unit.
    const egress = await run(
      fleet(source({ lanes: [lane("a")], control: timeout })).calcs,
      LANES_DOWN_ID,
      lanesDown("coverage")
    );
    expect(egress).toMatchObject({
      complete: false,
      unit: "%",
      reason: "source_failed",
    });
    const calc = fleet(source({})).calcs.find(
      (c) => c.id === LANES_DOWN_ID
    ) as MetricCalculator;
    expect(calc.unitFor?.(lanesDown("coverage"))).toBe("%");
    expect(calc.displayFor?.(lanesDown("coverage"))).toBe("slo");
    expect(calc.unitFor?.(lanesDown("down"))).toBe("lanes");
  });
  it("a 503 and a timeout are down with bounded per-lane reasons; the rest are up", async () => {
    const { calcs } = fleet(
      source({
        lanes: [lane("a"), lane("b"), lane("c")],
        ready: {
          "b.cognidao.org": status(503, { unreachable: ["postgres"] }),
          "c.cognidao.org": timeout,
        },
      })
    );
    const s = await run(calcs, LANES_DOWN_ID, lanesDown());
    expect(s).toMatchObject({ complete: true, value: 2 });
    expect(s.evidenceRefs).toEqual(
      expect.arrayContaining([
        "fleet:declared=3,probed=3,down=2",
        `lane:${NODE}/production/b:readyz_status/503`,
        `lane:${NODE}/production/c:unreachable/timeout`,
      ])
    );
    expect(s.evidenceRefs.some((r) => r.includes("/a:"))).toBe(false);
  });
  it("evidence lists at most 20 down lanes", async () => {
    const many = Array.from({ length: 40 }, (_, i) => lane(`w${i}`));
    const ready = Object.fromEntries(
      many.map((l) => [l.host, status(503)] as const)
    );
    const s = await run(
      fleet(source({ lanes: many, ready })).calcs,
      LANES_DOWN_ID,
      lanesDown()
    );
    expect(s.value).toBe(40);
    expect(s.evidenceRefs.filter((r) => r.startsWith("lane:"))).toHaveLength(
      20
    );
  });
  it("the control probe fails: unavailable source_failed, no lane probed", async () => {
    const src = source({
      lanes: [lane("a"), lane("b")],
      control: { kind: "unreachable", code: "network" },
    });
    const s = await run(fleet(src).calcs, LANES_DOWN_ID, lanesDown());
    expect(s).toMatchObject({ complete: false, reason: "source_failed" });
    expect(s.evidenceRefs).toContain("fleet:egress_unverified:control_network");
    expect(src.probes).toEqual([`${CONTROL}/livez?cb=${NOW}`]);
    const noHost = await run(
      fleet(source({ lanes: [lane("a")] }), observations([]), null).calcs,
      LANES_DOWN_ID,
      lanesDown()
    );
    expect(noHost).toMatchObject({ complete: false, reason: "source_failed" });
    expect(noHost.evidenceRefs).toContain(
      "fleet:egress_unverified:no_control_host"
    );
    const badStatus = await run(
      fleet(source({ lanes: [lane("a")], control: status(502) })).calcs,
      LANES_DOWN_ID,
      lanesDown()
    );
    expect(badStatus.evidenceRefs).toContain(
      "fleet:egress_unverified:control_status_502"
    );
  });
  it("control passes and every lane times out: every lane is DOWN, not unknown", async () => {
    const lanes = [lane("a"), lane("b"), lane("c")];
    const s = await run(
      fleet(
        source({
          lanes,
          ready: Object.fromEntries(lanes.map((l) => [l.host, timeout])),
        })
      ).calcs,
      LANES_DOWN_ID,
      lanesDown()
    );
    expect(s).toMatchObject({ complete: true, value: 3, unit: "lanes" });
    expect(s.evidenceRefs).toContain("fleet:declared=3,probed=3,down=3");
  });
  it("a lane that cannot be probed is declared, not probed, not down; none probable is unknown", async () => {
    const src = source({
      lanes: [lane("a"), lane("b", { host: "10.0.0.1" })],
      ready: { "10.0.0.1": { kind: "unreachable", code: "invalid_target" } },
    });
    const { calcs } = fleet(src);
    const down = await run(calcs, LANES_DOWN_ID, lanesDown());
    expect(down).toMatchObject({ complete: true, value: 0 });
    expect(down.evidenceRefs).toEqual(
      expect.arrayContaining([
        "fleet:declared=2,probed=1,down=0",
        `lane:${NODE}/production/b:not_probed/invalid_target`,
      ])
    );
    const none = await run(
      fleet(
        source({
          lanes: [lane("b", { host: "10.0.0.1" })],
          ready: {
            "10.0.0.1": { kind: "unreachable", code: "invalid_target" },
          },
        })
      ).calcs,
      LANES_DOWN_ID,
      lanesDown()
    );
    expect(none).toMatchObject({ complete: false, reason: "zero_denominator" });
  });
  it("zero lanes and a truncated lane read are unknown, never a pass", async () => {
    await expect(
      run(fleet(source({ lanes: [] })).calcs, LANES_DOWN_ID, lanesDown())
    ).resolves.toMatchObject({ complete: false, reason: "zero_denominator" });
    const over = Array.from({ length: 65 }, (_, i) => lane(`w${i}`));
    await expect(
      run(fleet(source({ lanes: over })).calcs, LANES_DOWN_ID, lanesDown())
    ).resolves.toMatchObject({
      complete: false,
      reason: "incomplete_or_invalid_source",
    });
  });
  it("env is a real parameter and params are strict", () => {
    const { calcs } = fleet(source({}));
    const calc = calcs.find((c) => c.id === LANES_DOWN_ID) as MetricCalculator;
    expect(() => calc.paramsSchema.parse({ output: "down" })).toThrow();
    expect(() =>
      calc.paramsSchema.parse({ env: "Prod", output: "down" })
    ).toThrow();
    expect(() =>
      calc.paramsSchema.parse({ env: "preview", output: "down", x: 1 })
    ).toThrow();
    expect(
      calc.paramsSchema.parse({ env: "candidate-a", output: "probed" })
    ).toEqual({ env: "candidate-a", output: "probed" });
  });
});

describe("classifyReach", () => {
  it("200 reaches every dependency", () => {
    for (const dep of [
      "postgres",
      "temporal",
      "scheduler-worker",
      "evm-rpc",
    ] as const)
      expect(classifyReach(ok(), dep)).toBe("reached");
  });
  it("a 503 with an unreachable list reaches dep iff dep is not in it", () => {
    const r = status(503, { unreachable: ["temporal", "postgres"] });
    expect(classifyReach(r, "postgres")).toBe("unreached");
    expect(classifyReach(r, "temporal")).toBe("unreached");
    expect(classifyReach(r, "scheduler-worker")).toBe("reached");
    expect(classifyReach(status(503, { unreachable: [] }), "postgres")).toBe(
      "reached"
    );
  });
  it("a 503 without a usable list, any other status and a timeout are unknown; free text is never parsed", () => {
    expect(classifyReach(status(503, {}), "postgres")).toBe("unknown");
    expect(classifyReach(status(503, "not json"), "postgres")).toBe("unknown");
    expect(
      classifyReach(status(503, { unreachable: "postgres" }), "postgres")
    ).toBe("unknown");
    expect(
      classifyReach(status(503, { unreachable: [1, 2] }), "postgres")
    ).toBe("unknown");
    expect(
      classifyReach(
        status(503, { message: "postgres is unreachable", status: "down" }),
        "postgres"
      )
    ).toBe("unknown");
    expect(
      classifyReach(status(502, { unreachable: ["postgres"] }), "postgres")
    ).toBe("unknown");
    expect(classifyReach(timeout, "postgres")).toBe("unknown");
  });
});

describe(SUBSTRATE_REACH_ID, () => {
  const lanes = [lane("a"), lane("b"), lane("c"), lane("d")];
  const ready = {
    "b.cognidao.org": status(503, { unreachable: ["postgres"] }),
    "c.cognidao.org": status(503, { error: "boom" }),
    "d.cognidao.org": timeout,
  };
  it("% of KNOWN lanes that reach the dependency; unknown lanes are excluded and counted", async () => {
    const { calcs } = fleet(source({ lanes, ready }));
    const pg = await run(calcs, SUBSTRATE_REACH_ID, {
      env: "production",
      dependency: "postgres",
    });
    // a reached, b unreached, c and d unknown.
    expect(pg).toMatchObject({ complete: true, unit: "%", value: 50 });
    expect(pg.evidenceRefs).toEqual(
      expect.arrayContaining([
        "fleet:dependency=postgres",
        "fleet:declared=4,known=2,reached=1,unknown=2",
        `lane:${NODE}/production/b:unreachable/postgres`,
      ])
    );
    const temporal = await run(calcs, SUBSTRATE_REACH_ID, {
      env: "production",
      dependency: "temporal",
    });
    expect(temporal).toMatchObject({ complete: true, value: 100 });
  });
  it("zero known lanes is unavailable, never 0 or 100", async () => {
    const all = [lane("c"), lane("d")];
    const s = await run(
      fleet(
        source({
          lanes: all,
          ready: {
            "c.cognidao.org": status(503),
            "d.cognidao.org": timeout,
          },
        })
      ).calcs,
      SUBSTRATE_REACH_ID,
      { env: "production", dependency: "evm-rpc" }
    );
    expect(s).toMatchObject({ complete: false, reason: "zero_denominator" });
  });
  it("a failing control probe is unavailable source_failed", async () => {
    const s = await run(
      fleet(source({ lanes, control: timeout })).calcs,
      SUBSTRATE_REACH_ID,
      { env: "production", dependency: "postgres" }
    );
    expect(s).toMatchObject({ complete: false, reason: "source_failed" });
  });
  it("floors the percent so one unreached lane of 7 never rounds up to 100", async () => {
    const seven = Array.from({ length: 7 }, (_, i) => lane(`w${i}`));
    const s = await run(
      fleet(
        source({
          lanes: seven,
          ready: {
            "w0.cognidao.org": status(503, { unreachable: ["evm-rpc"] }),
          },
        })
      ).calcs,
      SUBSTRATE_REACH_ID,
      { env: "production", dependency: "evm-rpc" }
    );
    expect(s.value).toBe(85.714);
  });
  it("rejects a dependency outside the list", () => {
    const calc = fleet(source({})).calcs.find(
      (c) => c.id === SUBSTRATE_REACH_ID
    ) as MetricCalculator;
    expect(() =>
      calc.paramsSchema.parse({ env: "production", dependency: "doltgres" })
    ).toThrow();
    expect(() =>
      calc.paramsSchema.parse({ env: "production", dependency: "redis" })
    ).toThrow();
  });
});

describe("percentFloor3 and parseLaneCounts", () => {
  it("is exact at the 99.9 target and floors below it", () => {
    expect(percentFloor3(999, 1000)).toBe(99.9);
    expect(percentFloor3(9989, 10000)).toBe(99.89);
    expect(percentFloor3(14058, 14112)).toBe(99.617);
  });
  it("parses the evidence line and rejects corrupt counts", () => {
    expect(parseLaneCounts("fleet:declared=7,probed=7,down=6")).toEqual({
      declared: 7,
      probed: 7,
      down: 6,
    });
    expect(parseLaneCounts("fleet:declared=7,probed=7,down=8")).toBeUndefined();
    expect(parseLaneCounts("fleet:declared=7,probed=9,down=1")).toBeUndefined();
    expect(parseLaneCounts("fleet:declared=x")).toBeUndefined();
  });
});

describe(UPTIME_ID, () => {
  const reading = (
    i: number,
    counts: { declared?: number; probed?: number; down?: number },
    atMs: number,
    scheduledMs = atMs
  ): FleetLanesDownReading => ({
    observationId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    at: new Date(atMs),
    scheduledFor: new Date(scheduledMs),
    cadenceSeconds: 300,
    evidence: `fleet:declared=${counts.declared ?? 7},probed=${counts.probed ?? 7},down=${counts.down ?? 0}`,
  });

  /** 7 days of 5-minute readings; `outage` readings (the 45 min of 2026-11-07) have 6 of 7 lanes down. */
  function replay(outageReadings: number): FleetLanesDownReading[] {
    const total = (7 * DAY) / (5 * MIN);
    return Array.from({ length: total }, (_, i) => {
      const at = NOW - 7 * DAY + i * 5 * MIN;
      const inOutage = i >= 1000 && i < 1000 + outageReadings;
      return reading(i, { down: inOutage ? 6 : 0 }, at);
    });
  }

  it("the 2026-11-07 replay (6 of 7 lanes down for 45 min over 7 days) is about 99.62%, below 99.9", async () => {
    const obs = observations(replay(9));
    const s = await run(fleet(source({}), obs).calcs, UPTIME_ID, {
      env: "production",
      days: 7,
    });
    // 54 down of 14,112 lane-probes.
    expect(s).toMatchObject({ complete: true, unit: "%" });
    expect(s.value).toBeCloseTo(99.62, 1);
    expect(s.value).toBe(99.617);
    expect(s.value).toBeLessThan(99.9);
    expect(s.evidenceRefs).toContain(
      "fleet:readings=2016,probed=14112,down=54,unparseable=0"
    );
    expect(s.evidenceRefs.filter((r) => r.startsWith("obs:")).length).toBe(9);
    // The read is the half-open window [T-7d, T) for the env, and nothing is probed.
    expect(obs.calls).toEqual([
      {
        env: "production",
        from: new Date(NOW - 7 * DAY),
        to: new Date(NOW),
      },
    ]);
  });
  it("100 when every stored probe was good", async () => {
    const s = await run(
      fleet(source({}), observations(replay(0))).calcs,
      UPTIME_ID,
      { env: "production" }
    );
    expect(s).toMatchObject({ complete: true, value: 100 });
  });
  it("less than 24 h of readings is unavailable insufficient_history, with none at all too", async () => {
    const short = Array.from({ length: 12 * 20 }, (_, i) =>
      reading(i, { down: 7 }, NOW - 20 * HOUR + i * 5 * MIN)
    );
    const s = await run(
      fleet(source({}), observations(short)).calcs,
      UPTIME_ID,
      { env: "production", days: 7 }
    );
    expect(s).toMatchObject({
      complete: false,
      reason: "insufficient_history",
    });
    expect(s.evidenceRefs).toContain("fleet:min_history_hours=24");
    await expect(
      run(fleet(source({}), observations([])).calcs, UPTIME_ID, {
        env: "production",
      })
    ).resolves.toMatchObject({
      complete: false,
      reason: "insufficient_history",
    });
  });
  it("exactly 24 h of history is enough when the day's slots are all there", async () => {
    // A 1-day window: 288 five-minute slots, the first with 1 of 7 lanes down.
    const day = Array.from({ length: 288 }, (_, i) =>
      reading(i, { down: i === 0 ? 1 : 0 }, NOW - 24 * HOUR + i * 5 * MIN)
    );
    const s = await run(fleet(source({}), observations(day)).calcs, UPTIME_ID, {
      env: "production",
      days: 1,
    });
    // 1 down of 2,016 lane-probes.
    expect(s).toMatchObject({ complete: true, value: 99.95 });
  });
  it("a second reading of one refresh slot is ignored: one tick counts once", async () => {
    const rows = [
      ...replay(0),
      // Same slot as the first reading, with every lane down: must not count.
      reading(77777, { down: 7 }, NOW - 7 * DAY + 1000, NOW - 7 * DAY),
    ];
    const s = await run(
      fleet(source({}), observations(rows)).calcs,
      UPTIME_ID,
      {
        env: "production",
      }
    );
    expect(s).toMatchObject({ complete: true, value: 100 });
    expect(s.evidenceRefs).toContain(
      "fleet:slots=2016,expected=2016,cadence_seconds=300,duplicates=1"
    );
  });
  it("under half of the window's expected scheduled readings is insufficient_history; exactly half is enough", async () => {
    // 7 days at 300 s expect 2,016 slots. The readings span the whole window (history >= 24 h) but are sparse.
    const sparse = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        reading(i, { down: 7 }, NOW - 7 * DAY + (i * 7 * DAY) / n)
      );
    const low = await run(
      fleet(source({}), observations(sparse(1007))).calcs,
      UPTIME_ID,
      { env: "production", days: 7 }
    );
    expect(low).toMatchObject({
      complete: false,
      reason: "insufficient_history",
    });
    expect(low.evidenceRefs).toContain("fleet:min_coverage=0.5");
    const half = await run(
      fleet(source({}), observations(sparse(1008))).calcs,
      UPTIME_ID,
      { env: "production", days: 7 }
    );
    expect(half).toMatchObject({ complete: true, value: 0 });
  });
  it("uses the stored definition's cadence for the expected slots", async () => {
    // 1-minute cadence expects 1,440 slots a day: 288 five-minute readings are 20%, not enough.
    const rows = Array.from({ length: 288 }, (_, i) => ({
      ...reading(i, {}, NOW - 24 * HOUR + i * 5 * MIN),
      cadenceSeconds: 60,
    }));
    await expect(
      run(fleet(source({}), observations(rows)).calcs, UPTIME_ID, {
        env: "production",
        days: 1,
      })
    ).resolves.toMatchObject({
      complete: false,
      reason: "insufficient_history",
    });
  });
  it("a truncated read is unknown; unparseable readings are skipped and counted, never zero-filled", async () => {
    await expect(
      run(fleet(source({}), observations(replay(0), true)).calcs, UPTIME_ID, {
        env: "production",
      })
    ).resolves.toMatchObject({
      complete: false,
      reason: "incomplete_or_invalid_source",
    });
    const rows = [
      ...replay(0),
      { ...reading(99999, {}, NOW - MIN), evidence: "fleet:declared=oops" },
    ];
    const s = await run(
      fleet(source({}), observations(rows)).calcs,
      UPTIME_ID,
      {
        env: "production",
      }
    );
    expect(s).toMatchObject({ complete: true, value: 100 });
    expect(s.evidenceRefs).toContain(
      "fleet:readings=2016,probed=14112,down=0,unparseable=1"
    );
  });
  it("readings with nothing probed are unknown, not 100", async () => {
    const rows = Array.from({ length: 288 }, (_, i) =>
      reading(i, { probed: 0, down: 0 }, NOW - 24 * HOUR + i * 5 * MIN)
    );
    await expect(
      run(fleet(source({}), observations(rows)).calcs, UPTIME_ID, {
        env: "production",
        days: 1,
      })
    ).resolves.toMatchObject({ complete: false, reason: "zero_denominator" });
  });
  it("is a historical, bounded, probe-free calculator over a days window", () => {
    const calc = fleet(source({})).calcs.find(
      (c) => c.id === UPTIME_ID
    ) as MetricCalculator;
    expect(calc.historicalWindows).toBe(true);
    expect(calc.windowSeconds?.({ env: "production", days: 7 })).toBe(
      7 * 86400
    );
    expect(calc.budget.maxRows).toBe(MAX_UPTIME_READINGS);
    expect(calc.budget.maxSourceCalls).toBe(1);
    expect(() =>
      calc.paramsSchema.parse({ env: "production", days: 29 })
    ).toThrow();
  });
});

describe("the shared per-tick probe snapshot", () => {
  it("drift, lanes-down and reach probe each lane once per tick", async () => {
    const src = source({ lanes: [lane("a"), lane("b")] });
    const { calcs, drift } = fleet(src);
    const driftCalc = drift().find(
      (c) => c.id === SERVING_DRIFT_ID
    ) as MetricCalculator;
    const driftSample = await run([driftCalc], SERVING_DRIFT_ID, {
      env: "production",
    });
    await run(calcs, LANES_DOWN_ID, lanesDown());
    await run(calcs, SUBSTRATE_REACH_ID, {
      env: "production",
      dependency: "postgres",
    });
    expect(driftSample).toMatchObject({ complete: true, value: 0 });
    expect(src.laneReads).toBe(1);
    expect(
      src.probes.filter(
        (p) => hostOf(p) === "a.cognidao.org" && p.includes("/readyz")
      )
    ).toHaveLength(1);
    expect(src.probes.filter((p) => hostOf(p) === CONTROL)).toHaveLength(1);
    expect(src.probes).toHaveLength(1 + 2 * 2);
  });
  it("different envs are different snapshots", async () => {
    const src = source({ lanes: [lane("a")] });
    const { calcs } = fleet(src);
    await run(calcs, LANES_DOWN_ID, lanesDown("down", "production"));
    await run(calcs, LANES_DOWN_ID, lanesDown("down", "preview"));
    expect(src.laneReads).toBe(2);
  });
  it("a snapshot older than the TTL is rebuilt", async () => {
    const src = source({ lanes: [lane("a")] });
    let at = NOW;
    const snapshots = createFleetProbeSnapshots(src, {
      controlHost: CONTROL,
      now: () => at,
      ttlMs: 60_000,
    });
    const calcs = createFleetCalculators({
      snapshots,
      observations: observations([]),
    });
    await run(calcs, LANES_DOWN_ID, lanesDown());
    at += 59_000;
    await run(calcs, LANES_DOWN_ID, lanesDown());
    expect(src.laneReads).toBe(1);
    at += 2_000;
    await run(calcs, LANES_DOWN_ID, lanesDown());
    expect(src.laneReads).toBe(2);
  });
  it("a probe error on one lane is that lane's result; drift and lanes-down still read", async () => {
    const lanes = [lane("a"), lane("b")];
    const src = source({ lanes });
    const base = src.probe;
    src.probe = async (input) => {
      if (input.host === "b.cognidao.org") throw new Error("boom");
      return base(input);
    };
    const { calcs, drift } = fleet(src);
    const down = await run(calcs, LANES_DOWN_ID, lanesDown());
    expect(down).toMatchObject({ complete: true, value: 1 });
    expect(down.evidenceRefs).toContain(
      `lane:${NODE}/production/b:unreachable/network`
    );
    const driftCalc = drift().find(
      (c) => c.id === SERVING_DRIFT_ID
    ) as MetricCalculator;
    const d = await run([driftCalc], SERVING_DRIFT_ID, { env: "production" });
    expect(d).toMatchObject({ complete: true, value: 1 });
    expect(d.evidenceRefs).toContain(
      `lane:${NODE}/production/b:unreachable/network`
    );
  });
  it("a caller abort still fails the whole snapshot", async () => {
    const src = source({ lanes: [lane("a")] });
    const base = src.probe;
    const controller = new AbortController();
    src.probe = async (input) => {
      if (input.host === "a.cognidao.org") {
        controller.abort();
        throw new Error("aborted");
      }
      return base(input);
    };
    const { snapshots } = fleet(src);
    const calc = createFleetCalculators({
      snapshots,
      observations: observations([]),
    }).find((c) => c.id === LANES_DOWN_ID) as MetricCalculator;
    const ctx: CalculatorContext = {
      window: {
        start: new Date(NOW).toISOString(),
        end: new Date(NOW).toISOString(),
      },
      signal: controller.signal,
      budget: calc.budget,
      read: (fn) => fn(controller.signal, calc.budget),
    };
    await expect(
      calc.compute(calc.paramsSchema.parse(lanesDown()), ctx)
    ).rejects.toThrow("aborted");
  });
  it("a failed build and an unverified egress are not cached", async () => {
    const src = source({ lanes: [lane("a")] });
    const { calcs } = fleet(src);
    const realProbe = src.probe;
    src.probe = async () => {
      throw new Error("aborted");
    };
    await expect(run(calcs, LANES_DOWN_ID, lanesDown())).rejects.toThrow(
      "aborted"
    );
    src.probe = realProbe;
    await expect(run(calcs, LANES_DOWN_ID, lanesDown())).resolves.toMatchObject(
      {
        complete: true,
        value: 0,
      }
    );

    const down = source({
      lanes: [lane("a")],
      control: { kind: "unreachable", code: "network" },
    });
    const f = fleet(down);
    await run(f.calcs, LANES_DOWN_ID, lanesDown());
    await run(f.calcs, LANES_DOWN_ID, lanesDown());
    expect(down.probes.filter((p) => hostOf(p) === CONTROL)).toHaveLength(2);
  });
});

describe("registry shape", () => {
  it("ids use dashes, never underscores, and are unique", () => {
    const { calcs } = fleet(source({}));
    const ids = calcs.map((c) => c.id);
    expect(ids).toEqual([LANES_DOWN_ID, SUBSTRATE_REACH_ID, UPTIME_ID]);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9.-]*@[1-9][0-9]*$/);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
