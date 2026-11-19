// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/candidate-backlog-kpis.test`
 * Purpose: Prove `delivery.candidate-backlog@1` (task.5498) over fake sources: backlog = open non-draft PRs whose
 *   head SHA never served on candidate-a; wait p90 = hours from CI green to first activation, with an unserved SHA
 *   waiting until now so the queue cannot hide; unknown is a result (operator, no repo, no App, truncation, no green,
 *   an unreadable GitHub); and the read is bounded (one PR list, one check-suites read per head, only for the wait).
 * Side-effects: none
 */

import type {
  CalculatorContext,
  MetricCalculator,
  MetricSample,
} from "@cogni-dao/metrics/contracts";
import { describe, expect, it } from "vitest";
import type {
  CandidateBacklogSourcePort,
  CandidateOpenPr,
  CandidateRepo,
  DeliveryKpiSourcePort,
  DeliveryReleaseFacts,
} from "@/ports";
import {
  CANDIDATE_BACKLOG_ID,
  createCandidateBacklogCalculators,
  firstServed,
  MAX_CANDIDATE_PRS,
  parseSourceRepo,
} from "./candidate-backlog-kpis";

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const HOUR = 3_600_000;
const NODE = "b927a9dd-0000-4000-8000-000000000001";
const OPERATOR = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const REPO: CandidateRepo = { owner: "cogni-dao", repo: "node-template" };
const sha = (c: string) => c.repeat(40);
const ago = (h: number) => new Date(NOW - h * HOUR);

const pr = (n: number, c: string): CandidateOpenPr => ({
  number: n,
  headSha: sha(c),
  createdAt: ago(100),
  updatedAt: ago(1),
});
/** A PR last updated `d` days ago. */
const prUpdated = (n: number, c: string, d: number): CandidateOpenPr => ({
  ...pr(n, c),
  updatedAt: ago(d * 24),
});

function release(
  c: string,
  over: Partial<DeliveryReleaseFacts> = {}
): DeliveryReleaseFacts {
  return {
    releaseId: crypto.randomUUID(),
    nodeId: NODE,
    env: "candidate-a",
    workload: "app",
    sourceSha: sha(c),
    createdBy: "user:u",
    admissionRefusalReason: undefined,
    createdAt: ago(50),
    activatedAt: undefined,
    activatedStepAt: undefined,
    served: false,
    parkedAt: undefined,
    parkStepSeen: false,
    current: false,
    firstActivatedAttempt: undefined,
    failedBeforeActivation: false,
    ...over,
  };
}

interface Fakes {
  prs?: CandidateOpenPr[];
  truncated?: boolean;
  /** headSha char -> green hours ago (undefined = CI not green) */
  green?: Record<string, number | undefined>;
  incomplete?: string[];
  releases?: DeliveryReleaseFacts[];
  releasesTruncated?: boolean;
  githubThrows?: boolean;
}

function fakes(f: Fakes) {
  const calls = {
    list: 0,
    suites: [] as string[],
    releases: 0,
    scopes: [] as object[],
    recordedFrom: [] as Date[],
  };
  const github: CandidateBacklogSourcePort = {
    openPullRequests: async () => {
      calls.list++;
      if (f.githubThrows) throw new Error("github unreadable");
      return {
        prs: f.prs ?? [],
        truncated: f.truncated ?? false,
        asOf: new Date(NOW),
      };
    },
    ciGreenAt: async ({ headSha }) => {
      calls.suites.push(headSha);
      const h = f.green?.[headSha[0] as string];
      return {
        green: h === undefined ? undefined : ago(h),
        incomplete: f.incomplete?.includes(headSha[0] as string) ?? false,
      };
    },
  };
  const store: DeliveryKpiSourcePort = {
    releases: async ({ scope, recordedFrom }) => {
      calls.releases++;
      calls.scopes.push(scope);
      calls.recordedFrom.push(recordedFrom);
      // honor the filters the way the SQL does: a time bound or a sha list changes what is returned
      const rows = (f.releases ?? []).filter(
        (r) =>
          r.createdAt.getTime() >= recordedFrom.getTime() &&
          (!scope.sourceShas || scope.sourceShas.includes(r.sourceSha))
      );
      return {
        rows,
        truncated: f.releasesTruncated ?? false,
        asOf: new Date(NOW),
      };
    },
    servingLanes: async () => {
      throw new Error("not used");
    },
    probe: async () => {
      throw new Error("not used");
    },
  };
  return { github, store, calls };
}

