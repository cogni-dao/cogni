// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/repo-spec/node-schedules`
 * Purpose: Unit tests for the node-facing `schedules` block and extractNodeSchedules() — route XOR graph inference, platform-invariant rejection, and M8 foreign-node pinning.
 * Scope: Pure schema + accessor tests; does not perform I/O or exercise a runtime.
 * Invariants: A repo-spec cannot produce a foreign-nodeId schedule (M8); overlap/catchupWindow are not node-facing; exactly one of route/graph per entry.
 * Side-effects: none
 * Links: packages/repo-spec/src/schema.ts (nodeScheduleSchema), packages/repo-spec/src/accessors.ts (extractNodeSchedules)
 * @public
 */

import {
  extractNodeSchedules,
  nodeScheduleSchema,
  nodeSchedulesSchema,
  parseRepoSpec,
} from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";

const NODE_A = "00000000-0000-4000-8000-00000000000a";
const NODE_B = "00000000-0000-4000-8000-00000000000b";

function specWithSchedules(nodeId: string, schedules: unknown[]) {
  return {
    node_id: nodeId,
    cogni_dao: { chain_id: "8453" },
    schedules,
  };
}

describe("nodeScheduleSchema — route XOR graph", () => {
  it("accepts an http-dispatch schedule with a relative route", () => {
    const parsed = nodeScheduleSchema.parse({
      id: "metrics-ingest",
      cron: "*/15 * * * *",
      route: "/api/internal/ops/growth/metrics-ingest",
      payload: { window: "15m" },
    });
    expect(parsed.route).toBe("/api/internal/ops/growth/metrics-ingest");
    expect(parsed.timezone).toBe("UTC"); // default
  });

  it("accepts a graph schedule with a graph id", () => {
    const parsed = nodeScheduleSchema.parse({
      id: "nightly-report",
      cron: "0 0 * * *",
      graph: "sandbox:openclaw",
      payload: {},
    });
    expect(parsed.graph).toBe("sandbox:openclaw");
  });

  it("rejects an entry with BOTH route and graph", () => {
    expect(() =>
      nodeScheduleSchema.parse({
        id: "both",
        cron: "0 0 * * *",
        route: "/api/x",
        graph: "g",
      })
    ).toThrow(/Exactly one of/);
  });

  it("rejects an entry with NEITHER route nor graph", () => {
    expect(() =>
      nodeScheduleSchema.parse({ id: "neither", cron: "0 0 * * *" })
    ).toThrow(/Exactly one of/);
  });

  it("rejects an absolute/foreign URL in route (SSRF / cross-tenant)", () => {
    expect(() =>
      nodeScheduleSchema.parse({
        id: "ssrf",
        cron: "0 0 * * *",
        route: "https://evil.example.com/steal",
      })
    ).toThrow();
  });

  it("rejects a non-leading-slash route", () => {
    expect(() =>
      nodeScheduleSchema.parse({
        id: "rel",
        cron: "0 0 * * *",
        route: "api/internal/x",
      })
    ).toThrow();
  });

  it("rejects a malformed (non-5-field) cron", () => {
    expect(() =>
      nodeScheduleSchema.parse({ id: "x", cron: "* * *", route: "/x" })
    ).toThrow(/5-field/);
  });
});

describe("nodeScheduleSchema — platform invariants are NOT node-facing", () => {
  it("rejects an entry that tries to set overlap (operator-fixed)", () => {
    expect(() =>
      nodeScheduleSchema.parse({
        id: "x",
        cron: "0 0 * * *",
        route: "/x",
        overlap: "allow_all",
      })
    ).toThrow(); // .strict() — unknown key
  });

  it("rejects an entry that tries to set catchupWindow (operator-fixed)", () => {
    expect(() =>
      nodeScheduleSchema.parse({
        id: "x",
        cron: "0 0 * * *",
        route: "/x",
        catchupWindow: "5m",
      })
    ).toThrow(); // .strict() — unknown key
  });
});

describe("nodeSchedulesSchema — duplicate ids", () => {
  it("rejects duplicate schedule ids", () => {
    expect(() =>
      nodeSchedulesSchema.parse([
        { id: "dup", cron: "0 0 * * *", route: "/a" },
        { id: "dup", cron: "0 1 * * *", route: "/b" },
      ])
    ).toThrow(/Duplicate schedule ids/);
  });
});

describe("extractNodeSchedules — M8 node pinning", () => {
  it("pins every schedule's nodeId to the repo-spec's OWN node_id", () => {
    const spec = parseRepoSpec(
      specWithSchedules(NODE_A, [
        { id: "s1", cron: "*/15 * * * *", route: "/api/x", payload: { a: 1 } },
        { id: "s2", cron: "0 0 * * *", graph: "g1" },
      ])
    );
    const resolved = extractNodeSchedules(spec);
    expect(resolved).toHaveLength(2);
    expect(resolved.every((s) => s.nodeId === NODE_A)).toBe(true);
  });

  it("infers kind from route XOR graph (no target enum)", () => {
    const spec = parseRepoSpec(
      specWithSchedules(NODE_A, [
        { id: "http", cron: "*/15 * * * *", route: "/api/x" },
        { id: "graph", cron: "0 0 * * *", graph: "g1" },
      ])
    );
    const resolved = extractNodeSchedules(spec);
    const byId = Object.fromEntries(resolved.map((s) => [s.id, s]));
    expect(byId.http.kind).toBe("http-dispatch");
    expect(byId.http.route).toBe("/api/x");
    expect(byId.graph.kind).toBe("graph");
    expect(byId.graph.graph).toBe("g1");
  });

  it("a repo-spec CANNOT produce a foreign-nodeId schedule (M8)", () => {
    // Even if a malicious authoring attempt smuggles a `nodeId`/`node_id` field
    // into a schedule entry, .strict() drops it at parse time, and the accessor
    // pins nodeId to spec.node_id regardless. The resolved nodeId is ALWAYS the
    // declaring node — never NODE_B.
    const spec = parseRepoSpec(
      specWithSchedules(NODE_A, [
        { id: "s1", cron: "0 0 * * *", route: "/api/x", payload: {} },
      ])
    );
    const resolved = extractNodeSchedules(spec);
    expect(resolved[0]?.nodeId).toBe(NODE_A);
    expect(resolved[0]?.nodeId).not.toBe(NODE_B);
  });

  it("rejects at parse time any schedule entry carrying a free-text node id", () => {
    // .strict() forbids unknown keys, so a forged `nodeId`/`node_id` on the entry
    // is a hard parse failure — it can never reach the accessor.
    expect(() =>
      parseRepoSpec(
        specWithSchedules(NODE_A, [
          { id: "forge", cron: "0 0 * * *", route: "/x", nodeId: NODE_B },
        ])
      )
    ).toThrow();
  });

  it("defaults to empty schedules when absent", () => {
    const spec = parseRepoSpec({
      node_id: NODE_A,
      cogni_dao: { chain_id: "8453" },
    });
    expect(extractNodeSchedules(spec)).toEqual([]);
  });
});
