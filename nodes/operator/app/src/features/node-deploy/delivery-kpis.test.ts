// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/delivery-kpis.test`
 * Purpose: Prove the delivery goal-KPI calculators (task.5442) over an in-memory source: finished-release
 *   classification (superseded counts as neither), the raw finished guardrail, lead time from the
 *   write-once column only, and serving drift (a wrong build, a stuck release and an unrunnable probe).
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
  DeliveryReleaseFacts,
} from "@/ports";
import {
  classifyRelease,
  createDeliveryCalculators,
  LEAD_TIME_ID,
  percentile,
  RELEASE_SUCCESS_ID,
  SERVING_DRIFT_ID,
} from "./delivery-kpis";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const DAY = 86_400_000;
const MIN = 60_000;
const NODE = "11111111-1111-4111-8111-111111111111";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const at = (msBeforeNow: number) => new Date(NOW - msBeforeNow);

function release(over: Partial<DeliveryReleaseFacts>): DeliveryReleaseFacts {
  return {
    releaseId: over.releaseId ?? crypto.randomUUID(),
    nodeId: NODE,
    env: "production",
    workload: "app",
    createdAt: at(DAY),
    activatedAt: undefined,
    activatedStepAt: undefined,
    served: false,
    parkedAt: undefined,
    current: true,
    ...over,
  };
}

function lane(over: Partial<DeliveryLaneFacts>): DeliveryLaneFacts {
  return {
    nodeId: NODE,
    env: "production",
    workload: "app",
    host: "node.cognidao.org",
    versionPath: "/version",
    readyPath: "/readyz",
    desiredReleaseId: "r1",
    desiredCreatedAt: at(DAY),
    activeReleaseId: "r1",
    expectedSha: SHA_A,
    ...over,
  };
}

function source(input: {
  releases?: DeliveryReleaseFacts[];
  lanes?: DeliveryLaneFacts[];
  probe?: (host: string, path: string) => DeliveryProbeResult;
}): DeliveryKpiSourcePort & { probes: string[] } {
  const probes: string[] = [];
  return {
    probes,
    releases: async ({ maxRows }) => ({
      rows: (input.releases ?? []).slice(0, maxRows),
      truncated: (input.releases ?? []).length > maxRows,
      asOf: new Date(NOW),
    }),
    servingLanes: async ({ maxRows }) => ({
      lanes: (input.lanes ?? []).slice(0, maxRows),
      truncated: (input.lanes ?? []).length > maxRows,
      asOf: new Date(NOW),
    }),
    probe: async ({ host, path }) => {
      probes.push(`${host}${path}`);
      return (
        input.probe?.(host, path) ?? {
          kind: "response",
          status: 200,
          body: JSON.stringify({ buildSha: SHA_A }),
        }
      );
    },
  };
}