async function run(
  f: Fakes,
  p: Record<string, unknown>,
  opts: {
    github?: boolean;
    repo?: CandidateRepo | undefined;
  } = {}
): Promise<{ sample: MetricSample; calls: ReturnType<typeof fakes>["calls"] }> {
  const { github, store, calls } = fakes(f);
  const calc = createCandidateBacklogCalculators(store, {
    repoOf: async () => ("repo" in opts ? opts.repo : REPO),
    operatorNodeId: OPERATOR,
    github: opts.github === false ? undefined : github,
    now: () => NOW,
  })[0] as MetricCalculator;
  const controller = new AbortController();
  let reads = 0;
  const ctx: CalculatorContext = {
    window: {
      start: new Date(NOW).toISOString(),
      end: new Date(NOW).toISOString(),
    },
    signal: controller.signal,
    budget: calc.budget,
    async read(fn) {
      if (++reads > calc.budget.maxSourceCalls)
        throw new Error("source_call_budget");
      return fn(controller.signal, calc.budget);
    },
  };
  const sample = await calc.compute(calc.paramsSchema.parse(p), ctx);
  return { sample, calls };
}
const backlog = { nodeId: NODE, output: "backlog" };
const wait = { nodeId: NODE, output: "wait_p90_hours" };

describe("params", () => {
  const calc = createCandidateBacklogCalculators(fakes({}).store, {
    repoOf: async () => REPO,
    operatorNodeId: OPERATOR,
    github: undefined,
  })[0] as MetricCalculator;
  it("id, output units and strictness", () => {
    expect(calc.id).toBe(CANDIDATE_BACKLOG_ID);
    expect(CANDIDATE_BACKLOG_ID).toBe("delivery.candidate-backlog@1");
    expect(calc.unitFor?.(backlog)).toBe("prs");
    expect(calc.unitFor?.(wait)).toBe("h");
    expect(calc.paramsSchema.parse(backlog)).toMatchObject({ days: 28 });
    // the default is applied in code: stored params parse unchanged, so no series identity moves
    expect(calc.paramsSchema.parse(backlog)).not.toHaveProperty("activeDays");
    expect(
      calc.paramsSchema.parse({ ...backlog, activeDays: 14 })
    ).toMatchObject({ activeDays: 14 });
    for (const bad of [
      {},
      { nodeId: NODE },
      { nodeId: "node-template", output: "backlog" },
      { nodeId: NODE, output: "p90" },
      { nodeId: NODE, output: "backlog", days: 0 },
      { nodeId: NODE, output: "backlog", activeDays: 0 },
      { nodeId: NODE, output: "backlog", activeDays: 29 },
      { nodeId: NODE, output: "backlog", activeDays: 1.5 },
      { nodeId: NODE, output: "backlog", env: "production" },
    ])
      expect(() => calc.paramsSchema.parse(bad)).toThrow();
  });
});

describe("helpers", () => {
  it("parseSourceRepo reads a catalog source_repo", () => {
    expect(
      parseSourceRepo("https://github.com/cogni-dao/node-template.git")
    ).toEqual(REPO);
    expect(
      parseSourceRepo("https://github.com/cogni-test-org/spawny-boi")
    ).toEqual({
      owner: "cogni-test-org",
      repo: "spawny-boi",
    });
    for (const bad of [
      undefined,
      5,
      "",
      "git@github.com:a/b.git",
      "https://example.com/a/b",
    ])
      expect(parseSourceRepo(bad)).toBeUndefined();
  });
  it("firstServed: earliest activation per sha; served without an instant is untimed; failed releases do not serve", () => {
    const m = firstServed([
      release("a", { activatedAt: ago(10) }),
      release("a", { activatedStepAt: ago(20) }),
      release("b", { served: true }),
      release("c"), // never served
      release("D".toLowerCase(), { activatedAt: ago(5) }),
    ]);
    expect(m.get(sha("a"))?.getTime()).toBe(ago(20).getTime());
    expect(m.get(sha("b"))).toBeNull();
    expect(m.has(sha("c"))).toBe(false);
    expect(m.has(sha("d"))).toBe(true);
  });
});

