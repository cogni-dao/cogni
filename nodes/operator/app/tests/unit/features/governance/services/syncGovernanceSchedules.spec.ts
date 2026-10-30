// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/governance/services/syncGovernanceSchedules`
 * Purpose: Unit tests for governance schedule sync logic (multi-node, story.5001).
 * Scope: Tests sync function with mocked ScheduleControlPort; verifies node-scoped schedule ids,
 *   create/update/resume/skip/prune behavior, the NON-operator LEDGER_INGEST → NodeTaskWorkflow(/collect)
 *   dispatch swap (route + payload + node-task grant scope), AND the OPERATOR LEDGER_INGEST staying on
 *   the flat `governance:ledger_ingest` CollectEpochWorkflow schedule (story.5001 REGRESSION_BAR).
 *   Does not test Temporal integration or DB.
 * Invariants: Prune pauses (never deletes); conflict = update or skip or resume; idempotent on repeat;
 *   NON-operator LEDGER_INGEST dispatches NodeTaskWorkflow; OPERATOR LEDGER_INGEST stays on
 *   CollectEpochWorkflow + flat id + `ledger-tasks` queue (OPERATOR_STAYS_ON_COLLECT_EPOCH).
 * Side-effects: none (all deps mocked)
 * Links: packages/scheduler-core/src/services/syncGovernanceSchedules.ts
 * @public
 */

import {
  nodeTaskScope,
  ScheduleControlConflictError,
  ScheduleControlNotFoundError,
  type ScheduleDescription,
} from "@cogni/scheduler-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type GovernanceScheduleSyncDeps,
  governanceScheduleId,
  isLegacyGovernanceScheduleId,
  legacyGovernanceScheduleId,
  syncGovernanceSchedules,
} from "@/features/governance/services/syncGovernanceSchedules";
import type { GovernanceConfig } from "@/shared/config";

const GRANT_ID = "test-grant-id-001";
const COLLECT_GRANT_ID = "test-collect-grant-id-001";
const SYSTEM_USER_ID = "00000000-0000-4000-a000-000000000001";
const MOCK_DB_SCHEDULE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NODE_ID = "node-abc-123";
const COLLECT_ROUTE = "/api/internal/attribution/collect";

/** Counter-based mock to return unique dbScheduleIds per call */
let upsertCallCount = 0;

