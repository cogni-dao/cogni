// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/repo-spec/governance-schedules`
 * Purpose: Governance schedule `graph:` / `model:` / `policy:` support (task.5282) and LEDGER_INGEST preservation.
 * Scope: Does not touch Temporal; schema, accessor mapping, and the REAL operator runtime repo-spec file.
 * Invariants:
 *   - GRAPH_REQUIRES_MODEL: `graph` without `model` is rejected at parse time
 *   - BACK_COMPAT_SHAPE: an entry without graph/model maps to the exact pre-task.5282 object
 *   - LEDGER_PRESERVED: the operator runtime repo-spec still synthesizes exactly one LEDGER_INGEST (cron 0 0 * * *)
 *   - OPERATOR_PRIORITIZER (story.5096): the operator declares WORK_PRIORITIZER on langgraph:work-prioritizer, propose-only
 * Side-effects: IO (reads the operator repo-spec file from disk)
 * Links: packages/repo-spec/src/schema.ts, packages/repo-spec/src/accessors.ts
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  extractGovernanceConfig,
  extractWorkPrioritizationPolicy,
  governanceScheduleSchema,
  parseRepoSpec,
  parseRepoSpec as parseSpec,
} from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const OPERATOR_REPO_SPEC = path.resolve(
  __dirname,
  "../../../../nodes/operator/.cogni/repo-spec.yaml"
);

const BASE_ENTRY = {
  charter: "WORK_PRIORITIZER",
  cron: "*/5 * * * *",
  timezone: "UTC",
  entrypoint: "PRIORITIZE",
};

describe("governanceScheduleSchema graph/model", () => {
  it("accepts a namespaced graph with a model", () => {
    const parsed = governanceScheduleSchema.parse({
      ...BASE_ENTRY,
      graph: "langgraph:work-prioritizer",
      model: "gpt-oss-120b",
    });
    expect(parsed.graph).toBe("langgraph:work-prioritizer");
    expect(parsed.model).toBe("gpt-oss-120b");
  });

  it("rejects graph without model", () => {
    const result = governanceScheduleSchema.safeParse({
      ...BASE_ENTRY,
      graph: "langgraph:work-prioritizer",
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("model");
  });

  it("rejects a non-namespaced graph id", () => {
    const result = governanceScheduleSchema.safeParse({
      ...BASE_ENTRY,
      graph: "work-prioritizer",
      model: "gpt-oss-120b",
    });
    expect(result.success).toBe(false);
  });

  it("still accepts the legacy shape (no graph, no model)", () => {
    expect(governanceScheduleSchema.parse(BASE_ENTRY)).toEqual(BASE_ENTRY);
  });
});

describe("work_prioritization policy schema", () => {
  const base = {
    node_id: "00000000-0000-4000-8000-000000000001",
    governance: { chain_id: "8453" },
  };
  const wp = {
    policy_version: "v5.0",
    apply: { mode: { default: "propose", "candidate-a": "write" } },
  };

  it("parses with per-env modes; goals and caps are not policy (dao-goals-design)", () => {
    const policy = extractWorkPrioritizationPolicy(
      parseSpec({ ...base, work_prioritization: wp })
    );
    expect(policy?.applyModes).toEqual({
      default: "propose",
      "candidate-a": "write",
    });
    expect(policy).toEqual({
      policyVersion: "v5.0",
      applyMode: "propose",
      applyModes: { default: "propose", "candidate-a": "write" },
    });
  });

  it("rejects an unknown mode and a missing default", () => {
    expect(() =>
      parseSpec({
        ...base,
        work_prioritization: { ...wp, apply: { mode: { default: "yolo" } } },
      })
    ).toThrow();
    expect(() =>
      parseSpec({
        ...base,
        work_prioritization: { ...wp, apply: { mode: { prod: "propose" } } },
      })
    ).toThrow();
  });

  it("a schedule policy ref requires graph, and the block must exist", () => {
    expect(
      governanceScheduleSchema.safeParse({
        ...BASE_ENTRY,
        policy: "work_prioritization",
      }).success
    ).toBe(false);
    expect(() =>
      extractGovernanceConfig(
        parseSpec({
          ...base,
          governance: {
            chain_id: "8453",
            schedules: [
              {
                ...BASE_ENTRY,
                graph: "langgraph:work-prioritizer",
                model: "m",
                policy: "work_prioritization",
              },
            ],
          },
        })
      )
    ).toThrow("work_prioritization");
  });

  it("returns null when the node declares no policy", () => {
    expect(extractWorkPrioritizationPolicy(parseSpec(base))).toBeNull();
  });
});

describe("operator runtime repo-spec governance (nodes/operator/.cogni)", () => {
  const spec = parseRepoSpec(
    parseYaml(readFileSync(OPERATOR_REPO_SPEC, "utf8"))
  );
  const config = extractGovernanceConfig(spec);

  it("declares WORK_PRIORITIZER on langgraph:work-prioritizer hourly (prod-safe), propose-only", () => {
    expect(
      config.schedules.find((s) => s.charter === "WORK_PRIORITIZER")
    ).toEqual({
      charter: "WORK_PRIORITIZER",
      cron: "0 * * * *",
      timezone: "UTC",
      entrypoint: "PRIORITIZE",
      graph: "langgraph:work-prioritizer",
      model: "gpt-oss-120b",
      payload: {
        workPrioritization: {
          policyVersion: "v5.0",
          applyMode: "propose",
          applyModes: { default: "propose" },
        },
      },
    });
    expect(extractWorkPrioritizationPolicy(spec)).toMatchObject({
      policyVersion: "v5.0",
      applyMode: "propose",
    });
  });

  it("declares only the two expected charters", () => {
    expect(config.schedules.map((s) => s.charter).sort()).toEqual([
      "LEDGER_INGEST",
      "WORK_PRIORITIZER",
    ]);
  });

  it("LEDGER_PRESERVED: still synthesizes exactly one LEDGER_INGEST with the pre-existing shape", () => {
    const ledger = config.schedules.filter(
      (s) => s.charter.toUpperCase() === "LEDGER_INGEST"
    );
    // Byte-for-byte the schedule extractGovernanceConfig synthesized before
    // `governance.schedules` existed in this file: no graph/model keys.
    expect(ledger).toEqual([
      {
        charter: "LEDGER_INGEST",
        cron: "0 0 * * *",
        timezone: "UTC",
        entrypoint: "LEDGER_INGEST",
      },
    ]);
    expect(config.ledger).toBeDefined();
  });
});
