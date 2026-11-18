// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/delivery-kpis-test-envs.test`
 * Purpose: Pin how the delivery calculators treat test envs (story.5159): the `testEnvs` param is optional with
 *   NO default (stored definition params and binding identity stay byte-stable); absent it asks the source to
 *   exclude test-env workloads and keeps the pre-existing evidence text; `"only"` selects them and `"include"`
 *   selects both; the fleet snapshot never shares a key across modes; and the lead-time calculator reads request-to-
 *   ready of test envs only.
 * Scope: Calculators over a source that records the scope it is asked for.
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
  DeliveryReleaseFacts,
  DeliveryScope,
} from "@/ports";
import {
  createDeliveryCalculators,
  FIRST_TRY_ID,
  LEAD_TIME_ID,
  RELEASE_SUCCESS_ID,
  SERVING_DRIFT_ID,
} from "./delivery-kpis";
import { createFleetProbeSnapshots } from "./fleet-probe-snapshot";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const MIN = 60_000;
const NODE = "11111111-1111-4111-8111-111111111111";

/** A release that activated `leadMin` minutes after its POST, an hour ago. */
const served = (workload: string, leadMin: number): DeliveryReleaseFacts => {
  const createdAt = new Date(NOW - 60 * MIN);
  return {
    releaseId: crypto.randomUUID(),
    nodeId: NODE,
    env: "candidate-a",
    workload,
    sourceSha: "a".repeat(40),
    createdBy: "user:u1",
    admissionRefusalReason: undefined,
    createdAt,
    activatedAt: new Date(createdAt.getTime() + leadMin * MIN),
    activatedStepAt: undefined,
    served: true,
    parkedAt: undefined,
    parkStepSeen: false,
    current: true,
    firstActivatedAttempt: 1,
    failedBeforeActivation: false,
  };
};

/**
 * A source that honors `DeliveryScope.testEnvs` the way the SQL adapter does (absent = exclude, "only" = only,
 * "include" = both; the adapter itself is pinned in delivery-kpi-source.test.ts) and records every scope.
 */
function source(all: DeliveryReleaseFacts[]) {
  const scopes: DeliveryScope[] = [];
  const isTe = (w: string) => /^te[a-z]{6}$/.test(w);
  const port: DeliveryKpiSourcePort = {
    releases: async ({ scope, maxRows }) => {
      scopes.push(scope);
      const rows = all.filter((r) =>
        scope.testEnvs === "include"
          ? true
          : scope.testEnvs === "only"
            ? isTe(r.workload)
            : !isTe(r.workload)
      );
      return {
        rows: rows.slice(0, maxRows),
        truncated: false,
        asOf: new Date(NOW),
      };
    },
    servingLanes: async ({ scope }) => {
      scopes.push(scope);
      return { lanes: [], truncated: false, asOf: new Date(NOW) };
    },
    probe: async () => ({ kind: "unreachable", code: "test" }),
  };
  return { port, scopes };
}

async function run(
  src: DeliveryKpiSourcePort,
  id: string,
  params: Record<string, unknown>
): Promise<MetricSample> {
  const calc = createDeliveryCalculators(src, {
    controlHost: "cognidao.org",
    now: () => NOW,
  }).find((c) => c.id === id) as MetricCalculator;
  const windowMs = (calc.windowSeconds?.(params) ?? 0) * 1000;
  const controller = new AbortController();
  const ctx: CalculatorContext = {
    window: {
      start: new Date(NOW - windowMs).toISOString(),
      end: new Date(NOW).toISOString(),
    },
    signal: controller.signal,
    budget: calc.budget,
    async read(fn) {
      return fn(controller.signal, calc.budget);
    },
  };
  return calc.compute(calc.paramsSchema.parse(params), ctx);
}

/** The required (non-scope) params of each calculator. */
const REQUIRED: Record<string, Record<string, unknown>> = {
  [LEAD_TIME_ID]: { quantile: 90 },
  [FIRST_TRY_ID]: { output: "percent" },
  [RELEASE_SUCCESS_ID]: { output: "percent" },
};

const calculators = createDeliveryCalculators(source([]).port, {
  controlHost: "cognidao.org",
  now: () => NOW,
});

