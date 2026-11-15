// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/stop-plan.test`
 * Purpose: The pure stop decision and the consumer lookup behind `DELETE /deploy/workloads` (task.5491).
 * Side-effects: none
 */

import { describe, expect, it } from "vitest";
import type { AttemptPhase } from "@/ports";
import { consumersOf } from "./bindings";
import { planStop } from "./stop-plan";

const at = (phase: AttemptPhase, externalName?: string) => ({
  phase,
  externalName,
});

describe("planStop", () => {
  it("stops an app with no confirmation, whatever its attempts", () => {
    expect(
      planStop({ kind: "app", attempts: [at("active", "1")], consumers: [] })
    ).toEqual({ ok: true });
    expect(
      planStop({ kind: "app", attempts: [at("planned")], consumers: [] })
    ).toEqual({ ok: true });
  });

  it("refuses the destroy flag on an app", () => {
    expect(
      planStop({
        kind: "app",
        attempts: [at("active", "1")],
        consumers: [],
        destroyRetainedData: true,
        dseq: "1",
      })
    ).toEqual({ ok: false, refusal: "workload_not_retained" });
  });

  it("stops a state workload with no open lease without a destroy", () => {
    expect(
      planStop({
        kind: "state",
        attempts: [at("failed"), at("retired", "1"), at("lost", "2")],
        consumers: [],
      })
    ).toEqual({ ok: true });
    expect(planStop({ kind: "state", attempts: [], consumers: [] })).toEqual({
      ok: true,
    });
  });

  it("refuses a destroy when there is no open lease to match", () => {
    expect(
      planStop({
        kind: "state",
        attempts: [at("retired", "1")],
        consumers: [],
        destroyRetainedData: true,
        dseq: "1",
      })
    ).toEqual({ ok: false, refusal: "dseq_mismatch" });
  });

  it("refuses a plain stop of a state workload with an open lease", () => {
    for (const phase of [
      "created",
      "proving",
      "proven",
      "active",
      "retiring",
      "closing",
    ] as const)
      expect(
        planStop({ kind: "state", attempts: [at(phase, "1")], consumers: [] })
      ).toEqual({ ok: false, refusal: "retained_state_requires_destroy" });
  });

  it("waits while a state create has no lease id", () => {
    expect(
      planStop({
        kind: "state",
        attempts: [at("planned"), at("failed", "3")],
        consumers: [],
        destroyRetainedData: true,
        dseq: "3",
      })
    ).toEqual({ ok: false, refusal: "state_create_in_flight" });
  });

  it("accepts a destroy for the dseq of any open phase", () => {
    for (const phase of [
      "created",
      "proving",
      "proven",
      "active",
      "retiring",
      "closing",
    ] as const)
      expect(
        planStop({
          kind: "state",
          attempts: [at(phase, "7"), at("retired", "6")],
          consumers: [],
          destroyRetainedData: true,
          dseq: "7",
        })
      ).toEqual({ ok: true, destroyDseq: "7" });
  });

  it("refuses a destroy for a dseq that is not an open lease, even if it was one before", () => {
    expect(
      planStop({
        kind: "state",
        attempts: [at("active", "7"), at("retired", "6")],
        consumers: [],
        destroyRetainedData: true,
        dseq: "6",
      })
    ).toEqual({ ok: false, refusal: "dseq_mismatch" });
  });

  it("refuses a destroy while a running workload binds the state", () => {
    expect(
      planStop({
        kind: "state",
        attempts: [at("active", "7")],
        consumers: ["canary"],
        destroyRetainedData: true,
        dseq: "7",
      })
    ).toEqual({ ok: false, refusal: "state_in_use" });
  });
});

describe("consumersOf", () => {
  const app = (
    workload: string,
    state: "running" | "stopped",
    ...binds: string[]
  ) => ({ workload, state, bindings: binds.map((b) => ({ workload: b })) });

  it("lists only running workloads that bind the state", () => {
    expect(
      consumersOf("db", [
        app("web", "running", "db"),
        app("worker", "running", "other"),
        app("old", "stopped", "db"),
        app("both", "running", "other", "db"),
      ])
    ).toEqual(["web", "both"]);
  });

  it("never counts the state itself", () => {
    expect(consumersOf("db", [app("db", "running", "db")])).toEqual([]);
  });
});