function makeMockDeps(
  overrides?: Partial<GovernanceScheduleSyncDeps>
): GovernanceScheduleSyncDeps {
  upsertCallCount = 0;
  return {
    ensureGovernanceGrant: vi.fn().mockResolvedValue(GRANT_ID),
    ensureNodeCollectGrant: vi.fn().mockResolvedValue(COLLECT_GRANT_ID),
    upsertGovernanceScheduleRow: vi.fn().mockImplementation(() => {
      upsertCallCount++;
      return Promise.resolve(`${MOCK_DB_SCHEDULE_ID}-${upsertCallCount}`);
    }),
    systemUserId: SYSTEM_USER_ID,
    nodeId: NODE_ID,
    scheduleControl: {
      createSchedule: vi.fn().mockResolvedValue(undefined),
      updateSchedule: vi.fn().mockResolvedValue(undefined),
      pauseSchedule: vi.fn().mockResolvedValue(undefined),
      resumeSchedule: vi.fn().mockResolvedValue(undefined),
      deleteSchedule: vi.fn().mockResolvedValue(undefined),
      describeSchedule: vi.fn().mockResolvedValue(null),
      listScheduleIds: vi.fn().mockResolvedValue([]),
    },
    listGovernanceScheduleIds: vi.fn().mockResolvedValue([]),
    disableSchedule: vi.fn().mockResolvedValue(undefined),
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

/** A minimal ledger config — required for the OPERATOR CollectEpochWorkflow path. */
const LEDGER: NonNullable<GovernanceConfig["ledger"]> = {
  scopeId: "scope-uuid-001",
  scopeKey: "default",
  epochLengthDays: 7,
  activitySources: {
    github: {
      attributionPipeline: "cogni-v0.0",
      sourceRefs: ["cogni-dao/cogni"],
    },
  },
  poolConfig: { baseIssuanceCredits: 10000n },
  baseIssuanceCredits: "10000",
  approvers: ["0x070075F1389Ae1182aBac722B36CA12285d0c949"],
};

function makeConfig(
  charters: Array<{
    charter: string;
    cron: string;
    entrypoint: string;
    timezone?: string;
  }>,
  opts?: { ledger?: GovernanceConfig["ledger"] }
): GovernanceConfig {
  return {
    schedules: charters.map((c) => ({
      charter: c.charter,
      cron: c.cron,
      timezone: c.timezone ?? "UTC",
      entrypoint: c.entrypoint,
    })),
    ...(opts?.ledger ? { ledger: opts.ledger } : {}),
  };
}

/** Node-scoped schedule id for the mock's NODE_ID (`governance:{nodeId}:{charter}`). */
function sid(charter: string): string {
  return governanceScheduleId(NODE_ID, charter);
}

/** Helper: build a ScheduleDescription matching the desired config (no drift) */
function makeMatchingDesc(
  scheduleId: string,
  cron: string,
  entrypoint: string,
  opts?: { isPaused?: boolean; timezone?: string; dbScheduleId?: string | null }
): ScheduleDescription {
  return {
    scheduleId,
    nextRunAtIso: "2026-02-15T06:00:00Z",
    lastRunAtIso: null,
    isPaused: opts?.isPaused ?? false,
    cron,
    timezone: opts?.timezone ?? "UTC",
    input: { message: entrypoint, model: "kimi-k2.5" },
    dbScheduleId:
      "dbScheduleId" in (opts ?? {})
        ? (opts?.dbScheduleId ?? null)
        : `${MOCK_DB_SCHEDULE_ID}-1`,
  };
}

/** Helper: build a ScheduleDescription with stale config (drift) */
function makeDriftedDesc(
  scheduleId: string,
  cron: string,
  entrypoint: string,
  opts?: { isPaused?: boolean; dbScheduleId?: string | null }
): ScheduleDescription {
  return {
    scheduleId,
    nextRunAtIso: "2026-02-15T06:00:00Z",
    lastRunAtIso: null,
    isPaused: opts?.isPaused ?? false,
    cron,
    timezone: "UTC",
    // Stale: missing model field (the bug we're fixing)
    input: { message: entrypoint },
    dbScheduleId:
      "dbScheduleId" in (opts ?? {})
        ? (opts?.dbScheduleId ?? null)
        : `${MOCK_DB_SCHEDULE_ID}-1`,
  };
}

describe("syncGovernanceSchedules", () => {
  let deps: GovernanceScheduleSyncDeps;

  beforeEach(() => {
    deps = makeMockDeps();
  });

  it("creates node-scoped schedules for each charter in config", async () => {
    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
      { charter: "GOVERN", cron: "0 * * * *", entrypoint: "GOVERN" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    // MULTI_NODE_SCHEDULE_ID: ids carry the nodeId segment.
    expect(result.created).toEqual([sid("COMMUNITY"), sid("GOVERN")]);
    expect(result.created).toEqual([
      "governance:node-abc-123:community",
      "governance:node-abc-123:govern",
    ]);
    // Upsert called for each schedule before Temporal creation
    expect(deps.upsertGovernanceScheduleRow).toHaveBeenCalledTimes(2);
    expect(deps.upsertGovernanceScheduleRow).toHaveBeenCalledWith(
      expect.objectContaining({
        temporalScheduleId: sid("COMMUNITY"),
        ownerUserId: SYSTEM_USER_ID,
        graphId: "sandbox:openclaw",
      })
    );
    expect(deps.scheduleControl.createSchedule).toHaveBeenCalledTimes(2);
    expect(deps.scheduleControl.createSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: sid("COMMUNITY"),
        nodeId: NODE_ID,
        dbScheduleId: `${MOCK_DB_SCHEDULE_ID}-1`,
        cron: "0 */6 * * *",
        timezone: "UTC",
        graphId: "sandbox:openclaw",
        executionGrantId: GRANT_ID,
        input: { message: "COMMUNITY", model: "kimi-k2.5" },
        overlapPolicy: "skip",
        catchupWindowMs: 0,
      })
    );
    // Governance-agent charters do NOT dispatch — no collect grant, no NodeTaskWorkflow.
    expect(deps.ensureNodeCollectGrant).not.toHaveBeenCalled();
  });

  it("ensures governance grant before creating schedules", async () => {
    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    await syncGovernanceSchedules(config, deps);

    expect(deps.ensureGovernanceGrant).toHaveBeenCalledOnce();
  });

  // ---------------------------------------------------------------------------
  // NON-operator LEDGER_INGEST → NodeTaskWorkflow(/collect) dispatch swap (story.5001).
  // Default deps have no `isOperatorNode` (⇒ false), i.e. a routable NON-operator node.
  // ---------------------------------------------------------------------------
  describe("LEDGER_INGEST dispatch — non-operator node (story.5001)", () => {
    it("targets NodeTaskWorkflow with the /collect route + { nodeId } payload", async () => {
      const config = makeConfig([
        {
          charter: "LEDGER_INGEST",
          cron: "0 0 * * *",
          entrypoint: "LEDGER_INGEST",
        },
      ]);

      const result = await syncGovernanceSchedules(config, deps);

      expect(result.created).toEqual([sid("LEDGER_INGEST")]);
      expect(deps.scheduleControl.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduleId: sid("LEDGER_INGEST"),
          nodeId: NODE_ID,
          // Swap: NodeTaskWorkflow, NOT CollectEpochWorkflow.
          workflowType: "NodeTaskWorkflow",
          // `task:{route}` graphId tunnel drives the adapter's route fallback.
          graphId: `task:${COLLECT_ROUTE}`,
          executionGrantId: COLLECT_GRANT_ID,
          // The adapter reads input.route + input.payload → NodeTaskInput { nodeId, route, payload }.
          input: {
            route: COLLECT_ROUTE,
            payload: { nodeId: NODE_ID },
          },
          overlapPolicy: "skip",
          catchupWindowMs: 0,
        })
      );
    });

    it("does NOT target CollectEpochWorkflow or the ledger task queue", async () => {
      const config = makeConfig([
        {
          charter: "LEDGER_INGEST",
          cron: "0 0 * * *",
          entrypoint: "LEDGER_INGEST",
        },
      ]);

      await syncGovernanceSchedules(config, deps);

      const call = vi
        .mocked(deps.scheduleControl.createSchedule)
        .mock.calls.find(([p]) => p.scheduleId === sid("LEDGER_INGEST"));
      expect(call).toBeDefined();
      const params = call?.[0];
      expect(params?.workflowType).not.toBe("CollectEpochWorkflow");
      // No ledger task-queue override — the shared operator worker + its default queue run it.
      expect(params?.taskQueueOverride).toBeUndefined();
    });

    it("mints the node-bound task:dispatch grant scope for the /collect route", async () => {
      const config = makeConfig([
        {
          charter: "LEDGER_INGEST",
          cron: "0 0 * * *",
          entrypoint: "LEDGER_INGEST",
        },
      ]);

      await syncGovernanceSchedules(config, deps);

      const expectedScope = nodeTaskScope(NODE_ID, COLLECT_ROUTE);
      expect(expectedScope).toBe(`task:dispatch:${NODE_ID}:${COLLECT_ROUTE}`);
      expect(deps.ensureNodeCollectGrant).toHaveBeenCalledWith(expectedScope);
    });
  });

  // ---------------------------------------------------------------------------
  // OPERATOR LEDGER_INGEST stays on the live single-tenant CollectEpochWorkflow schedule.
  // OPERATOR_STAYS_ON_COLLECT_EPOCH (story.5001 REGRESSION_BAR): with isOperatorNode=true,
  // the operator's ledger is NOT rewired onto NodeTaskWorkflow(/collect) — no dead 404,
  // no latent double-collect, no dependency on the operator `/collect` route PR.
  // ---------------------------------------------------------------------------
  describe("LEDGER_INGEST — operator node stays on CollectEpochWorkflow (story.5001)", () => {
    beforeEach(() => {
      deps = makeMockDeps({ isOperatorNode: true });
    });

    it("uses the FLAT `governance:ledger_ingest` id running CollectEpochWorkflow on the PER-NODE ledger queue (bug.5023)", async () => {
      const config = makeConfig(
        [
          {
            charter: "LEDGER_INGEST",
            cron: "0 0 * * *",
            entrypoint: "LEDGER_INGEST",
          },
        ],
        { ledger: LEDGER }
      );

      const result = await syncGovernanceSchedules(config, deps);

      // FLAT id — byte-for-byte the operator's live schedule, NOT node-scoped.
      expect(result.created).toEqual(["governance:ledger_ingest"]);
      expect(result.created).not.toContain(sid("LEDGER_INGEST"));
      expect(deps.scheduleControl.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduleId: "governance:ledger_ingest",
          nodeId: NODE_ID,
          workflowType: "CollectEpochWorkflow",
          // bug.5023: the operator's CollectEpoch runs on its OWN per-node ledger queue
          // (the shared `ledger-tasks` queue is purged); the schedule id stays flat.
          taskQueueOverride: `ledger-tasks-${NODE_ID}`,
          graphId: "ledger:ingest",
          executionGrantId: GRANT_ID,
          // LedgerIngestRunV1 envelope — NOT the { route, payload } dispatch shape.
          input: {
            version: 1,
            scopeId: LEDGER.scopeId,
            scopeKey: LEDGER.scopeKey,
            epochLengthDays: LEDGER.epochLengthDays,
            activitySources: LEDGER.activitySources,
            baseIssuanceCredits: LEDGER.baseIssuanceCredits,
            approvers: LEDGER.approvers,
          },
          overlapPolicy: "skip",
          catchupWindowMs: 0,
        })
      );
    });

    it("MIGRATES an already-deployed CollectEpoch schedule from the shared `ledger-tasks` queue to the per-node queue (bug.5023 queue drift)", async () => {
      // The deployed operator schedule sits on the OLD shared `ledger-tasks` queue with
      // otherwise-matching config. The per-node queue migration MUST be detected as drift
      // and updated — else the schedule keeps firing on a queue no worker polls after the
      // ledger worker moves to `ledger-tasks-<nodeId>` (silent CollectEpoch outage).
      const legacyQueueDesc: ScheduleDescription = {
        scheduleId: "governance:ledger_ingest",
        nextRunAtIso: "2026-02-15T06:00:00Z",
        lastRunAtIso: null,
        isPaused: false,
        cron: "0 0 * * *",
        timezone: "UTC",
        input: {
          version: 1,
          scopeId: LEDGER.scopeId,
          scopeKey: LEDGER.scopeKey,
          epochLengthDays: LEDGER.epochLengthDays,
          activitySources: LEDGER.activitySources,
          baseIssuanceCredits: LEDGER.baseIssuanceCredits,
          approvers: LEDGER.approvers,
        },
        dbScheduleId: null,
        taskQueue: "ledger-tasks", // OLD shared queue — the drift to detect
      };
      deps.scheduleControl.createSchedule = vi
        .fn()
        .mockRejectedValue(
          new ScheduleControlConflictError("governance:ledger_ingest")
        );
      deps.scheduleControl.describeSchedule = vi
        .fn()
        .mockResolvedValue(legacyQueueDesc);

      const config = makeConfig(
        [
          {
            charter: "LEDGER_INGEST",
            cron: "0 0 * * *",
            entrypoint: "LEDGER_INGEST",
          },
        ],
        { ledger: LEDGER }
      );

      const result = await syncGovernanceSchedules(config, deps);

      expect(result.updated).toEqual(["governance:ledger_ingest"]);
      expect(deps.scheduleControl.updateSchedule).toHaveBeenCalledWith(
        "governance:ledger_ingest",
        expect.objectContaining({
          taskQueueOverride: `ledger-tasks-${NODE_ID}`,
        })
      );
    });

    it("does NOT dispatch NodeTaskWorkflow(/collect) — no node-collect grant, no /collect route", async () => {
      const config = makeConfig(
        [
          {
            charter: "LEDGER_INGEST",
            cron: "0 0 * * *",
            entrypoint: "LEDGER_INGEST",
          },
        ],
        { ledger: LEDGER }
      );

      await syncGovernanceSchedules(config, deps);

      // The dispatch swap is other-nodes-only: the operator mints NO task:dispatch grant.
      expect(deps.ensureNodeCollectGrant).not.toHaveBeenCalled();
      const call = vi
        .mocked(deps.scheduleControl.createSchedule)
        .mock.calls.find(([p]) => p.scheduleId === "governance:ledger_ingest");
      const params = call?.[0];
      expect(params?.workflowType).not.toBe("NodeTaskWorkflow");
      // No `/collect` route leaks into the operator's payload.
      expect(JSON.stringify(params?.input)).not.toContain(COLLECT_ROUTE);
    });
  });

  it("skips when schedule exists, is running, and config matches", async () => {
    const matchingDesc = makeMatchingDesc(
      sid("COMMUNITY"),
      "0 */6 * * *",
      "COMMUNITY"
    );

    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(new ScheduleControlConflictError(sid("COMMUNITY")));
    deps.scheduleControl.describeSchedule = vi
      .fn()
      .mockResolvedValue(matchingDesc);

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.skipped).toEqual([sid("COMMUNITY")]);
    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(deps.scheduleControl.updateSchedule).not.toHaveBeenCalled();
    expect(deps.scheduleControl.resumeSchedule).not.toHaveBeenCalled();
  });

  it("updates schedule when config has changed (model drift)", async () => {
    const driftedDesc = makeDriftedDesc(
      sid("COMMUNITY"),
      "0 */6 * * *",
      "COMMUNITY"
    );

    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(new ScheduleControlConflictError(sid("COMMUNITY")));
    deps.scheduleControl.describeSchedule = vi
      .fn()
      .mockResolvedValue(driftedDesc);

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.updated).toEqual([sid("COMMUNITY")]);
    expect(result.skipped).toEqual([]);
    expect(deps.scheduleControl.updateSchedule).toHaveBeenCalledWith(
      sid("COMMUNITY"),
      expect.objectContaining({
        input: { message: "COMMUNITY", model: "kimi-k2.5" },
      })
    );
    // Running schedule — should not be resumed
    expect(deps.scheduleControl.resumeSchedule).not.toHaveBeenCalled();
  });

  it("updates schedule when dbScheduleId link drift detected", async () => {
    // Temporal schedule has dbScheduleId: null (legacy), DB row returns a UUID
    const descWithNullLink = makeMatchingDesc(
      sid("COMMUNITY"),
      "0 */6 * * *",
      "COMMUNITY",
      { dbScheduleId: null }
    );

    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(new ScheduleControlConflictError(sid("COMMUNITY")));
    deps.scheduleControl.describeSchedule = vi
      .fn()
      .mockResolvedValue(descWithNullLink);

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.updated).toEqual([sid("COMMUNITY")]);
    expect(deps.scheduleControl.updateSchedule).toHaveBeenCalledWith(
      sid("COMMUNITY"),
      expect.objectContaining({
        dbScheduleId: `${MOCK_DB_SCHEDULE_ID}-1`,
      })
    );
  });

  it("updates and resumes a paused schedule with changed config", async () => {
    const driftedPaused = makeDriftedDesc(
      sid("COMMUNITY"),
      "0 */6 * * *",
      "COMMUNITY",
      { isPaused: true }
    );

    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(new ScheduleControlConflictError(sid("COMMUNITY")));
    deps.scheduleControl.describeSchedule = vi
      .fn()
      .mockResolvedValue(driftedPaused);

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.updated).toEqual([sid("COMMUNITY")]);
    expect(deps.scheduleControl.updateSchedule).toHaveBeenCalledOnce();
    expect(deps.scheduleControl.resumeSchedule).toHaveBeenCalledWith(
      sid("COMMUNITY")
    );
  });

  it("resumes paused schedule when config matches", async () => {
    const pausedDesc = makeMatchingDesc(
      sid("COMMUNITY"),
      "0 */6 * * *",
      "COMMUNITY",
      { isPaused: true }
    );

    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(new ScheduleControlConflictError(sid("COMMUNITY")));
    deps.scheduleControl.describeSchedule = vi
      .fn()
      .mockResolvedValue(pausedDesc);

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.resumed).toEqual([sid("COMMUNITY")]);
    expect(deps.scheduleControl.resumeSchedule).toHaveBeenCalledWith(
      sid("COMMUNITY")
    );
    expect(deps.scheduleControl.updateSchedule).not.toHaveBeenCalled();
  });

  it("pauses stale governance schedules not in config", async () => {
    deps = makeMockDeps({
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue([sid("COMMUNITY"), sid("OLD-CHARTER")]),
    });

    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.paused).toEqual([sid("OLD-CHARTER")]);
    expect(deps.scheduleControl.pauseSchedule).toHaveBeenCalledWith(
      sid("OLD-CHARTER")
    );
  });

  it("handles externally deleted schedules during prune gracefully", async () => {
    deps = makeMockDeps({
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue([sid("DELETED-CHARTER")]),
    });
    deps.scheduleControl.pauseSchedule = vi
      .fn()
      .mockRejectedValue(
        new ScheduleControlNotFoundError(sid("DELETED-CHARTER"))
      );

    const config = makeConfig([]);

    const result = await syncGovernanceSchedules(config, deps);

    // Should not throw, and should not list as paused
    expect(result.paused).toEqual([]);
  });

  it("is idempotent: no-op on repeat call with same config", async () => {
    // Use a stable dbScheduleId for both calls
    const stableDbId = "stable-db-id-for-idempotency";
    deps.upsertGovernanceScheduleRow = vi.fn().mockResolvedValue(stableDbId);

    // First call: all schedules created
    const config = makeConfig([
      { charter: "COMMUNITY", cron: "0 */6 * * *", entrypoint: "COMMUNITY" },
    ]);

    const result1 = await syncGovernanceSchedules(config, deps);
    expect(result1.created).toEqual([sid("COMMUNITY")]);

    // Second call: schedule exists now with matching config + same dbScheduleId
    deps.scheduleControl.createSchedule = vi
      .fn()
      .mockRejectedValue(new ScheduleControlConflictError(sid("COMMUNITY")));
    deps.scheduleControl.describeSchedule = vi.fn().mockResolvedValue(
      makeMatchingDesc(sid("COMMUNITY"), "0 */6 * * *", "COMMUNITY", {
        dbScheduleId: stableDbId,
      })
    );

    const result2 = await syncGovernanceSchedules(config, deps);
    expect(result2.skipped).toEqual([sid("COMMUNITY")]);
    expect(result2.created).toEqual([]);
    expect(result2.updated).toEqual([]);
  });

  it("returns empty result for config with no schedules", async () => {
    const config = makeConfig([]);

    const result = await syncGovernanceSchedules(config, deps);

    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.resumed).toEqual([]);
    expect(result.paused).toEqual([]);
  });
});

