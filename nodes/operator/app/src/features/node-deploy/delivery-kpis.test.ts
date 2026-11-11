// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/delivery-kpis.test`
 * Purpose: Prove the delivery goal-KPI calculators (task.5442, bug.5617) over an in-memory source:
 *   finished-release classification, eventual success (the guardrail), first-try success (a superseded
 *   release with a failed attempt is a miss), lead time for EVERY success (column, else step time), and
 *   serving drift (a wrong build, a stuck release and an unrunnable probe).
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
  FIRST_TRY_ID,
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
const CONTROL = "cognidao.org";

const at = (msBeforeNow: number) => new Date(NOW - msBeforeNow);

function release(over: Partial<DeliveryReleaseFacts>): DeliveryReleaseFacts {
  return {
    releaseId: over.releaseId ?? crypto.randomUUID(),
    nodeId: NODE,
    env: "production",
    workload: "app",
    sourceSha: SHA_A,
    createdBy: "user:u1",
    admissionRefusalReason: undefined,
    createdAt: at(DAY),
    activatedAt: undefined,
    activatedStepAt: undefined,
    served: false,
    parkedAt: undefined,
    parkStepSeen: false,
    current: true,
    firstActivatedAttempt: undefined,
    failedBeforeActivation: false,
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
  params: Record<string, unknown>,
  /** `null` = no control host configured (a default parameter would swallow `undefined`). */
  controlHost: string | null = CONTROL
): Promise<MetricSample> {
  const calc = createDeliveryCalculators(src, {
    controlHost: controlHost ?? undefined,
    now: () => NOW,
  }).find((c) => c.id === id) as MetricCalculator;
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
  it("first activation is success; lead time from the column, else the activated step", () => {
    const r = release({ createdAt: at(DAY), activatedAt: at(DAY - 6 * MIN) });
    expect(classifyRelease(r, from, to)).toMatchObject({
      kind: "success",
      leadMs: 6 * MIN,
    });
    // bug.5617: activated only by its step (no write-once column) still has a lead time.
    const stepOnly = release({ activatedStepAt: at(DAY - 6 * MIN) });
    expect(classifyRelease(stepOnly, from, to)).toEqual({
      kind: "success",
      at: at(DAY - 6 * MIN),
      leadMs: 6 * MIN,
      firstTry: false,
    });
    // The column wins when both exist.
    const both = release({
      activatedAt: at(DAY - 4 * MIN),
      activatedStepAt: at(DAY - 9 * MIN),
    });
    expect(classifyRelease(both, from, to)).toMatchObject({ leadMs: 4 * MIN });
  });
  it("first-try = first activated attempt 1 with no earlier failed attempt", () => {
    const firstTry = (over: Partial<DeliveryReleaseFacts>) =>
      (
        classifyRelease(
          release({ activatedAt: at(DAY), ...over }),
          from,
          to
        ) as { firstTry: boolean }
      ).firstTry;
    expect(firstTry({ firstActivatedAttempt: 1 })).toBe(true);
    expect(firstTry({ firstActivatedAttempt: 2 })).toBe(false);
    expect(
      firstTry({ firstActivatedAttempt: 3, failedBeforeActivation: true })
    ).toBe(false);
    expect(
      firstTry({ firstActivatedAttempt: 1, failedBeforeActivation: true })
    ).toBe(false);
    // Unknown attempt number is never counted as a first try.
    expect(firstTry({ firstActivatedAttempt: undefined })).toBe(false);
  });
  it("a served release with no activation instant is an untimed success, not a drop", () => {
    expect(classifyRelease(release({ served: true }), from, to)).toEqual({
      kind: "untimed",
      success: true,
    });
  });
  it("superseded keeps its failed-attempt flag", () => {
    expect(
      classifyRelease(
        release({ current: false, failedBeforeActivation: true }),
        from,
        to
      )
    ).toEqual({ kind: "superseded", hadFailure: true });
    expect(classifyRelease(release({ current: false }), from, to)).toEqual({
      kind: "superseded",
      hadFailure: false,
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
    // A park known only from the repeating step (before parked_at) has no durable instant.
    expect(
      classifyRelease(release({ parkStepSeen: true, current: false }), from, to)
    ).toEqual({ kind: "untimed", success: false });
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
  it("p50/p90 minutes over EVERY success: the column, else the activated step", async () => {
    const leads = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
    const rows = [
      // Half carry the write-once column, half only the step: all ten count.
      ...leads.map((m, i) =>
        release({
          createdAt: at(DAY + m * MIN),
          ...(i % 2 === 0
            ? { activatedAt: at(DAY) }
            : { activatedStepAt: at(DAY) }),
        })
      ),
    ];
    const p50 = await run(source({ releases: rows }), LEAD_TIME_ID, {
      quantile: 50,
    });
    expect(p50).toMatchObject({ complete: true, unit: "min", value: 10 });
    expect(p50.evidenceRefs).toContain(
      "deploy:lead_samples=10,untimed_success=0"
    );
    const p90 = await run(source({ releases: rows }), LEAD_TIME_ID, {
      quantile: 90,
    });
    expect(p90.value).toBe(18);
    expect(percentile([5], 90)).toBe(5);
  });
  /** `timed` successes of 4 minutes each plus `untimed` served releases with no activation instant. */
  const mixed = (timed: number, untimed: number) => [
    ...Array.from({ length: timed }, (_, i) =>
      release({ createdAt: at(DAY + 4 * MIN), activatedAt: at(DAY + i) })
    ),
    ...Array.from({ length: untimed }, () => release({ served: true })),
  ];
  it("untimed successes at or under 10% do not blank the reading: percentiles use the timed ones", async () => {
    // 1 of 10 and 2 of 20 are exactly 10%: tolerated.
    for (const [timed, untimed] of [
      [9, 1],
      [18, 2],
    ] as const) {
      const s = await run(
        source({ releases: mixed(timed, untimed) }),
        LEAD_TIME_ID,
        { quantile: 90 }
      );
      expect(s).toMatchObject({ complete: true, unit: "min", value: 4 });
      expect(s.evidenceRefs).toContain(
        `deploy:lead_samples=${timed},untimed_success=${untimed}`
      );
    }
  });
  it("untimed successes over 10% make the reading unknown, never an estimate", async () => {
    // 2 of 19 is 10.5%.
    const s = await run(source({ releases: mixed(17, 2) }), LEAD_TIME_ID, {
      quantile: 50,
    });
    expect(s).toMatchObject({
      complete: false,
      reason: "incomplete_or_invalid_source",
    });
    expect(s.evidenceRefs).toContain(
      "deploy:lead_samples=17,untimed_success=2"
    );
    const allUntimed = await run(
      source({ releases: mixed(0, 1) }),
      LEAD_TIME_ID,
      {
        quantile: 50,
      }
    );
    expect(allUntimed.complete).toBe(false);
  });
  it("no successes is unknown; an env param scopes the read", async () => {
    const s = await run(source({ releases: [] }), LEAD_TIME_ID, {
      quantile: 50,
      env: "production",
    });
    expect(s).toMatchObject({ complete: false, reason: "zero_denominator" });
    expect(s.evidenceRefs).toContain(`scope:node=*,env=production`);
  });
});

describe(FIRST_TRY_ID, () => {
  /** n releases that activated; the first `firstTry` on attempt 1, the rest on a later attempt. */
  const activations = (
    env: string,
    n: number,
    firstTry: number,
    stepOnly: number
  ) =>
    Array.from({ length: n }, (_, i) => {
      const created = at(2 * DAY + i * MIN);
      const activated = new Date(created.getTime() + (3 + (i % 5)) * MIN);
      return release({
        env,
        createdAt: created,
        // The last `stepOnly` carry no write-once column: activated only by their step.
        ...(i >= n - stepOnly
          ? { activatedStepAt: activated }
          : { activatedAt: activated }),
        firstActivatedAttempt: i < firstTry ? 1 : 2 + (i % 2),
        failedBeforeActivation: i >= firstTry,
      });
    });

  it("7-day recount shape: production 70 activated, 50 first-try = 71%; lead counts step-only successes", async () => {
    const rows = activations("production", 70, 50, 25);
    const src = source({ releases: rows });
    const pct = await run(src, FIRST_TRY_ID, {
      output: "percent",
      env: "production",
    });
    expect(pct).toMatchObject({ complete: true, unit: "%", value: 71.43 });
    expect(pct.evidenceRefs).toContain("deploy:first_try=50,eligible=70");
    expect(pct.evidenceRefs).toContain(
      "env:production:first_try=50,eligible=70"
    );
    // Eventual success stays at 100% here: every release activated on some attempt (the guardrail).
    const eventual = await run(src, RELEASE_SUCCESS_ID, { output: "percent" });
    expect(eventual.value).toBe(100);
    // 25 of the 70 have no activated_at column: all 70 still have a lead time.
    const lead = await run(src, LEAD_TIME_ID, { quantile: 90 });
    expect(lead.evidenceRefs).toContain(
      "deploy:lead_samples=70,untimed_success=0"
    );
    expect(lead.complete).toBe(true);
  });

  it("a superseded release with a failed attempt is a miss; one without stays out", async () => {
    const rows = [
      ...activations("production", 8, 8, 0),
      release({ current: false, failedBeforeActivation: true }),
      release({ current: false, failedBeforeActivation: true }),
      release({ current: false }), // superseded, no failure: out
      release({ current: true, failedBeforeActivation: true }), // in flight: out
      release({ parkedAt: at(DAY), current: false }), // parked: a failure
    ];
    const s = await run(source({ releases: rows }), FIRST_TRY_ID, {
      output: "percent",
      minFinished: 1,
    });
    // 8 first-try / (8 success + 1 failure + 2 superseded-with-failure)
    expect(s).toMatchObject({ complete: true, value: 72.73 });
    expect(s.evidenceRefs).toContain("deploy:first_try=8,eligible=11");
    expect(s.evidenceRefs).toContain(
      "deploy:success=8,failure=1,superseded_failed=2"
    );
    const count = await run(source({ releases: rows }), FIRST_TRY_ID, {
      output: "count",
    });
    expect(count).toMatchObject({
      complete: true,
      unit: "releases",
      value: 11,
    });
  });

  it("fractional days: a 24 h window counts only releases that finished in it; env=undefined spans every env", async () => {
    const recent = (env: string, firstTry: boolean) =>
      release({
        env,
        createdAt: at(2 * 3_600_000),
        activatedAt: at(3_600_000),
        firstActivatedAttempt: firstTry ? 1 : 2,
        failedBeforeActivation: !firstTry,
      });
    const rows = [
      recent("production", true),
      recent("candidate-a", true),
      recent("candidate-a", false),
      // Finished two days ago: outside the 24 h window.
      release({
        createdAt: at(2 * DAY + 5 * MIN),
        activatedAt: at(2 * DAY),
        firstActivatedAttempt: 1,
      }),
    ];
    const calc = createDeliveryCalculators(source({ releases: rows }), {
      controlHost: CONTROL,
      now: () => NOW,
    }).find((c) => c.id === FIRST_TRY_ID) as MetricCalculator;
    expect(calc.windowSeconds?.({ days: 1, output: "percent" })).toBe(86_400);
    const s = await run(source({ releases: rows }), FIRST_TRY_ID, {
      output: "percent",
      days: 1,
      minFinished: 3,
    });
    expect(s).toMatchObject({ complete: true, value: 66.67 });
    expect(s.evidenceRefs).toContain("env:candidate-a:first_try=1,eligible=2");
    expect(s.evidenceRefs).toContain("env:production:first_try=1,eligible=1");
  });

  it("below minFinished is unknown (insufficient_history); none eligible is zero_denominator", async () => {
    const few = await run(
      source({ releases: activations("production", 3, 3, 0) }),
      FIRST_TRY_ID,
      { output: "percent" }
    );
    expect(few).toMatchObject({
      complete: false,
      reason: "insufficient_history",
    });
    const none = await run(source({ releases: [] }), FIRST_TRY_ID, {
      output: "percent",
    });
    expect(none).toMatchObject({ complete: false, reason: "zero_denominator" });
  });

  it("untimed successes are out of numerator and denominator; at or under 10% the rate stays available", async () => {
    // 9 timed first-try successes + 1 untimed = 10%: tolerated, rate over the 9 timed.
    const ok = await run(
      source({
        releases: [
          ...activations("production", 9, 9, 0),
          release({ served: true }),
        ],
      }),
      FIRST_TRY_ID,
      { output: "percent", minFinished: 1 }
    );
    expect(ok).toMatchObject({ complete: true, value: 100 });
    expect(ok.evidenceRefs).toContain("deploy:first_try=9,eligible=9");
    expect(ok.evidenceRefs).toContain(
      "deploy:superseded=0,in_flight=0,untimed=1,untimed_success=1"
    );
    // 2 untimed of 11 successes = 18%: unknown.
    const over = await run(
      source({
        releases: [
          ...activations("production", 9, 9, 0),
          release({ served: true }),
          release({ served: true }),
        ],
      }),
      FIRST_TRY_ID,
      { output: "percent", minFinished: 1 }
    );
    expect(over).toMatchObject({
      complete: false,
      reason: "incomplete_or_invalid_source",
    });
  });

  it("a release created before the window and superseded inside it lands in its creation window, not this one", async () => {
    const from = NOW - 7 * DAY;
    const rows = [
      ...activations("production", 10, 10, 0),
      // Created 8 days ago (before `from`), replaced inside the window after a failed attempt. A
      // superseded release has no finish instant, so it belongs to the window it was created in.
      release({
        createdAt: new Date(from - DAY),
        current: false,
        failedBeforeActivation: true,
      }),
      // The same shape created inside the window is a first-try miss.
      release({
        createdAt: at(DAY),
        current: false,
        failedBeforeActivation: true,
      }),
    ];
    const s = await run(source({ releases: rows }), FIRST_TRY_ID, {
      output: "percent",
      minFinished: 1,
    });
    expect(s.evidenceRefs).toContain("deploy:first_try=10,eligible=11");
    expect(s.evidenceRefs).toContain(
      "deploy:success=10,failure=0,superseded_failed=1"
    );
  });

  it("a truncated read is unknown, never a rate", async () => {
    const rows = activations("production", 30, 30, 0);
    const truncating = {
      ...source({ releases: rows }),
      releases: async () => ({ rows, truncated: true, asOf: new Date(NOW) }),
    };
    const s = await run(truncating, FIRST_TRY_ID, { output: "percent" });
    expect(s).toMatchObject({
      complete: false,
      reason: "incomplete_or_invalid_source",
    });
  });
});

describe(SERVING_DRIFT_ID, () => {
  it("0 bad lanes when every lane serves its active release's sha and readyz is 200", async () => {
    const src = source({ lanes: [lane({})] });
    const s = await run(src, SERVING_DRIFT_ID, {});
    expect(s).toMatchObject({ complete: true, unit: "lanes", value: 0 });
    // Control probe first, then the lane; /version carries a cache-buster.
    expect(src.probes).toEqual([
      `${CONTROL}/livez?cb=${NOW}`,
      `node.cognidao.org/version?cb=${NOW}`,
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
        host === "other.cognidao.org" && path.startsWith("/version")
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
  it("no active attempt, a stuck desired release, readyz failure and ONE unreachable host (others answer) are bad", async () => {
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
        `lane:${NODE}/production/d:unreachable/timeout`,
      ])
    );
  });
  it("an operator egress outage is unknown, never N bad lanes: the control probe fails", async () => {
    const src = source({
      lanes: [lane({}), lane({ workload: "w2", host: "w2.cognidao.org" })],
      probe: () => ({ kind: "unreachable", code: "network" }),
    });
    const s = await run(src, SERVING_DRIFT_ID, {});
    expect(s).toMatchObject({ complete: false, reason: "source_failed" });
    expect(s.evidenceRefs).toContain(
      "deploy:egress_unverified:control_network"
    );
    // No lane was probed once the control failed.
    expect(src.probes).toEqual([`${CONTROL}/livez?cb=${NOW}`]);
    const noControl = await run(
      source({ lanes: [lane({})] }),
      SERVING_DRIFT_ID,
      {},
      null
    );
    expect(noControl).toMatchObject({
      complete: false,
      reason: "source_failed",
    });
    expect(noControl.evidenceRefs).toContain(
      "deploy:egress_unverified:no_control_host"
    );
  });
  it("every probed lane getting no HTTP answer is unknown even when the control passed", async () => {
    const src = source({
      lanes: [
        lane({ workload: "a", host: "a.cognidao.org" }),
        lane({ workload: "b", host: "b.cognidao.org" }),
        // Not probed (no active attempt): does not make the outage look partial.
        lane({
          workload: "c",
          activeReleaseId: undefined,
          expectedSha: undefined,
        }),
      ],
      probe: (host) =>
        host === CONTROL
          ? { kind: "response", status: 200, body: "{}" }
          : host === "a.cognidao.org"
            ? { kind: "unreachable", code: "timeout" }
            : { kind: "unreachable", code: "network" },
    });
    const s = await run(src, SERVING_DRIFT_ID, {});
    expect(s).toMatchObject({ complete: false, reason: "source_failed" });
    expect(s.evidenceRefs).toContain(
      "deploy:egress_unverified:all_2_lanes_unreachable"
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
    for (const c of createDeliveryCalculators(source({}), {
      controlHost: CONTROL,
    }))
      expect(c.id).toMatch(/^[a-z][a-z0-9.-]*@[1-9][0-9]*$/);
  });
});
