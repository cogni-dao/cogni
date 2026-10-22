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
  evaluateObjectives: (input: unknown, nowSec: number) => Objectives;
  renderObjectives: (o: Objectives) => string[];
};
type Objectives = {
  level: Level;
  availability: {
    level: Level;
    below: string[];
    nodes: {
      slug: string;
      percent: number;
      level: Level;
      probes: { probe: string }[];
    }[];
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

describe("vm-health soak objectives (story.5084)", () => {
  it("reads every objective from the policy, and so does the dashboard", () => {
    expect(mod.OBJECTIVES).toEqual(policy.objectives);
    type Panel = {
      id: number;
      gridPos: { y: number };
      targets?: { expr: string }[];
      fieldConfig?: {
        defaults: { thresholds?: { steps: { value: number | null }[] } };
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
    const greenAt = (p: Panel) =>
      p.fieldConfig?.defaults.thresholds?.steps.at(-1)?.value;
    const byExpr = (needle: string) =>
      dash.panels.filter((p) =>
        p.targets?.some((t) => t.expr.includes(needle))
      );
    const av = byExpr(
      `avg_over_time(probe_success{environment="$environment",proof_class="serve"}[${OBJ.nodeAvailability.window}])`
    );
    const sweeps = byExpr(
      `event="${mod.OBJECTIVE_LOGS.sweepEvent}" [${OBJ.throttleController.window}]`
    );
    const backups = byExpr(
      `event="${mod.OBJECTIVE_LOGS.backupEvent}" [${OBJ.backupReceipts.window}]`
    );
    expect(av).toHaveLength(2);
    expect(sweeps).toHaveLength(1);
    expect(backups).toHaveLength(1);
    for (const p of av)
      expect(greenAt(p)).toBe(OBJ.nodeAvailability.targetPercent);
    expect(greenAt(sweeps[0] as Panel)).toBe(OBJ.throttleController.minSweeps);
    expect(greenAt(backups[0] as Panel)).toBe(OBJ.backupReceipts.minReceipts);
    // The deciding numbers are the dashboard's top row.
    for (const p of [...av, ...sweeps, ...backups])
      expect(p.gridPos.y).toBeLessThan(8);
    for (const p of [...sweeps, ...backups])
      for (const t of p.targets ?? [])
        expect(t.expr).toContain(
          p === sweeps[0]
            ? mod.OBJECTIVE_LOGS.throttleController
            : mod.OBJECTIVE_LOGS.backup
        );
  });

  it("grades a clean soak GREEN, exactly at the policy target", () => {
    const o = evaluateObjectives(soak(), NOW);
    expect(o.level).toBe("GREEN");
    expect(o.availability.below).toEqual([]);
  });

  it("flags nodes below target and lists availability worst first", () => {
    const s = soak();
    s.availability.nodes.push(
      { slug: "red", ratio: 0.985 },
      { slug: "beacon", ratio: TARGET - 0.00001 }
    );
    const o = evaluateObjectives(s, NOW);
    expect(o.availability.level).toBe("RED");
    expect(o.availability.nodes.map((n) => n.slug)).toEqual([
      "red",
      "beacon",
      "poly",
      "operator",
    ]);
    expect(o.availability.below).toEqual(["red", "beacon"]);
    expect(o.availability.nodes[2]?.probes).toHaveLength(2);
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

  it("never changes the VM verdict", () => {
    expect(evaluate({ ...input(), objectives: { level: "RED" } }).verdict).toBe(
      "GREEN"
    );
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
