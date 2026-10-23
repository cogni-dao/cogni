// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/scripts/vm-health-snapshot`
 * Purpose: Pin the VM health grading and the story.5084 soak objectives to the ONE reliability policy so the agent CLI can never disagree with the operator health route or the Fleet Reliability dashboard.
 * Scope: Pure evaluate/evaluateObjectives/renderObjectives/summarizeConsumers/parseArgs plus the dashboard JSON. Does not call Grafana.
 * Invariants:
 *   - ONE_HEALTH_CONTRACT: every threshold comes from reliability-policy.v1.json; this file holds none.
 *   - MISSING_IS_UNKNOWN: null, stale or ambiguous-host evidence never grades GREEN.
 *   - ENDPOINTS_ARE_NOT_VM: probe failures never change the VM verdict.
 *   - ONE_SOAK_CONTRACT: the dashboard and the CLI grade availability, controller liveness and backups by policy.objectives.
 * Side-effects: none (reads the dashboard JSON)
 * Links: scripts/vm-health-snapshot.mjs, packages/node-contracts/src/reliability-policy.v1.json, infra/grafana/dashboards/operator/fleet-capacity.json, story.5084
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import policy from "../../../packages/node-contracts/src/reliability-policy.v1.json";

type Level = "GREEN" | "YELLOW" | "RED" | "UNKNOWN";
type Sample = { host: string; value: number; tsSec: number | null };
type Input = {
  nowSec: number;
  signals: Record<string, Sample[]>;
  families: Record<string, { host: string; tsSec: number }[]>;
  probes: {
    tsSec: number | null;
    nodes: { slug: string; min: number }[];
  } | null;
};
type Evaluation = {
  verdict: Level;
  host: string | null;
  signals: { key: string; level: Level }[];
  findings: { key: string; level: Level }[];
  next: string[];
  endpoints: { status: string; failing: string[] };
};
const mod = (await import("../../../scripts/vm-health-snapshot.mjs")) as {
  POLICY: typeof policy;
  SIGNAL_SERIES: Record<string, string>;
  FAMILIES: Record<string, unknown>;
  evaluate: (input: unknown) => Evaluation;
  summarizeConsumers: (
    rss: { class: string; service: string; bytes: number }[],
    swap: { class: string; service: string; bytes: number }[],
    used: number | null
  ) => { top: { service: string }[]; outsideRssBytes: number | null };
  parseArgs: (args: string[]) => { json: boolean; envs: string[] };
  OBJECTIVES: typeof policy.objectives;
  OBJECTIVE_LOGS: Record<string, string>;
  evaluateObjectives: (
    input: unknown,
    nowSec: number,
    objectives?: unknown
  ) => Objectives;
  renderObjectives: (o: unknown) => string[];
  guardObjectives: (run: () => unknown) => Promise<{
    level: Level;
    error?: string;
  }>;
  serveProbeBounds: (env: string) => { window: string; ttlSec: number };
  snapshot: (
    creds: unknown,
    env: string,
    nowSec: number,
    deps: { run: Run; objectives?: unknown }
  ) => Promise<{ verdict: Level; objectives: { level: Level } }>;
  render: (s: unknown) => string;
  vmExitCode: (snaps: { verdict: Level }[]) => number;
};
type Run = (
  kind: "prometheus" | "loki",
  expr: string
) => Promise<{ metric: Record<string, string>; value: [number, string] }[]>;
type Endpoint = { name: string; percent: number; level: Level };
type Objectives = {
  level: Level;
  availability: {
    level: Level;
    below: string[];
    endpoints: Endpoint[];
    nodes: { slug: string; percent: number }[];
  };
  controller: {
    level: Level;
    sweeps: number | null;
    lastSweepAgeSec: number | null;
  };
  backups: { level: Level; receipts: number | null; lastAgeSec: number | null };
};
const {
  evaluate,
  evaluateObjectives,
  renderObjectives,
  guardObjectives,
  snapshot,
  render,
  vmExitCode,
  summarizeConsumers,
  parseArgs,
} = mod;

type SignalKey = keyof typeof policy.signals;
const KEYS = Object.keys(policy.signals) as SignalKey[];
const NOW = 1_800_000_000;
const TTL = policy.evidenceTtlMs / 1000;
const HOST = "9e8bb1a5190947e7b7a29f5d1a0d4f71";
const OTHER = "48837aa82fdb4eb0aeb1a74123b0c201";

