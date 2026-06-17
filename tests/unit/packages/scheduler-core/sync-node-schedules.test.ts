// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/scheduler-core/sync-node-schedules`
 * Purpose: Unit tests for syncNodeSchedules + teardownNodeSchedules — pure orchestration via a fake ScheduleControlPort. Proves REAL cron-drift (the latent bug fix), workflowId stability, foreign-node rejection (M8), prune-as-pause, and teardown revoke.
 * Scope: Pure service tests with in-memory fakes. No real Temporal/DB.
 * Invariants: cron change → update (not skip); workflowId/scheduleId = node-task:{node}:{id}; foreign nodeId throws; teardown pauses + revokes.
 * Side-effects: none
 * Links: packages/scheduler-core/src/services/syncNodeSchedules.ts
 * @public
 */

import type {
  CreateScheduleParams,
  ScheduleControlPort,
  ScheduleDescription,
} from "@cogni/scheduler-core";
import {
  ForeignNodeScheduleError,
  type NodeScheduleEntry,
  type NodeScheduleRowState,
  type NodeScheduleSyncDeps,
  type NodeScheduleTeardownDeps,
  nodeScheduleId,
  syncNodeSchedules,
  teardownNodeSchedules,
} from "@cogni/scheduler-core";
import { describe, expect, it, vi } from "vitest";

const NODE = "00000000-0000-4000-8000-00000000000a";
const OWNER = "11111111-1111-4111-8111-111111111111";

/** In-memory ScheduleControlPort fake with conflict-on-existing semantics. */
class FakeScheduleControl implements ScheduleControlPort {
  store = new Map<string, { params: CreateScheduleParams; paused: boolean }>();
  calls: { op: string; scheduleId: string }[] = [];

  async createSchedule(params: CreateScheduleParams): Promise<void> {
    this.calls.push({ op: "create", scheduleId: params.scheduleId });
    if (this.store.has(params.scheduleId)) {
      const err = new Error(`Schedule already exists: ${params.scheduleId}`);
      err.name = "ScheduleControlConflictError";
      throw err;
    }
    this.store.set(params.scheduleId, { params, paused: false });
  }
  async updateSchedule(
    scheduleId: string,
    params: CreateScheduleParams
  ): Promise<void> {
    this.calls.push({ op: "update", scheduleId });
    const entry = this.store.get(scheduleId);
    if (!entry) {
      const err = new Error(`Schedule not found: ${scheduleId}`);
      err.name = "ScheduleControlNotFoundError";
      throw err;
    }
    entry.params = params;
  }
  async pauseSchedule(scheduleId: string): Promise<void> {
    this.calls.push({ op: "pause", scheduleId });
    const entry = this.store.get(scheduleId);
    if (entry) entry.paused = true;
  }
  async resumeSchedule(scheduleId: string): Promise<void> {
    this.calls.push({ op: "resume", scheduleId });
    const entry = this.store.get(scheduleId);
    if (entry) entry.paused = false;
  }
  async deleteSchedule(scheduleId: string): Promise<void> {
    this.store.delete(scheduleId);
  }
  async describeSchedule(
    scheduleId: string
  ): Promise<ScheduleDescription | null> {
    const entry = this.store.get(scheduleId);
    if (!entry) return null;
    return {
      scheduleId,
      nextRunAtIso: null,
      lastRunAtIso: null,
      isPaused: entry.paused,
      cron: null, // Temporal compiles crons → null (the whole reason cron-drift uses the DB)
      timezone: entry.params.timezone,
      input: entry.params.input,
      dbScheduleId: entry.params.dbScheduleId ?? null,
    };
  }
  async triggerSchedule(): Promise<void> {}
  async listScheduleIds(prefix: string): Promise<string[]> {
    return [...this.store.keys()].filter((k) => k.startsWith(prefix));
  }
}

const noopLog = { info: () => {}, warn: () => {} };

/** Builds deps with a DB-row store that remembers stored cron (the SSOT for drift). */
function makeDeps(control: FakeScheduleControl) {
  const rows = new Map<
    string,
    { dbScheduleId: string; cron: string; timezone: string; input: unknown }
  >();
  let seq = 0;
  const deps: NodeScheduleSyncDeps = {
    nodeId: NODE,
    ownerUserId: OWNER,
    ensureNodeGrant: vi.fn(async (scope: string) => `grant:${scope}`),
    upsertNodeScheduleRow: vi.fn(async (p): Promise<NodeScheduleRowState> => {
      const existing = rows.get(p.temporalScheduleId);
      const dbScheduleId = existing?.dbScheduleId ?? `db-${++seq}`;
      const prior: NodeScheduleRowState = existing
        ? {
            dbScheduleId,
            priorCron: existing.cron,
            priorTimezone: existing.timezone,
            priorInput: existing.input as never,
            existed: true,
          }
        : {
            dbScheduleId,
            priorCron: null,
            priorTimezone: null,
            priorInput: null,
            existed: false,
          };
      rows.set(p.temporalScheduleId, {
        dbScheduleId,
        cron: p.cron,
        timezone: p.timezone,
        input: p.input,
      });
      return prior;
    }),
    scheduleControl: control,
    listNodeScheduleIds: () => control.listScheduleIds(`node-task:${NODE}:`),
    disableScheduleRow: vi.fn(async () => {}),
    log: noopLog,
  };
  return { deps, rows };
}

const httpEntry: NodeScheduleEntry = {
  id: "metrics-ingest",
  nodeId: NODE,
  cron: "*/15 * * * *",
  timezone: "UTC",
  kind: "http-dispatch",
  route: "/api/internal/ops/metrics-ingest",
  payload: { window: "15m" },
};