describe("backlog", () => {
  it("counts open PRs whose head SHA never served, and names them", async () => {
    const { sample, calls } = await run(
      {
        prs: [pr(1, "a"), pr(2, "b"), pr(3, "c"), pr(4, "d")],
        releases: [
          release("a", { activatedAt: ago(30), served: true }), // served
          release("b", { failedBeforeActivation: true }), // released but never served
          release("c", { served: true }), // served, untimed
        ],
      },
      backlog
    );
    expect(sample).toMatchObject({ value: 2, unit: "prs", complete: true });
    expect(sample.evidenceRefs).toContain("candidate:open_prs=4,unserved=2");
    expect(sample.evidenceRefs).toContain(
      `candidate:unserved=pr2@${"b".repeat(7)}`
    );
    expect(sample.evidenceRefs).toContain(
      `candidate:unserved=pr4@${"d".repeat(7)}`
    );
    // bounded: one PR list, one release read, NO check-suites read for the backlog
    expect(calls).toMatchObject({ list: 1, releases: 1, suites: [] });
  });

  it("looks the open heads up by sha on the node's candidate-a releases, from the epoch (no window)", async () => {
    const { calls } = await run(
      { prs: [pr(1, "a"), pr(2, "b"), pr(3, "a")] },
      backlog
    );
    expect(calls.scopes).toEqual([
      { nodeId: NODE, env: "candidate-a", sourceShas: [sha("a"), sha("b")] },
    ]);
    expect(calls.recordedFrom[0]?.getTime()).toBe(0);
  });

  it("a head that served 35 days ago is NOT backlog, however old the lookback `days` is", async () => {
    const { sample } = await run(
      {
        prs: [pr(1, "a"), pr(2, "b")],
        releases: [
          release("a", {
            createdAt: ago(35 * 24),
            activatedAt: ago(35 * 24 - 1),
            served: true,
          }),
        ],
      },
      { ...backlog, days: 7 }
    );
    expect(sample.value).toBe(1); // only b
    expect(sample.evidenceRefs).toContain(
      `candidate:unserved=pr2@${"b".repeat(7)}`
    );
    expect(sample.evidenceRefs).not.toContain(
      `candidate:unserved=pr1@${"a".repeat(7)}`
    );
  });

  it("no open PRs: no release read at all", async () => {
    const { calls } = await run({ prs: [] }, backlog);
    expect(calls.releases).toBe(0);
  });

  it("a service of a test env or a canary counts as served (any workload)", async () => {
    const { sample } = await run(
      {
        prs: [pr(1, "a"), pr(2, "b")],
        releases: [
          release("a", { workload: "teqwkzmx", activatedAt: ago(1) }),
          release("b", { workload: "canary", activatedAt: ago(2) }),
        ],
      },
      backlog
    );
    expect(sample.value).toBe(0);
    expect(sample.complete).toBe(true); // an empty queue is a reading, not unknown
  });

  it("is 0 and complete when nothing is open", async () => {
    expect((await run({ prs: [] }, backlog)).sample).toMatchObject({
      value: 0,
      complete: true,
    });
  });
});