describe("testEnvs param (story.5159)", () => {
  it("is optional with NO default: parsing a stored param set adds no key", () => {
    for (const id of [
      LEAD_TIME_ID,
      FIRST_TRY_ID,
      RELEASE_SUCCESS_ID,
      SERVING_DRIFT_ID,
    ]) {
      const calc = calculators.find((c) => c.id === id) as MetricCalculator;
      const base = REQUIRED[id] ?? {};
      const parsed = calc.paramsSchema.parse({ env: "candidate-a", ...base });
      expect(Object.keys(parsed as object), id).not.toContain("testEnvs");
      expect(
        (
          calc.paramsSchema.parse({
            env: "candidate-a",
            ...base,
            testEnvs: "only",
          }) as {
            testEnvs?: string;
          }
        ).testEnvs
      ).toBe("only");
    }
  });
  it("rejects any value but only | include", () => {
    const calc = calculators.find(
      (c) => c.id === LEAD_TIME_ID
    ) as MetricCalculator;
    for (const bad of ["exclude", "all", true, 1])
      expect(() =>
        calc.paramsSchema.parse({ quantile: 90, testEnvs: bad })
      ).toThrow();
  });
});

describe("test-env workloads are excluded by default and selected by `only`", () => {
  const rows = [
    served("app", 5),
    served("canary", 7),
    served("teqwkzmx", 10),
    served("tebbbbbb", 14),
  ];

  it("the default reading never sees a test env: scope carries no testEnvs, evidence text is unchanged", async () => {
    const { port, scopes } = source(rows);
    const s = await run(port, LEAD_TIME_ID, {
      quantile: 90,
      env: "candidate-a",
    });
    expect(scopes).toEqual([{ env: "candidate-a" }]);
    expect(scopes[0]).not.toHaveProperty("testEnvs");
    // p90 over app (5) and canary (7) only: the slower test envs (10, 14) are not in it
    expect(s.value).toBe(7);
    expect(s.evidenceRefs).toContain("scope:node=*,env=candidate-a");
    expect(s.evidenceRefs).toContain("deploy:lead_samples=2,untimed_success=0");
  });

  it('"only" reads just the test envs: request-to-ready p50/p90', async () => {
    const { port, scopes } = source(rows);
    const p90 = await run(port, LEAD_TIME_ID, {
      quantile: 90,
      env: "candidate-a",
      testEnvs: "only",
    });
    expect(scopes).toEqual([{ env: "candidate-a", testEnvs: "only" }]);
    expect(p90.value).toBe(14);
    expect(p90.evidenceRefs).toContain(
      "scope:node=*,env=candidate-a,testEnvs=only"
    );
    expect(p90.evidenceRefs).toContain(
      "deploy:lead_samples=2,untimed_success=0"
    );
    const p50 = await run(port, LEAD_TIME_ID, {
      quantile: 50,
      env: "candidate-a",
      testEnvs: "only",
    });
    expect(p50.value).toBe(10);
  });

  it('"include" reads both', async () => {
    const { port } = source(rows);
    const s = await run(port, LEAD_TIME_ID, {
      quantile: 50,
      env: "candidate-a",
      testEnvs: "include",
    });
    expect(s.evidenceRefs).toContain("deploy:lead_samples=4,untimed_success=0");
  });

  it("first-try and release-success ignore test envs by default too", async () => {
    const { port, scopes } = source(rows);
    for (const id of [FIRST_TRY_ID, RELEASE_SUCCESS_ID])
      await run(port, id, { env: "candidate-a", ...REQUIRED[id] });
    expect(scopes.every((s) => s.testEnvs === undefined)).toBe(true);
    expect(
      (
        await run(port, RELEASE_SUCCESS_ID, {
          env: "candidate-a",
          output: "percent",
        })
      ).evidenceRefs
    ).toContain("scope:node=*,env=candidate-a");
  });
});

describe("the per-tick fleet snapshot", () => {
  it("never shares a snapshot between the default, `only` and `include` scopes", async () => {
    const { port, scopes } = source([]);
    const snapshots = createFleetProbeSnapshots(port, {
      controlHost: "cognidao.org",
      now: () => NOW,
    });
    const ctx = {
      window: {
        start: new Date(NOW).toISOString(),
        end: new Date(NOW).toISOString(),
      },
      signal: new AbortController().signal,
      budget: {
        timeoutMs: 8000,
        maxSourceCalls: 5,
        maxRows: 100,
        maxResponseBytes: 1_000_000,
      },
      read: async (fn: (s: AbortSignal, b: unknown) => Promise<unknown>) =>
        fn(new AbortController().signal, { maxRows: 100 }),
    } as unknown as CalculatorContext;
    await snapshots.get({ env: "candidate-a" }, ctx);
    await snapshots.get({ env: "candidate-a", testEnvs: "only" }, ctx);
    await snapshots.get({ env: "candidate-a", testEnvs: "include" }, ctx);
    // a repeat of the default is served from the snapshot cache; the other two modes each read once
    await snapshots.get({ env: "candidate-a" }, ctx);
    expect(scopes.map((s) => s.testEnvs ?? "-")).toEqual([
      "-",
      "only",
      "include",
    ]);
  });
});