/** A value strictly on the healthy side of warning, derived from the policy. */
const healthyValue = (k: SignalKey) =>
  policy.signals[k].direction === "above"
    ? policy.signals[k].warning / 2
    : Math.min(100, policy.signals[k].warning * 2);

function input(over: Partial<Record<SignalKey, number>> = {}): Input {
  return {
    nowSec: NOW,
    signals: Object.fromEntries(
      KEYS.map((k) => [
        k,
        [{ host: HOST, value: over[k] ?? healthyValue(k), tsSec: NOW - 30 }],
      ])
    ),
    families: Object.fromEntries(
      Object.keys(mod.FAMILIES).map((f) => [
        f,
        [{ host: HOST, tsSec: NOW - 20 }],
      ])
    ),
    probes: {
      tsSec: NOW - 40,
      nodes: [
        { slug: "operator", min: 1 },
        { slug: "poly", min: 1 },
      ],
    },
  };
}

describe("vm-health policy wiring", () => {
  it("imports the policy JSON rather than copying it", () => {
    expect(mod.POLICY).toEqual(policy);
  });

  it("maps every policy signal to a recorded cogni_reliability_v1 series", () => {
    for (const k of KEYS)
      expect(mod.SIGNAL_SERIES[k]).toMatch(
        /^cogni_reliability_v1_\w+_percent$/
      );
  });
});

describe("vm-health evaluate", () => {
  it("grades fresh, single-host, healthy evidence GREEN", () => {
    const r = evaluate(input());
    expect(r.verdict).toBe("GREEN");
    expect(r.host).toBe(HOST);
    expect(r.next).toEqual(["Nothing to do."]);
  });

  it("grades everything-null UNKNOWN, never GREEN", () => {
    const empty = { nowSec: NOW, signals: {}, families: {}, probes: null };
    const r = evaluate(empty);
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.endpoints.status).toBe("UNKNOWN");
    expect(evaluate(undefined).verdict).toBe("UNKNOWN");
    const nulls = input();
    for (const k of KEYS)
      nulls.signals[k] = [{ host: HOST, value: Number.NaN, tsSec: null }];
    expect(evaluate(nulls).verdict).toBe("UNKNOWN");
  });

  it("grades one missing or stale policy signal UNKNOWN", () => {
    const missing = input();
    missing.signals.diskHeadroomPercent = [];
    expect(evaluate(missing).verdict).toBe("UNKNOWN");
    const stale = input();
    stale.signals.memoryHeadroomPercent = [
      { host: HOST, value: 60, tsSec: NOW - TTL - 1 },
    ];
    expect(evaluate(stale).verdict).toBe("UNKNOWN");
  });

  it("leads with a proven RED even when another signal is UNKNOWN", () => {
    const mixed = input();
    mixed.signals.diskHeadroomPercent = [
      { host: HOST, value: 5, tsSec: NOW - 5 },
    ];
    mixed.signals.connectionsPercent = [];
    const r = evaluate(mixed);
    expect(r.verdict).toBe("RED");
    expect(r.next[0]).toMatch(/^Disk:/);
    expect(r.findings.some((f) => f.level === "UNKNOWN")).toBe(true);
  });

  it("refuses to grade when two substrate hosts report for one env", () => {
    const two = input();
    two.signals.ioPressurePercent?.push({
      host: OTHER,
      value: 1,
      tsSec: NOW - 5,
    });
    const r = evaluate(two);
    expect(r.verdict).toBe("UNKNOWN");
    expect(r.findings.some((f) => f.key === "substrate-host")).toBe(true);
  });

  it("grades at the policy's own warning and critical boundaries", () => {
    for (const k of KEYS) {
      const s = policy.signals[k];
      expect(evaluate(input({ [k]: s.warning })).verdict, k).toBe("YELLOW");
      expect(evaluate(input({ [k]: s.critical })).verdict, k).toBe("RED");
    }
  });

  it("grades the 2026-10-21 pre-resize swap-thrash production RED", () => {
    const r = evaluate(
      input({ memoryHeadroomPercent: 9, ioPressurePercent: 45 })
    );
    expect(r.verdict).toBe("RED");
    expect(r.next.join(" ")).toMatch(/Memory/);
  });

  it("never hides disk behind memory in the next actions", () => {
    const r = evaluate(
      input({
        memoryHeadroomPercent: policy.signals.memoryHeadroomPercent.critical,
        diskHeadroomPercent: policy.signals.diskHeadroomPercent.warning,
      })
    );
    expect(r.next[0]).toMatch(/^Memory/);
    expect(r.next.some((n) => n.startsWith("Disk"))).toBe(true);
  });

  it("keeps a missing diagnostic family from grading GREEN", () => {
    const gap = input();
    gap.families.kubelet_cadvisor = [];
    const r = evaluate(gap);
    expect(r.verdict).toBe("YELLOW");
    expect(r.next.join(" ")).toMatch(/kubelet_cadvisor/);
  });

  it("grades a stale node family UNKNOWN", () => {
    const stale = input();
    stale.families.node = [{ host: HOST, tsSec: NOW - TTL - 1 }];
    expect(evaluate(stale).verdict).toBe("UNKNOWN");
  });

  it("reports probe failures as node endpoints, not as the VM verdict", () => {
    const failing = input();
    failing.probes = {
      tsSec: NOW - 10,
      nodes: [
        { slug: "beacon", min: 0 },
        { slug: "operator", min: 1 },
      ],
    };
    const r = evaluate(failing);
    expect(r.verdict).toBe("GREEN");
    expect(r.endpoints).toMatchObject({
      status: "FAILING",
      failing: ["beacon"],
    });
  });

  it("judges probe freshness by each environment's policy cadence (bug.5527)", () => {
    const prod = mod.serveProbeBounds("production");
    const preview = mod.serveProbeBounds("preview");
    expect(prod).toEqual({
      window: policy.serveProbes.production.evidenceWindow,
      ttlSec: TTL,
    });
    expect(preview.window).toBe(policy.serveProbes.preview.evidenceWindow);
    // A sample one full non-prod interval old is fresh there, stale in production.
    const age = policy.serveProbes.preview.frequencyMs / 1000;
    const probes = { tsSec: NOW - age, nodes: [{ slug: "operator", min: 1 }] };
    expect(
      evaluate({ ...input(), probes: { ...probes, ...preview } }).endpoints
        .status
    ).toBe("OK");
    expect(
      evaluate({ ...input(), probes: { ...probes, ...prod } }).endpoints.status
    ).toBe("UNKNOWN");
    expect(() => mod.serveProbeBounds("staging")).toThrow("serveProbes");
  });
});