describe("active PRs only (activeDays)", () => {
  it("backlog: a stale PR is excluded, an active one is included, and evidence names both counts", async () => {
    const { sample, calls } = await run(
      {
        prs: [
          prUpdated(1, "a", 2), // active, unserved
          prUpdated(2, "b", 90), // stale, unserved
          prUpdated(3, "c", 3), // active, served
          prUpdated(4, "d", 8), // stale just outside the 7d default
        ],
        releases: [release("c", { activatedAt: ago(30), served: true })],
      },
      backlog
    );
    expect(sample).toMatchObject({ value: 1, complete: true });
    expect(sample.evidenceRefs).toContain("candidate:open_prs=2,unserved=1");
    expect(sample.evidenceRefs).toContain(
      "candidate:active_days=7,active=2,excluded_stale=2"
    );
    expect(sample.evidenceRefs).toContain(
      `candidate:unserved=pr1@${"a".repeat(7)}`
    );
    expect(sample.evidenceRefs).not.toContain(
      `candidate:unserved=pr2@${"b".repeat(7)}`
    );
    // stale heads are not even looked up
    expect(calls.scopes).toEqual([
      { nodeId: NODE, env: "candidate-a", sourceShas: [sha("a"), sha("c")] },
    ]);
  });

  it("wait: a stale PR adds no sample and no check-suites read; an active one does", async () => {
    const { sample, calls } = await run(
      {
        prs: [prUpdated(1, "a", 2), prUpdated(2, "b", 90)],
        green: { a: 5, b: 3530 },
      },
      wait
    );
    expect(sample).toMatchObject({ value: 5, complete: true });
    expect(calls.suites).toEqual([sha("a")]);
    expect(sample.evidenceRefs).toContain(
      "candidate:active_days=7,active=1,excluded_stale=1"
    );
  });

  it("the window is half-open and `activeDays` widens it", async () => {
    const edge = [
      { ...pr(1, "a"), updatedAt: new Date(NOW - 7 * 24 * HOUR) }, // exactly 7d: in
      { ...pr(2, "b"), updatedAt: new Date(NOW - 7 * 24 * HOUR - 1) }, // just older: out
      { ...pr(3, "c"), updatedAt: new Date(NOW) }, // now: out (end is exclusive)
    ];
    expect((await run({ prs: edge }, backlog)).sample.value).toBe(1);
    const wide = await run({ prs: edge }, { ...backlog, activeDays: 28 });
    expect(wide.sample.value).toBe(2);
    expect(wide.sample.evidenceRefs).toContain(
      "candidate:active_days=28,active=2,excluded_stale=1"
    );
  });

  it("only stale PRs: an empty queue is a reading (0), not unknown, and no release read", async () => {
    const { sample, calls } = await run(
      { prs: [prUpdated(1, "a", 60)] },
      backlog
    );
    expect(sample).toMatchObject({ value: 0, complete: true });
    expect(calls.releases).toBe(0);
  });
});

describe("wait_p90_hours", () => {
  it("an unserved SHA waits until now, so the p90 cannot hide the queue", async () => {
    // 10 PRs, all green; 9 served 1h after green (wait 1h), 1 never served and green 174h ago.
    const prs = "abcdefghij".split("").map((c, i) => pr(i + 1, c));
    const green: Record<string, number> = {};
    const releases: DeliveryReleaseFacts[] = [];
    for (const c of "abcdefghi") {
      green[c] = 10;
      releases.push(release(c, { activatedAt: ago(9), served: true }));
    }
    green.j = 174;
    const { sample, calls } = await run({ prs, green, releases }, wait);
    // sorted waits: nine of 1h and one of 174h; nearest-rank p90 of 10 = the 9th = 1h; the 10th is the max.
    expect(sample.complete).toBe(true);
    expect(sample.unit).toBe("h");
    expect(sample.value).toBe(1);
    expect(calls.suites).toHaveLength(10); // one check-suites read per head
    // add one more stuck PR: now the 90th percentile lands on a stuck one
    const more = await run(
      { prs: [...prs, pr(11, "k")], green: { ...green, k: 100 }, releases },
      wait
    );
    expect(more.sample.value).toBe(100);
  });

  it("a served SHA waits from green to its FIRST activation, never negative", async () => {
    const { sample } = await run(
      {
        prs: [pr(1, "a"), pr(2, "b")],
        green: { a: 10, b: 2 },
        releases: [
          release("a", { activatedAt: ago(4) }), // 6h after green
          release("a", { activatedAt: ago(1) }), // a later re-flight: ignored
          release("b", { activatedAt: ago(5) }), // served before green: 0h
        ],
      },
      wait
    );
    // waits [0, 6]: p90 = 6
    expect(sample.value).toBe(6);
  });

  it("a SHA with no CI green has no sample and is named; with only such SHAs there is no reading", async () => {
    const { sample } = await run({ prs: [pr(1, "a")], green: {} }, wait);
    expect(sample).toMatchObject({
      complete: false,
      reason: "zero_denominator",
    });
    expect(sample.evidenceRefs).toContain(
      "candidate:wait_samples=0,ci_not_green=1,untimed=0,outside_window=0,ci_incomplete=0"
    );
  });

  it("`days` bounds the wait samples only: a head first served longer ago is left out, an unserved one never is", async () => {
    const { sample } = await run(
      {
        prs: [pr(1, "a"), pr(2, "b")],
        green: { a: 35 * 24 + 2, b: 30 },
        releases: [
          release("a", {
            createdAt: ago(35 * 24),
            activatedAt: ago(35 * 24 - 1),
          }),
        ],
      },
      { ...wait, days: 7 }
    );
    expect(sample.value).toBe(30); // b only: unserved, green 30h ago
    expect(sample.evidenceRefs).toContain(
      "candidate:wait_samples=1,ci_not_green=0,untimed=0,outside_window=1,ci_incomplete=0"
    );
    // with a wide enough window the old head is sampled (its wait was 1h)
    const wide = await run(
      {
        prs: [pr(1, "a"), pr(2, "b")],
        green: { a: 35 * 24 + 2, b: 30 },
        releases: [
          release("a", {
            createdAt: ago(35 * 24),
            activatedAt: ago(35 * 24 - 1),
          }),
        ],
      },
      { ...wait, days: 28 }
    );
    expect(wide.sample.evidenceRefs).toContain(
      "candidate:wait_samples=1,ci_not_green=0,untimed=0,outside_window=1,ci_incomplete=0"
    );
  });

  it("a served-untimed SHA is not sampled", async () => {
    const { sample } = await run(
      {
        prs: [pr(1, "a"), pr(2, "b")],
        green: { a: 10, b: 20 },
        releases: [release("a", { served: true }), release("b")],
      },
      wait
    );
    expect(sample.value).toBe(20); // only b (unserved, green 20h ago)
    expect(sample.evidenceRefs).toContain(
      "candidate:wait_samples=1,ci_not_green=0,untimed=1,outside_window=0,ci_incomplete=0"
    );
  });

  it("a head whose suites did not fit makes the reading unavailable", async () => {
    const { sample } = await run(
      { prs: [pr(1, "a")], green: { a: 5 }, incomplete: ["a"] },
      wait
    );
    expect(sample).toMatchObject({
      complete: false,
      reason: "incomplete_or_invalid_source",
    });
  });
});