describe("syncNodeSchedules — create", () => {
  it("creates a new schedule with stable workflowId node-task:{node}:{id}", async () => {
    const control = new FakeScheduleControl();
    const { deps } = makeDeps(control);
    const result = await syncNodeSchedules([httpEntry], deps);

    const expectedId = nodeScheduleId(NODE, "metrics-ingest");
    expect(expectedId).toBe(`node-task:${NODE}:metrics-ingest`);
    expect(result.created).toEqual([expectedId]);

    const stored = control.store.get(expectedId);
    expect(stored?.params.scheduleId).toBe(expectedId);
    // platform invariants are operator-fixed
    expect(stored?.params.overlapPolicy).toBe("skip");
    expect(stored?.params.catchupWindowMs).toBe(0);
    // http-dispatch → NodeTaskWorkflow
    expect(stored?.params.workflowType).toBe("NodeTaskWorkflow");
  });

  it("routes a graph schedule to GraphRunWorkflow (workflowType omitted)", async () => {
    const control = new FakeScheduleControl();
    const { deps } = makeDeps(control);
    const graphEntry: NodeScheduleEntry = {
      id: "nightly",
      nodeId: NODE,
      cron: "0 0 * * *",
      timezone: "UTC",
      kind: "graph",
      graph: "sandbox:openclaw",
      payload: { x: 1 },
    };
    await syncNodeSchedules([graphEntry], deps);
    const stored = control.store.get(nodeScheduleId(NODE, "nightly"));
    expect(stored?.params.workflowType).toBeUndefined();
    expect(stored?.params.graphId).toBe("sandbox:openclaw");
  });
});

describe("syncNodeSchedules — REAL cron drift (latent-bug fix)", () => {
  it("UPDATES when only the cron string changes (not skip)", async () => {
    const control = new FakeScheduleControl();
    const { deps } = makeDeps(control);

    // First sync: create.
    await syncNodeSchedules([httpEntry], deps);

    // Second sync: SAME everything except cron.
    const changed: NodeScheduleEntry = { ...httpEntry, cron: "*/30 * * * *" };
    const result = await syncNodeSchedules([changed], deps);

    const id = nodeScheduleId(NODE, "metrics-ingest");
    expect(result.updated).toEqual([id]);
    expect(result.skipped).toEqual([]);
    expect(control.store.get(id)?.params.cron).toBe("*/30 * * * *");
  });

  it("SKIPS when nothing changed (idempotent re-sync)", async () => {
    const control = new FakeScheduleControl();
    const { deps } = makeDeps(control);
    await syncNodeSchedules([httpEntry], deps);
    const result = await syncNodeSchedules([httpEntry], deps);
    const id = nodeScheduleId(NODE, "metrics-ingest");
    expect(result.skipped).toEqual([id]);
    expect(result.updated).toEqual([]);
  });

  it("RESUMES a paused schedule with no config change", async () => {
    const control = new FakeScheduleControl();
    const { deps } = makeDeps(control);
    await syncNodeSchedules([httpEntry], deps);
    const id = nodeScheduleId(NODE, "metrics-ingest");
    await control.pauseSchedule(id);
    const result = await syncNodeSchedules([httpEntry], deps);
    expect(result.resumed).toEqual([id]);
  });
});

describe("syncNodeSchedules — prune", () => {
  it("pauses a schedule removed from the spec (reversible)", async () => {
    const control = new FakeScheduleControl();
    const { deps } = makeDeps(control);
    const second: NodeScheduleEntry = {
      ...httpEntry,
      id: "other",
      route: "/api/other",
    };
    await syncNodeSchedules([httpEntry, second], deps);

    // Remove `other` from the spec.
    const result = await syncNodeSchedules([httpEntry], deps);
    const removedId = nodeScheduleId(NODE, "other");
    expect(result.paused).toEqual([removedId]);
    expect(control.store.get(removedId)?.paused).toBe(true);
    expect(deps.disableScheduleRow).toHaveBeenCalledWith(removedId);
  });
});

describe("syncNodeSchedules — M8 foreign-node rejection", () => {
  it("throws ForeignNodeScheduleError when an entry declares a foreign nodeId", async () => {
    const control = new FakeScheduleControl();
    const { deps } = makeDeps(control);
    const foreign: NodeScheduleEntry = {
      ...httpEntry,
      nodeId: "99999999-9999-4999-8999-999999999999",
    };
    await expect(syncNodeSchedules([foreign], deps)).rejects.toBeInstanceOf(
      ForeignNodeScheduleError
    );
  });
});

describe("teardownNodeSchedules — M7", () => {
  it("pauses every node schedule AND revokes grants", async () => {
    const control = new FakeScheduleControl();
    const { deps } = makeDeps(control);
    const second: NodeScheduleEntry = {
      ...httpEntry,
      id: "other",
      route: "/api/other",
    };
    await syncNodeSchedules([httpEntry, second], deps);

    const teardownDeps: NodeScheduleTeardownDeps = {
      nodeId: NODE,
      scheduleControl: control,
      listNodeScheduleIds: () => control.listScheduleIds(`node-task:${NODE}:`),
      disableScheduleRow: vi.fn(async () => {}),
      revokeNodeGrants: vi.fn(async () => ["grant-1", "grant-2"]),
      log: noopLog,
    };

    const result = await teardownNodeSchedules(teardownDeps);
    expect(result.pausedSchedules).toHaveLength(2);
    expect(result.revokedGrants).toEqual(["grant-1", "grant-2"]);
    expect(
      control.store.get(nodeScheduleId(NODE, "metrics-ingest"))?.paused
    ).toBe(true);
    expect(control.store.get(nodeScheduleId(NODE, "other"))?.paused).toBe(true);
    expect(teardownDeps.revokeNodeGrants).toHaveBeenCalledTimes(1);
  });
});