describe("GRAPH_CHARTER — governance schedule `graph:` (task.5282)", () => {
  const GRAPH_GRANT_ID = "test-graph-grant-id-001";
  const PRIORITIZER = {
    charter: "WORK_PRIORITIZER",
    cron: "*/30 * * * *",
    timezone: "UTC",
    entrypoint: "PRIORITIZE",
    graph: "langgraph:work-prioritizer",
    model: "gpt-oss-120b",
  };
  const operatorCreated = (deps: GovernanceScheduleSyncDeps) =>
    vi
      .mocked(deps.scheduleControl.createSchedule)
      .mock.calls.map(([params]) => params);

  it("runs the declared langgraph graph via GraphRunWorkflow with a messages + platform modelRef input", async () => {
    const deps = makeMockDeps({
      isOperatorNode: true,
      ensureGraphGrant: vi.fn().mockResolvedValue(GRAPH_GRANT_ID),
    });

    const result = await syncGovernanceSchedules(
      { schedules: [PRIORITIZER] },
      deps
    );

    expect(result.created).toEqual(["governance:work_prioritizer"]);
    const [params] = operatorCreated(deps);
    expect(params).toMatchObject({
      scheduleId: "governance:work_prioritizer",
      graphId: "langgraph:work-prioritizer",
      executionGrantId: GRAPH_GRANT_ID,
      cron: "*/30 * * * *",
      timezone: "UTC",
      input: {
        messages: [{ role: "user", content: "PRIORITIZE" }],
        modelRef: { providerKey: "platform", modelId: "gpt-oss-120b" },
      },
    });
    // undefined workflowType ⇒ adapter default GraphRunWorkflow; default queue.
    expect(params?.workflowType).toBeUndefined();
    expect(params?.taskQueueOverride).toBeUndefined();
    expect(deps.ensureGraphGrant).toHaveBeenCalledWith(
      "langgraph:work-prioritizer"
    );
    expect(deps.upsertGovernanceScheduleRow).toHaveBeenCalledWith(
      expect.objectContaining({
        graphId: "langgraph:work-prioritizer",
        executionGrantId: GRAPH_GRANT_ID,
      })
    );
  });

  it("appends a trusted policy payload to the graph message as a fenced json block", async () => {
    const deps = makeMockDeps({
      isOperatorNode: true,
      ensureGraphGrant: vi.fn().mockResolvedValue(GRAPH_GRANT_ID),
    });
    const payload = { workPrioritization: { policyVersion: "v5.0" } };
    await syncGovernanceSchedules(
      { schedules: [{ ...PRIORITIZER, payload }] },
      deps
    );
    const [params] = operatorCreated(deps);
    expect(params?.input).toEqual({
      messages: [
        {
          role: "user",
          content: `PRIORITIZE\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
        },
      ],
      modelRef: { providerKey: "platform", modelId: "gpt-oss-120b" },
    });
  });

  it("GRAPH_CRON_DRIFT: a cron change (*/15 → */5) on a graph charter updates the Temporal schedule", async () => {
    const existing = (nextRunAtIso: string): ScheduleDescription => ({
      scheduleId: "governance:work_prioritizer",
      nextRunAtIso,
      lastRunAtIso: null,
      isPaused: false,
      cron: null, // Temporal never returns the cron
      timezone: "UTC",
      input: {
        messages: [{ role: "user", content: "PRIORITIZE" }],
        modelRef: { providerKey: "platform", modelId: PRIORITIZER.model },
      },
      dbScheduleId: `${MOCK_DB_SCHEDULE_ID}-1`,
    });
    const make = (nextCronRun: string) => {
      const deps = makeMockDeps({
        isOperatorNode: true,
        ensureGraphGrant: vi.fn().mockResolvedValue(GRAPH_GRANT_ID),
        nextCronRun: vi.fn().mockReturnValue(nextCronRun),
      });
      deps.scheduleControl.createSchedule = vi
        .fn()
        .mockRejectedValue(
          new ScheduleControlConflictError("governance:work_prioritizer")
        );
      // The live schedule still fires on the old */15 calendar.
      deps.scheduleControl.describeSchedule = vi
        .fn()
        .mockResolvedValue(existing("2026-10-21T03:00:00.000Z"));
      return deps;
    };

    const changed = make("2026-10-21T02:55:00.000Z"); // */5 fires sooner
    const r1 = await syncGovernanceSchedules(
      { schedules: [{ ...PRIORITIZER, cron: "*/5 * * * *" }] },
      changed
    );
    expect(r1.updated).toEqual(["governance:work_prioritizer"]);
    expect(changed.scheduleControl.updateSchedule).toHaveBeenCalledWith(
      "governance:work_prioritizer",
      expect.objectContaining({ cron: "*/5 * * * *" })
    );

    const same = make("2026-10-21T03:00:00.000Z"); // cron unchanged → same next fire
    const r2 = await syncGovernanceSchedules(
      { schedules: [{ ...PRIORITIZER, cron: "*/15 * * * *" }] },
      same
    );
    expect(r2.skipped).toEqual(["governance:work_prioritizer"]);
    expect(same.scheduleControl.updateSchedule).not.toHaveBeenCalled();
  });

  it("keeps a charter WITHOUT graph on sandbox:openclaw byte-for-byte (governance grant, message+model input)", async () => {
    const deps = makeMockDeps({
      ensureGraphGrant: vi.fn().mockResolvedValue(GRAPH_GRANT_ID),
    });

    await syncGovernanceSchedules(
      makeConfig([
        { charter: "HEARTBEAT", cron: "0 * * * *", entrypoint: "HEARTBEAT" },
      ]),
      deps
    );

    const [params] = operatorCreated(deps);
    expect(params?.graphId).toBe("sandbox:openclaw");
    expect(params?.executionGrantId).toBe(GRANT_ID);
    expect(params?.input).toEqual({ message: "HEARTBEAT", model: "kimi-k2.5" });
    expect(params?.workflowType).toBeUndefined();
    expect(deps.ensureGraphGrant).not.toHaveBeenCalled();
  });

  it("LEDGER_PRESERVED: adding a graph charter leaves the operator CollectEpoch ledger schedule exactly as before", async () => {
    const ledgerOnly = makeMockDeps({ isOperatorNode: true });
    await syncGovernanceSchedules(
      makeConfig(
        [
          {
            charter: "LEDGER_INGEST",
            cron: "0 0 * * *",
            entrypoint: "LEDGER_INGEST",
          },
        ],
        { ledger: LEDGER }
      ),
      ledgerOnly
    );
    const [ledgerBefore] = operatorCreated(ledgerOnly);

    const withPrioritizer = makeMockDeps({
      isOperatorNode: true,
      ensureGraphGrant: vi.fn().mockResolvedValue(GRAPH_GRANT_ID),
    });
    const result = await syncGovernanceSchedules(
      {
        schedules: [
          PRIORITIZER,
          {
            charter: "LEDGER_INGEST",
            cron: "0 0 * * *",
            timezone: "UTC",
            entrypoint: "LEDGER_INGEST",
          },
        ],
        ledger: LEDGER,
      },
      withPrioritizer
    );
    const ledgerAfter = operatorCreated(withPrioritizer).find(
      (p) => p.scheduleId === "governance:ledger_ingest"
    );

    expect(result.created).toEqual([
      "governance:work_prioritizer",
      "governance:ledger_ingest",
    ]);
    expect(ledgerAfter).toBeDefined();
    // Same schedule id, workflow, queue, grant, input — only the per-call dbScheduleId differs.
    const strip = (p: typeof ledgerAfter) => ({ ...p, dbScheduleId: "x" });
    expect(strip(ledgerAfter)).toEqual(strip(ledgerBefore));
    expect(ledgerAfter?.workflowType).toBe("CollectEpochWorkflow");
    expect(ledgerAfter?.executionGrantId).toBe(GRANT_ID);
    expect(result.paused).toEqual([]);
  });

  it("ignores `graph` on LEDGER_INGEST (always the epoch-collect workflow)", async () => {
    const deps = makeMockDeps({
      isOperatorNode: true,
      ensureGraphGrant: vi.fn().mockResolvedValue(GRAPH_GRANT_ID),
    });
    await syncGovernanceSchedules(
      {
        schedules: [
          {
            charter: "LEDGER_INGEST",
            cron: "0 0 * * *",
            timezone: "UTC",
            entrypoint: "LEDGER_INGEST",
            graph: "langgraph:work-prioritizer",
            model: "gpt-oss-120b",
          },
        ],
        ledger: LEDGER,
      },
      deps
    );
    const [params] = operatorCreated(deps);
    expect(params?.workflowType).toBe("CollectEpochWorkflow");
    expect(params?.graphId).toBe("ledger:ingest");
    expect(deps.ensureGraphGrant).not.toHaveBeenCalled();
  });

  it("skips (and lets prune pause) a graph charter when no graph grant dep is wired", async () => {
    const deps = makeMockDeps({
      isOperatorNode: true,
      listGovernanceScheduleIds: vi
        .fn()
        .mockResolvedValue(["governance:work_prioritizer"]),
    });

    const result = await syncGovernanceSchedules(
      { schedules: [PRIORITIZER] },
      deps
    );

    expect(deps.scheduleControl.createSchedule).not.toHaveBeenCalled();
    expect(result.skipped).toEqual(["governance:work_prioritizer"]);
    expect(result.paused).toEqual(["governance:work_prioritizer"]);
  });
});

describe("governanceScheduleId", () => {
  it("is node-scoped and lowercases the charter name", () => {
    expect(governanceScheduleId("node-x", "COMMUNITY")).toBe(
      "governance:node-x:community"
    );
    expect(governanceScheduleId("node-x", "ENGINEERING")).toBe(
      "governance:node-x:engineering"
    );
    expect(governanceScheduleId("node-y", "LEDGER_INGEST")).toBe(
      "governance:node-y:ledger_ingest"
    );
  });

  it("gives distinct ids to two nodes' same charter (no clobber)", () => {
    // MULTI_NODE_SCHEDULE_ID: this is the whole point — two nodes' LEDGER_INGEST
    // must NOT collapse onto one Temporal schedule id.
    expect(governanceScheduleId("node-a", "LEDGER_INGEST")).not.toBe(
      governanceScheduleId("node-b", "LEDGER_INGEST")
    );
  });
});

describe("legacyGovernanceScheduleId", () => {
  it("is the FLAT operator form (`governance:{charter}`, no nodeId)", () => {
    // OPERATOR_STAYS_ON_COLLECT_EPOCH: the operator's live ledger schedule id.
    expect(legacyGovernanceScheduleId("LEDGER_INGEST")).toBe(
      "governance:ledger_ingest"
    );
    expect(legacyGovernanceScheduleId("COMMUNITY")).toBe(
      "governance:community"
    );
    // Distinct from the node-scoped form used by every other routable node.
    expect(legacyGovernanceScheduleId("LEDGER_INGEST")).not.toBe(
      governanceScheduleId("node-x", "LEDGER_INGEST")
    );
  });
});

describe("isLegacyGovernanceScheduleId", () => {
  it("classifies the flat operator id as legacy (2 segments), node-scoped as not", () => {
    // The operator's live single-tenant epoch runs on this flat id (classified legacy);
    // with isOperatorNode=true the operator syncs it in place (OPERATOR_STAYS_ON_COLLECT_EPOCH).
    expect(isLegacyGovernanceScheduleId("governance:ledger_ingest")).toBe(true);
    expect(
      isLegacyGovernanceScheduleId("governance:node-abc-123:ledger_ingest")
    ).toBe(false);
    expect(isLegacyGovernanceScheduleId("node-task:x:y")).toBe(false);
  });
});