describe("unknown is a result, never 0", () => {
  it("the operator's own flights are not recorded: unavailable with a reason, and no source is read", async () => {
    const { sample, calls } = await run(
      { prs: [pr(1, "a")] },
      { nodeId: OPERATOR, output: "backlog" }
    );
    expect(sample).toMatchObject({
      complete: false,
      reason: "calculator_unavailable",
    });
    expect(sample.evidenceRefs).toContain(
      "candidate:reason=operator_flights_not_recorded"
    );
    expect(calls).toMatchObject({ list: 0, releases: 0 });
  });
  it("a node with no source_repo", async () => {
    const { sample } = await run({}, backlog, { repo: undefined });
    expect(sample).toMatchObject({
      complete: false,
      reason: "incomplete_or_invalid_source",
    });
    expect(sample.evidenceRefs).toContain("candidate:reason=no_source_repo");
  });
  it("no GitHub App configured", async () => {
    const { sample } = await run({}, backlog, { github: false });
    expect(sample).toMatchObject({
      complete: false,
      reason: "calculator_unavailable",
    });
    expect(sample.evidenceRefs).toContain(
      "candidate:reason=github_app_not_configured"
    );
  });
  it("more open PRs than the budget", async () => {
    const { sample, calls } = await run(
      { prs: [pr(1, "a")], truncated: true },
      backlog
    );
    expect(sample).toMatchObject({
      complete: false,
      reason: "incomplete_or_invalid_source",
    });
    expect(sample.evidenceRefs).toContain(
      `candidate:reason=more_than_${MAX_CANDIDATE_PRS}_open_prs`
    );
    expect(calls.releases).toBe(0);
  });
  it("a truncated release read", async () => {
    const { sample } = await run(
      { prs: [pr(1, "a")], releasesTruncated: true },
      backlog
    );
    expect(sample).toMatchObject({
      complete: false,
      reason: "incomplete_or_invalid_source",
    });
  });
  it("an unreadable GitHub throws, so the engine records source_failed; it is never 0", async () => {
    await expect(run({ githubThrows: true }, backlog)).rejects.toThrow(
      "github unreadable"
    );
  });
});