const OBJ = policy.objectives;
const TARGET = OBJ.nodeAvailability.targetPercent / 100;

function soak() {
  return {
    availability: {
      nodes: [
        { slug: "operator", ratio: 1 },
        { slug: "poly", ratio: TARGET },
      ],
      byProbe: [
        { slug: "operator", probe: "Ohio", ratio: 1 },
        { slug: "operator", probe: "Frankfurt", ratio: 1 },
        { slug: "poly", probe: "Ohio", ratio: TARGET },
        { slug: "poly", probe: "Frankfurt", ratio: TARGET },
      ],
    },
    controller: {
      sweeps: OBJ.throttleController.minSweeps,
      lastSec: NOW - 30,
      errorLines: 0,
    },
    backups: { receipts: OBJ.backupReceipts.minReceipts, lastSec: NOW - 3600 },
  };
}

/** Fake Grafana: healthy, fresh, single-host VM evidence; Loki empty. */
const healthyGrafana: Run = async (kind, expr) => {
  const row = (metric: Record<string, string>, v: number) => ({
    metric,
    value: [NOW, String(v)] as [number, string],
  });
  if (kind === "loki") return [];
  const series = Object.entries(mod.SIGNAL_SERIES).find(([, m]) =>
    expr.startsWith(`${m}{`)
  );
  if (series)
    return [
      row({ substrate_host: HOST }, healthyValue(series[0] as SignalKey)),
    ];
  if (expr.startsWith("timestamp(cogni_reliability_v1_"))
    return [row({ substrate_host: HOST }, NOW - 30)];
  if (expr.startsWith("max by (substrate_host) (timestamp("))
    return [row({ substrate_host: HOST }, NOW - 20)];
  if (expr.startsWith("max(max_over_time(timestamp(probe_success"))
    return [row({}, NOW - 40)];
  if (expr.startsWith("min by (node_slug)"))
    return [row({ node_slug: "operator" }, 1)];
  return [];
};