/** Run one calculator the way the engine does: parse params, bounded reads, a 7-day window. */
async function run(
  src: DeliveryKpiSourcePort,
  id: string,
  params: Record<string, unknown>
): Promise<MetricSample> {
  const calc = createDeliveryCalculators(src, () => NOW).find(
    (c) => c.id === id
  ) as MetricCalculator;
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

describe("classifyRelease", () => {
  const from = at(7 * DAY);
  const to = new Date(NOW);
  it("first activation is success; lead time only from the write-once column", () => {
    const r = release({ createdAt: at(DAY), activatedAt: at(DAY - 6 * MIN) });
    expect(classifyRelease(r, from, to)).toMatchObject({
      kind: "success",
      leadMs: 6 * MIN,
    });
    const stepOnly = release({ activatedStepAt: at(DAY - 6 * MIN) });
    expect(classifyRelease(stepOnly, from, to)).toEqual({
      kind: "success",
      at: at(DAY - 6 * MIN),
    });
  });
  it("a parked release is a failure; superseded and in-flight count as neither", () => {
    expect(classifyRelease(release({ parkedAt: at(DAY) }), from, to).kind).toBe(
      "failure"
    );
    expect(classifyRelease(release({ current: false }), from, to).kind).toBe(
      "superseded"
    );
    expect(classifyRelease(release({}), from, to).kind).toBe("in_flight");
    // Parked first, superseded later: it finished as a failure.
    expect(
      classifyRelease(release({ parkedAt: at(DAY), current: false }), from, to)
        .kind
    ).toBe("failure");
  });
  it("finish instants outside [from, to) are outside the window", () => {
    expect(
      classifyRelease(
        release({ createdAt: at(9 * DAY), activatedAt: at(8 * DAY) }),
        from,
        to
      ).kind
    ).toBe("outside");
  });
});

describe(RELEASE_SUCCESS_ID, () => {
  const rows = [
    ...Array.from({ length: 29 }, (_, i) =>
      release({
        activatedAt: at(DAY + i * MIN),
        createdAt: at(DAY + (i + 5) * MIN),
      })
    ),
    release({ parkedAt: at(2 * DAY) }),
    release({ current: false }), // superseded: neither
    release({}), // in flight: neither
  ];
  it("percent = success / (success + failure) over finished releases", async () => {
    const s = await run(source({ releases: rows }), RELEASE_SUCCESS_ID, {
      output: "percent",
    });
    expect(s).toMatchObject({ complete: true, unit: "%", value: 96.67 });
    expect(s.evidenceRefs).toContain("deploy:success=29,failure=1,finished=30");
    expect(s.evidenceRefs).toContain(
      "deploy:superseded=1,in_flight=1,untimed=0"
    );
  });
  it("the guardrail reports the raw finished count", async () => {
    const s = await run(source({ releases: rows }), RELEASE_SUCCESS_ID, {
      output: "finished",
    });
    expect(s).toMatchObject({ complete: true, unit: "releases", value: 30 });
  });
  it("fewer than minFinished is unknown, never a pass", async () => {
    const s = await run(
      source({ releases: rows.slice(0, 5) }),
      RELEASE_SUCCESS_ID,
      { output: "percent" }
    );
    expect(s).toMatchObject({
      complete: false,
      reason: "insufficient_history",
    });
    const none = await run(source({ releases: [] }), RELEASE_SUCCESS_ID, {
      output: "percent",
    });
    expect(none).toMatchObject({ complete: false, reason: "zero_denominator" });
  });
});

describe(LEAD_TIME_ID, () => {
  it("p50/p90 minutes from successes with activated_at; others are excluded and counted", async () => {
    const leads = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
    const rows = [
      ...leads.map((m) =>
        release({ createdAt: at(DAY + m * MIN), activatedAt: at(DAY) })
      ),
      release({ activatedStepAt: at(DAY) }),
    ];
    const p50 = await run(source({ releases: rows }), LEAD_TIME_ID, {
      quantile: 50,
    });
    expect(p50).toMatchObject({ complete: true, unit: "min", value: 10 });
    expect(p50.evidenceRefs).toContain(
      "deploy:lead_samples=10,missing_activated_at=1"
    );
    const p90 = await run(source({ releases: rows }), LEAD_TIME_ID, {
      quantile: 90,
    });
    expect(p90.value).toBe(18);
    expect(percentile([5], 90)).toBe(5);
  });
  it("no timed success is unknown", async () => {
    const s = await run(
      source({ releases: [release({ activatedStepAt: at(DAY) })] }),
      LEAD_TIME_ID,
      { quantile: 50 }
    );
    expect(s).toMatchObject({ complete: false, reason: "zero_denominator" });
  });
});

describe(SERVING_DRIFT_ID, () => {
  it("0 bad lanes when every lane serves its active release's sha and readyz is 200", async () => {
    const src = source({ lanes: [lane({})] });
    const s = await run(src, SERVING_DRIFT_ID, {});
    expect(s).toMatchObject({ complete: true, unit: "lanes", value: 0 });
    expect(src.probes).toEqual([
      "node.cognidao.org/version",
      "node.cognidao.org/readyz?deep=1",
    ]);
  });
  it("a deliberate wrong build turns the lane bad", async () => {
    const src = source({
      lanes: [
        lane({}),
        lane({ workload: "other", host: "other.cognidao.org" }),
      ],
      probe: (host, path) =>
        host === "other.cognidao.org" && path === "/version"
          ? {
              kind: "response",
              status: 200,
              body: JSON.stringify({ buildSha: SHA_B }),
            }
          : {
              kind: "response",
              status: 200,
              body: JSON.stringify({ buildSha: SHA_A }),
            },
    });
    const s = await run(src, SERVING_DRIFT_ID, {});
    expect(s.value).toBe(1);
    expect(s.evidenceRefs).toContain(
      `lane:${NODE}/production/other:sha_mismatch`
    );
  });
  it("no active attempt, a stuck desired release, readyz failure and an unreachable host are bad", async () => {
    const src = source({
      lanes: [
        lane({
          workload: "a",
          activeReleaseId: undefined,
          expectedSha: undefined,
        }),
        lane({
          workload: "b",
          desiredReleaseId: "r2",
          desiredCreatedAt: at(31 * MIN),
        }),
        lane({ workload: "c", host: "c.cognidao.org" }),
        lane({ workload: "d", host: "d.cognidao.org" }),
        // Newer release recorded 5 min ago, old one still serving: not yet stuck.
        lane({
          workload: "e",
          desiredReleaseId: "r3",
          desiredCreatedAt: at(5 * MIN),
        }),
      ],
      probe: (host, path) =>
        host === "c.cognidao.org" && path.startsWith("/readyz")
          ? { kind: "response", status: 503, body: "" }
          : host === "d.cognidao.org"
            ? { kind: "unreachable", code: "timeout" }
            : {
                kind: "response",
                status: 200,
                body: JSON.stringify({ buildSha: SHA_A }),
              },
    });
    const s = await run(src, SERVING_DRIFT_ID, {});
    expect(s.value).toBe(4);
    expect(s.evidenceRefs).toEqual(
      expect.arrayContaining([
        `lane:${NODE}/production/a:no_active_attempt`,
        `lane:${NODE}/production/b:stuck_release`,
        `lane:${NODE}/production/c:readyz_status`,
        `lane:${NODE}/production/d:unreachable`,
      ])
    );
  });
  it("zero lanes and a probe that cannot run are unknown, never a pass", async () => {
    await expect(
      run(source({ lanes: [] }), SERVING_DRIFT_ID, {})
    ).resolves.toMatchObject({ complete: false, reason: "zero_denominator" });
    const src = source({ lanes: [lane({})] });
    src.probe = async () => {
      throw new Error("aborted");
    };
    await expect(run(src, SERVING_DRIFT_ID, {})).rejects.toThrow("aborted");
  });
  it("ids use dashes, never underscores", () => {
    for (const c of createDeliveryCalculators(source({})))
      expect(c.id).toMatch(/^[a-z][a-z0-9.-]*@[1-9][0-9]*$/);
  });
});