describe("vm-health soak objectives (story.5084)", () => {
  it("reads every objective from the policy, and so does the dashboard", () => {
    expect(mod.OBJECTIVES).toEqual(policy.objectives);
    type Panel = {
      id: number;
      title: string;
      gridPos: { y: number };
      targets?: { expr: string }[];
      fieldConfig?: {
        defaults: {
          color?: { mode: string };
          thresholds?: { steps: { color: string; value: number | null }[] };
        };
      };
    };
    const dash = JSON.parse(
      readFileSync(
        new URL(
          "../../../infra/grafana/dashboards/operator/fleet-capacity.json",
          import.meta.url
        ),
        "utf8"
      )
    ) as { panels: Panel[] };
    const steps = (p: Panel) => p.fieldConfig?.defaults.thresholds?.steps ?? [];
    const greenAt = (p: Panel) => steps(p).at(-1)?.value;
    const byExpr = (needle: string) =>
      dash.panels.filter((p) =>
        p.targets?.some((t) => t.expr.includes(needle))
      );
    const window = `avg_over_time(probe_success{environment="$environment",proof_class="serve"}[${OBJ.nodeAvailability.window}])`;
    const endpoint = byExpr(`avg by (node_slug, probe) (${window})`);
    const average = byExpr(`avg by (node_slug) (${window})`);
    const sweeps = byExpr(
      `event="${mod.OBJECTIVE_LOGS.sweepEvent}" [${OBJ.throttleController.window}]`
    );
    const backups = byExpr(
      `event="${mod.OBJECTIVE_LOGS.backupEvent}" [${OBJ.backupReceipts.window}]`
    );
    for (const group of [endpoint, average, sweeps, backups])
      expect(group).toHaveLength(1);
    const [ep, avg, sw, bk] = [endpoint, average, sweeps, backups].map(
      (g) => g[0] as Panel
    );
    // Pass/fail is per endpoint; the per-node average is never colored pass/fail.
    expect(steps(ep)).toEqual([
      { color: "red", value: null },
      { color: "green", value: OBJ.nodeAvailability.targetPercent },
    ]);
    expect(avg.fieldConfig?.defaults.color?.mode).toBe("fixed");
    expect(steps(avg).some((x) => /red|green/.test(x.color))).toBe(false);
    expect(greenAt(sw)).toBe(OBJ.throttleController.minSweeps);
    expect(greenAt(bk)).toBe(OBJ.backupReceipts.minReceipts);
    // The deciding numbers are the dashboard's top row; the graded endpoint panel leads it.
    for (const p of [ep, avg, sw, bk]) expect(p.gridPos.y).toBeLessThan(8);
    expect(dash.panels[0]?.id).toBe(ep.id);
    for (const t of sw.targets ?? [])
      expect(t.expr).toContain(mod.OBJECTIVE_LOGS.throttleController);
    for (const t of bk.targets ?? [])
      expect(t.expr).toContain(mod.OBJECTIVE_LOGS.backup);
  });

  it("grades a clean soak GREEN, exactly at the policy target", () => {
    const o = evaluateObjectives(soak(), NOW);
    expect(o.level).toBe("GREEN");
    expect(o.availability.below).toEqual([]);
    expect(renderObjectives(o)[0]).toMatch(
      /OK 4\/4 endpoints at target \(4 observed\)/
    );
  });

  it("grades per endpoint, so a passing node average cannot hide a failing probe", () => {
    const s = soak();
    // Live 2026-10-22: operator averages 99.931 while its Ohio probe is 99.861.
    s.availability.nodes[0] = { slug: "operator", ratio: 0.99931 };
    s.availability.byProbe[0] = {
      slug: "operator",
      probe: "Ohio",
      ratio: 0.99861,
    };
    s.availability.byProbe[1] = {
      slug: "operator",
      probe: "Frankfurt",
      ratio: 1,
    };
    s.availability.byProbe.push(
      { slug: "red", probe: "Frankfurt", ratio: 0.97222 },
      { slug: "red", probe: "Ohio", ratio: TARGET - 0.00001 }
    );
    const o = evaluateObjectives(s, NOW);
    expect(o.availability.level).toBe("RED");
    expect(o.availability.endpoints.map((e) => e.name)).toEqual([
      "red·Frankfurt",
      "operator·Ohio",
      "red·Ohio",
      "poly·Frankfurt",
      "poly·Ohio",
      "operator·Frankfurt",
    ]);
    expect(o.availability.below).toEqual([
      "red·Frankfurt",
      "operator·Ohio",
      "red·Ohio",
    ]);
    const lines = renderObjectives(o);
    expect(lines[0]).toMatch(/🔴 3\/6 endpoints below target \(6 observed\)/);
    expect(lines[0]).toMatch(/🔴 operator·Ohio 99\.861%/);
    expect(lines[1]).toMatch(
      /node averages 24h \(context, ungraded\): .*operator 99\.931%/
    );
    expect(lines[1]).not.toMatch(/🔴/);
  });

  it("grades a dead throttle controller and missing backups RED with their ages", () => {
    const s = soak();
    s.controller = {
      sweeps: Number.NaN,
      lastSec: NOW - 90_000,
      errorLines: 12,
    };
    s.backups = { receipts: Number.NaN, lastSec: NOW - 141_700 };
    const o = evaluateObjectives(s, NOW);
    expect(o.controller).toMatchObject({
      level: "RED",
      sweeps: 0,
      lastSweepAgeSec: 90_000,
    });
    expect(o.backups).toMatchObject({
      level: "RED",
      receipts: 0,
      lastAgeSec: 141_700,
    });
    const text = renderObjectives(o).join("\n");
    expect(text).toMatch(
      /throttle controller \(not VM\): 🔴 DEAD 0 sweeps in 10m/
    );
    expect(text).toMatch(/last sweep 25\.0h ago · 12 "Error: " lines/);
    expect(text).toMatch(
      /backups \(not VM\): 🔴 0 receipts in 26h \(min 1\) · last 39\.4h ago/
    );
  });

  it("grades failed queries and empty probes UNKNOWN, never GREEN", () => {
    const o = evaluateObjectives(
      {
        availability: { nodes: [], byProbe: [] },
        controller: null,
        backups: null,
      },
      NOW
    );
    expect(o.availability.level).toBe("UNKNOWN");
    expect(o.controller.level).toBe("UNKNOWN");
    expect(o.backups.level).toBe("UNKNOWN");
    expect(evaluateObjectives(undefined, NOW).level).toBe("UNKNOWN");
  });

  it("turns any objectives failure into UNKNOWN instead of rejecting", async () => {
    const g = await guardObjectives(() =>
      evaluateObjectives(soak(), NOW, null)
    );
    expect(g).toMatchObject({
      level: "UNKNOWN",
      error: "policy has no usable objectives",
    });
    expect(renderObjectives(g)).toEqual([
      "   objectives: ⚪ UNKNOWN (policy has no usable objectives)",
    ]);
  });

  it("keeps the VM verdict and exit code when the policy has no or broken objectives", async () => {
    const run = (objectives: unknown) =>
      snapshot({}, "production", NOW, { run: healthyGrafana, objectives });
    const withObjectives = await run(policy.objectives);
    expect(withObjectives.verdict).toBe("GREEN");
    expect(withObjectives.objectives.level).toBe("RED");
    for (const broken of [
      undefined,
      {},
      {
        ...policy.objectives,
        nodeAvailability: {
          ...policy.objectives.nodeAvailability,
          window: "1.5h",
        },
      },
    ]) {
      const snap = await run(broken);
      expect(snap.verdict).toBe(withObjectives.verdict);
      expect(vmExitCode([snap])).toBe(vmExitCode([withObjectives]));
      expect(vmExitCode([snap])).toBe(0);
      expect(snap.objectives.level).toBe("UNKNOWN");
      expect(render(snap)).toMatch(/^🟢 PRODUCTION GREEN/);
      expect(render(snap)).toMatch(/objectives: ⚪ UNKNOWN \(/);
    }
  });
});

describe("vm-health diagnostics", () => {
  it("names consumers by rss+swap and reports memory outside per-service RSS", () => {
    const MiB = 1048576;
    const s = summarizeConsumers(
      [
        { class: "systemd", service: "k3s", bytes: 900 * MiB },
        { class: "compose", service: "litellm", bytes: 20 * MiB },
      ],
      [{ class: "compose", service: "litellm", bytes: 1000 * MiB }],
      1200 * MiB
    );
    expect(s.top.map((t) => t.service)).toEqual([
      "compose/litellm",
      "systemd/k3s",
    ]);
    expect(s.outsideRssBytes).toBe(280 * MiB);
    expect(summarizeConsumers([], [], 1).outsideRssBytes).toBeNull();
  });

  it("rejects unknown envs and flags before any query is built", () => {
    expect(parseArgs([]).envs).toEqual([
      "production",
      "preview",
      "candidate-a",
    ]);
    expect(parseArgs(["preview", "--json"])).toEqual({
      json: true,
      envs: ["preview"],
    });
    expect(() => parseArgs(['prod"}or vector(1)'])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--yaml"])).toThrow(/unknown argument/);
  });
});
